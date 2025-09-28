'use strict';
const { Plugin, Notice, normalizePath, moment, Setting, TFile, PluginSettingTab } = require('obsidian');

const DEFAULT_SETTINGS = {
    // --- General Settings ---
    apiUrl: 'https://pebble.savinpokharel.workers.dev',
    apiKey: '',

    // --- Automation ---
    autoRunOnStartup: false,
    autoRunInterval: 0, // In minutes, 0 disables

    // --- Atomic Notes ---
    atomicNotesEnabled: true,
    atomicNotesFolder: 'Pebble',
    atomicNotesTags: 'idea,thought',
    atomicNotesTemplate:
        `---
created: {{fullDateTime}}
tags: [pebble, {{tags}}]
---

{{content}}`,
    overwriteExisting: false,

    // --- Daily Note Integration ---
    linkBackToDailyNote: true,
    sectionHeading: '## Pebble Imports',
    useDailyNotesCore: true,
    dailyFolder: '', // Fallback
    dailyFileNameFormat: 'YYYY-MM-DD', // Fallback
};

class PebbleSyncPlugin extends Plugin {
    constructor() {
        super(...arguments);
        this.intervalId = null;
    }

    async onload() {
        await this.loadSettings();

        this.addRibbonIcon('sync', 'Pebble Sync: Import new notes', () => this.importNow(false));

        this.addCommand({ id: 'pebble-sync-import-now', name: 'Pebble Sync: Import new notes', callback: () => this.importNow(false) });
        this.addCommand({ id: 'pebble-sync-force-import', name: 'Pebble Sync: Force re-import (overwrite existing)', callback: () => this.importNow(true) });

        this.addSettingTab(new PebbleSyncSettingTab(this.app, this));

        this.setupAutoRun();
        if (this.settings.autoRunOnStartup) {
            // Delay startup import slightly to allow Obsidian to fully load
            setTimeout(() => this.importNow(false), 2000);
        }
    }

    onunload() {
        if (this.intervalId) {
            window.clearInterval(this.intervalId);
        }
    }

    setupAutoRun() {
        if (this.intervalId) {
            window.clearInterval(this.intervalId);
        }
        if (this.settings.autoRunInterval > 0) {
            const intervalMillis = this.settings.autoRunInterval * 60 * 1000;
            this.intervalId = window.setInterval(() => this.importNow(false), intervalMillis);
            this.registerInterval(this.intervalId);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    getDailyConfig() {
        const s = this.settings;
        if (s.useDailyNotesCore && this.app.internalPlugins?.plugins['daily-notes']?.enabled) {
            try {
                const coreConfig = this.app.internalPlugins.getPluginById('daily-notes')?.instance?.options;
                return {
                    folder: coreConfig?.folder?.trim() || '',
                    format: coreConfig?.format || 'YYYY-MM-DD',
                    template: coreConfig?.template?.trim() || ''
                };
            } catch (e) { console.error("Pebble Sync: Error reading Daily Notes core config", e); }
        }
        return {
            folder: s.dailyFolder || '',
            format: s.dailyFileNameFormat,
            template: '' // Standalone mode doesn't support templates
        };
    }

    async processTemplate(template, data) {
        const tagString = (data.tags || []).filter(t => t).join(', ');
        return template
            .replace(/{{content}}/gi, data.content || '')
            .replace(/{{date}}/gi, data.date || '')
            .replace(/{{time}}/gi, data.time || '')
            .replace(/{{fullDateTime}}/gi, data.fullDateTime || '')
            .replace(/{{tags}}/gi, tagString);
    }

    async importNow(force = false) {
        const s = this.settings;
        if (!s.apiUrl) {
            new Notice('Pebble Sync: API URL is required.');
            return;
        }
        if (!s.apiKey) {
            new Notice('Pebble Sync: API key is required.');
            return;
        }
        if (!s.atomicNotesEnabled) {
            new Notice('Pebble Sync: Atomic notes creation is disabled.');
            return;
        }

        let syncNotice = new Notice('Pebble Sync: Fetching notes...', 0);
        let importFailed = false;

        try {
            // FIXED: Robust URL handling to ensure HTTPS
            let apiUrl = s.apiUrl.trim();
            if (apiUrl.startsWith('app://')) {
                apiUrl = 'https://' + apiUrl.substring('app://obsidian.md/'.length);
            } else if (!apiUrl.startsWith('https://')) {
                apiUrl = 'https://' + apiUrl.replace(/^https?:\/\//, '');
            }
            const resp = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/sync/fetch`, {
                method: 'GET',
                mode: 'cors',
                credentials: 'omit',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': s.apiKey
                },
            });

            // Check if the response is ok before trying to parse JSON
            if (!resp.ok) {
                const errorText = await resp.text();
                console.error('API Response:', resp.status, resp.statusText, errorText);
                throw new Error(`API fetch failed with status ${resp.status}: ${errorText}`);
            }

            const contentType = resp.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await resp.text();
                console.error('Non-JSON response:', text);
                throw new Error('API returned non-JSON response');
            }

            const json = await resp.json();
            const notes = (json.items || []).filter(it => it?.type === 'note' && typeof it.markdown === 'string');

            if (notes.length === 0) {
                syncNotice.setMessage('Pebble Sync: No new notes to import.');
                return;
            }

            // Rest of your existing logic...
            syncNotice.setMessage(`Pebble Sync: Importing ${notes.length} notes...`);
            await this.ensureFolder(s.atomicNotesFolder);

            const triggerTags = new Set((s.atomicNotesTags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
            let createdCount = 0, overwrittenCount = 0;

            for (const note of notes) {
                const noteTimestamp = moment(note.createdAt || new Date());

                const itemTags = new Set((note.tags || []).map(t => t.replace(/^#/, '').trim().toLowerCase()));
                const matchingTag = [...triggerTags].find(trigger => itemTags.has(trigger));

                let baseName;
                if (matchingTag) {
                    baseName = matchingTag.charAt(0).toUpperCase() + matchingTag.slice(1);
                } else {
                    if (note.tags && note.tags.length > 0) {
                        baseName = (note.markdown.split('\n')[0] || `Pebble Note`).substring(0, 50).replace(/[\\/:"*?<>|]/g, '-').trim();
                    } else {
                        baseName = 'Atomic';
                    }
                }

                // MODIFIED: Added time (HH-mm) to the filename to ensure uniqueness
                const fileName = normalizePath(`${s.atomicNotesFolder}/${baseName} ${noteTimestamp.format('dddd, MMMM Do YYYY HH-mm')}.md`);

                const fileExists = this.app.vault.getAbstractFileByPath(fileName);

                if (fileExists && !s.overwriteExisting && !force) continue;

                const templateData = {
                    content: note.markdown,
                    date: noteTimestamp.format('YYYY-MM-DD'),
                    time: noteTimestamp.format('HH:mm'),
                    // MODIFIED: Removed seconds from the 'created' datetime property
                    fullDateTime: noteTimestamp.format('YYYY-MM-DD HH:mm'),
                    tags: note.tags || []
                };
                const content = await this.processTemplate(s.atomicNotesTemplate, templateData);

                let atomicFile;
                if (fileExists instanceof TFile) {
                    await this.app.vault.modify(fileExists, content);
                    atomicFile = fileExists;
                    overwrittenCount++;
                } else {
                    atomicFile = await this.app.vault.create(fileName, content);
                    createdCount++;
                }

                if (s.linkBackToDailyNote) {
                    await this.linkToDailyNote(atomicFile, noteTimestamp);
                }
            }

            let message = 'Pebble Sync: Import complete.';
            const details = [];
            if (createdCount > 0) details.push(`Created ${createdCount} new notes.`);
            if (overwrittenCount > 0) details.push(`Overwrote ${overwrittenCount} notes.`);
            if (createdCount === 0 && overwrittenCount === 0) {
                message = 'Pebble Sync: Nothing new to import.';
            }

            syncNotice.setMessage(message + (details.length > 0 ? ' ' + details.join(' ') : ''));
        } catch (e) {
            console.error('Pebble Sync import error', e);

            // More detailed error messages
            if (e.message.includes('CORS')) {
                syncNotice.setMessage('Pebble Sync: CORS error. Check server configuration.');
            } else if (e.message.includes('Failed to fetch')) {
                syncNotice.setMessage('Pebble Sync: Network error. Check URL and credentials.');
            } else {
                syncNotice.setMessage(`Pebble Sync: Import failed - ${e.message}`);
            }

            importFailed = true;
        } finally {
            if (!importFailed) {
                setTimeout(() => syncNotice.hide(), 5000);
            }
        }
    }
    async linkToDailyNote(fileToLink, dateMoment) {
        const cfg = this.getDailyConfig();
        const dailyFileName = dateMoment.format(cfg.format) + '.md';
        const dailyPath = normalizePath((cfg.folder ? `${cfg.folder}/` : '') + dailyFileName);

        const dailyFile = await this.ensureDailyFile(dailyPath, cfg);
        if (!dailyFile) return;

        const dailyFileContent = await this.app.vault.read(dailyFile);

        const link = this.app.fileManager.generateMarkdownLink(fileToLink, dailyFile.path, '', '');
        const embedLink = `!${link}`;

        if (dailyFileContent.includes(embedLink)) return;

        const heading = this.settings.sectionHeading.trim().replace(/#/g, '').trim();
        let contentToAppend;

        const headingRegex = new RegExp(`^#+\s+${heading}\s*$`, 'm');

        if (headingRegex.test(dailyFileContent)) {
            const lines = dailyFileContent.split('\n');
            const headingIndex = lines.findIndex(line => headingRegex.test(line));

            let endOfSectionIndex = lines.findIndex((line, index) => index > headingIndex && line.startsWith('#'));
            if (endOfSectionIndex === -1) {
                endOfSectionIndex = lines.length;
            }

            lines.splice(endOfSectionIndex, 0, embedLink, '');
            contentToAppend = lines.join('\n');
            await this.app.vault.modify(dailyFile, contentToAppend);
        } else {
            contentToAppend = `\n\n${this.settings.sectionHeading.trim()}\n${embedLink}\n`;
            await this.app.vault.append(dailyFile, contentToAppend);
        }
    }

    async ensureDailyFile(path, dailyConfig) {
        let file = this.app.vault.getAbstractFileByPath(path);
        if (!file) {
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) await this.ensureFolder(dir);

            let initialContent = '';
            if (dailyConfig.template) {
                const templatePath = normalizePath(dailyConfig.template + ".md");
                const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
                if (templateFile instanceof TFile) {
                    initialContent = await this.app.vault.read(templateFile);
                }
            }
            file = await this.app.vault.create(path, initialContent);
        }
        return file instanceof TFile ? file : null;
    }

    async ensureFolder(folderPath) {
        if (!this.app.vault.getAbstractFileByPath(folderPath)) {
            await this.app.vault.createFolder(folderPath).catch(() => { });
        }
    }
}

class PebbleSyncSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Pebble Sync Settings' });

        // --- General API Settings ---
        containerEl.createEl('h3', { text: 'API' });
        new Setting(containerEl).setName('API URL').addText(t => t.setPlaceholder('https://pebble...').setValue(this.plugin.settings.apiUrl).onChange(async v => { this.plugin.settings.apiUrl = v.trim(); await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('API key for authenticating with the Pebble sync service.')
            .addText(text => {
                text
                    .setPlaceholder('Enter your API key')
                    .setValue(this.plugin.settings.apiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.apiKey = value.trim();
                        await this.plugin.saveSettings();
                    });
                text.inputEl.type = 'password';
            });

        // --- Automation Settings ---
        containerEl.createEl('h3', { text: 'Automation' });
        new Setting(containerEl).setName('Run on startup').setDesc('Automatically sync when Obsidian starts.').addToggle(t => t.setValue(this.plugin.settings.autoRunOnStartup).onChange(async v => { this.plugin.settings.autoRunOnStartup = v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Automatic sync interval').setDesc('Time in minutes between automatic syncs. Set to 0 to disable.').addText(t => t.setPlaceholder('0').setValue(String(this.plugin.settings.autoRunInterval)).onChange(async v => { this.plugin.settings.autoRunInterval = parseInt(v, 10) || 0; await this.plugin.saveSettings(); this.plugin.setupAutoRun(); }));

        // --- Atomic Note Settings ---
        containerEl.createEl('h3', { text: 'Atomic Notes' });
        new Setting(containerEl).setName('Create atomic notes for imports').setDesc('This must be enabled for the plugin to work.').addToggle(t => t.setValue(this.plugin.settings.atomicNotesEnabled).onChange(async v => { this.plugin.settings.atomicNotesEnabled = v; await this.plugin.saveSettings(); this.display(); }));

        if (this.plugin.settings.atomicNotesEnabled) {
            new Setting(containerEl).setName('Folder for atomic notes').addText(t => t.setPlaceholder('Pebble/Ideas').setValue(this.plugin.settings.atomicNotesFolder).onChange(async v => { this.plugin.settings.atomicNotesFolder = v.trim(); await this.plugin.saveSettings(); }));
            new Setting(containerEl).setName('Trigger tags for special titles').setDesc('Comma-separated. Notes with these tags will use the tag as a title (e.g., "Idea"). Others use the first line of content.').addText(t => t.setPlaceholder('idea, thought, fleeting').setValue(this.plugin.settings.atomicNotesTags).onChange(async v => { this.plugin.settings.atomicNotesTags = v; await this.plugin.saveSettings(); }));
            new Setting(containerEl).setName('Atomic note template').setDesc('Available variables: {{content}}, {{date}}, {{time}}, {{fullDateTime}}, {{tags}} (comma-separated string).').addTextArea(text => {
                text.setValue(this.plugin.settings.atomicNotesTemplate).onChange(async (v) => { this.plugin.settings.atomicNotesTemplate = v; await this.plugin.saveSettings(); });
                text.inputEl.rows = 8;
                text.inputEl.style.width = '100%';
                text.inputEl.style.fontFamily = 'monospace';
            });
            new Setting(containerEl).setName('Overwrite on force re-import').setDesc('Enable this to allow the "Force re-import" command to overwrite existing notes with the same name.').addToggle(t => t.setValue(this.plugin.settings.overwriteExisting).onChange(async v => { this.plugin.settings.overwriteExisting = v; await this.plugin.saveSettings(); }));
        }

        // --- Daily Note Integration ---
        containerEl.createEl('h3', { text: 'Daily Note Integration' });
        new Setting(containerEl).setName('Embed link in daily note').setDesc('Embed created atomic notes in the corresponding daily note.').addToggle(t => t.setValue(this.plugin.settings.linkBackToDailyNote).onChange(async v => { this.plugin.settings.linkBackToDailyNote = v; await this.plugin.saveSettings(); this.display(); }));
        if (this.plugin.settings.linkBackToDailyNote) {
            new Setting(containerEl).setName('Section heading').setDesc("The heading to add new embeds under in your daily note.").addText(t => t.setValue(this.plugin.settings.sectionHeading).onChange(async v => { this.plugin.settings.sectionHeading = v; await this.plugin.saveSettings(); }));
            new Setting(containerEl).setName('Use Daily Notes core plugin settings').setDesc('Strongly recommended. Reads folder and format from the core plugin.').addToggle(t => t.setValue(this.plugin.settings.useDailyNotesCore).onChange(async v => { this.plugin.settings.useDailyNotesCore = v; await this.plugin.saveSettings(); this.display(); }));
            if (!this.plugin.settings.useDailyNotesCore) {
                new Setting(containerEl).setName('Fallback folder for daily notes').addText(t => t.setValue(this.plugin.settings.dailyFolder).onChange(async v => { this.plugin.settings.dailyFolder = v.trim(); await this.plugin.saveSettings(); }));
                new Setting(containerEl).setName('Fallback daily note date format').addText(t => t.setPlaceholder('YYYY-MM-DD').setValue(this.plugin.settings.dailyFileNameFormat).onChange(async v => { this.plugin.settings.dailyFileNameFormat = v.trim(); await this.plugin.saveSettings(); }));
            }
        }
    }
}

module.exports = PebbleSyncPlugin;

