import { Plugin, Notice, normalizePath, moment, Setting, TFile, PluginSettingTab, requestUrl } from 'obsidian';

const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sanitizeFileName = (value: string): string => value.replace(INVALID_FILENAME_CHARS, '-').replace(/\s+/g, ' ').trim();

const hashContent = (value: string): string => {
    if (!value) return '0';
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16);
};

interface PebbleNote {
    type: string;
    markdown: string;
    createdAt: string;
    tags?: string[];
    id?: string;
    uuid?: string;
    key?: string;
}

interface PebbleSyncResponse {
    items: PebbleNote[];
}

interface TemplateData {
    content: string;
    date: string;
    time: string;
    fullDateTime: string;
    tags: string[];
}

interface DailyConfig {
    folder: string;
    format: string;
    template: string;
}

interface PebbleSyncSettings {
    apiUrl: string;
    apiKey: string;
    importedKeys: string[];
    maxImportedKeys: number;
    autoRunOnStartup: boolean;
    autoRunInterval: number;
    atomicNotesEnabled: boolean;
    atomicNotesFolder: string;
    atomicNotesTags: string;
    atomicNotesTemplate: string;
    overwriteExisting: boolean;
    linkBackToDailyNote: boolean;
    sectionHeading: string;
    useDailyNotesCore: boolean;
    dailyFolder: string;
    dailyFileNameFormat: string;
}

const DEFAULT_SETTINGS: PebbleSyncSettings = {
    // --- General Settings ---
    apiUrl: '',
    apiKey: '',
    importedKeys: [],
    maxImportedKeys: 5000,

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

export default class PebbleSyncPlugin extends Plugin {
    settings!: PebbleSyncSettings;
    intervalId: number | null = null;

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

    getDailyConfig(): DailyConfig {
        const s = this.settings;
        if (s.useDailyNotesCore && (this.app as any).internalPlugins?.plugins?.['daily-notes']?.enabled) {
            try {
                const coreConfig = (this.app as any).internalPlugins.getPluginById('daily-notes')?.instance?.options;
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

    async processTemplate(template: string, data: TemplateData): Promise<string> {
        const tagString = (data.tags || []).filter(t => t).join(', ');
        return template
            .replace(/{{content}}/gi, data.content || '')
            .replace(/{{date}}/gi, data.date || '')
            .replace(/{{time}}/gi, data.time || '')
            .replace(/{{fullDateTime}}/gi, data.fullDateTime || '')
            .replace(/{{tags}}/gi, tagString);
    }

    async importNow(force = false) {
        const settings = this.settings;
        const apiUrl = this.normalizeApiUrl(settings.apiUrl);

        if (!apiUrl) {
            new Notice('Pebble Sync: Configure a valid API URL before syncing.');
            return;
        }

        if (!settings.apiKey) {
            new Notice('Pebble Sync: API key is required.');
            return;
        }

        if (!settings.atomicNotesEnabled) {
            new Notice('Pebble Sync: Enable atomic notes to run the importer.');
            return;
        }

        const targetFolder = (settings.atomicNotesFolder || '').trim();
        if (!targetFolder) {
            new Notice('Pebble Sync: Set a folder for atomic notes in the settings.');
            return;
        }

        const syncNotice = new Notice('Pebble Sync: Fetching notes...', 0);
        const storedKeys = new Set(Array.isArray(settings.importedKeys) ? settings.importedKeys : []);
        let keysMutated = false;
        let importFailed = false;

        try {
            const response = await requestUrl({
                url: `${apiUrl}/api/sync/fetch`,
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': settings.apiKey
                }
            });

            const payload: PebbleSyncResponse = response.json ?? JSON.parse(response.text);
            const notes = Array.isArray(payload.items)
                ? payload.items.filter(item => item?.type === 'note' && typeof item.markdown === 'string')
                : [];

            if (notes.length === 0) {
                syncNotice.setMessage('Pebble Sync: No new notes to import.');
                return;
            }

            syncNotice.setMessage(`Pebble Sync: Importing ${notes.length} notes...`);
            await this.ensureFolder(targetFolder);

            const triggerTags = new Set((settings.atomicNotesTags || '')
                .split(',')
                .map(tag => tag.trim().toLowerCase())
                .filter(Boolean));

            let createdCount = 0;
            let updatedCount = 0;
            let skippedDuplicates = 0;
            let skippedExisting = 0;

            for (const note of notes) {
                const dedupeKey = this.makeDedupeKey(note);
                if (!force && storedKeys.has(dedupeKey)) {
                    skippedDuplicates++;
                    continue;
                }

                const noteMoment = this.resolveNoteMoment(note.createdAt);
                const baseName = this.resolveBaseName(note, triggerTags);
                const relativePath = `${baseName} ${noteMoment.format('dddd, MMMM Do YYYY HH-mm')}.md`;
                const fileName = normalizePath(targetFolder ? `${targetFolder}/${relativePath}` : relativePath);
                const existingFile = this.app.vault.getAbstractFileByPath(fileName);

                if (existingFile && !(settings.overwriteExisting || force)) {
                    storedKeys.add(dedupeKey);
                    keysMutated = true;
                    skippedExisting++;
                    continue;
                }

                const templateData: TemplateData = {
                    content: note.markdown,
                    date: noteMoment.format('YYYY-MM-DD'),
                    time: noteMoment.format('HH:mm'),
                    fullDateTime: noteMoment.format('YYYY-MM-DD HH:mm'),
                    tags: note.tags || []
                };
                const fileContent = await this.processTemplate(settings.atomicNotesTemplate, templateData);

                let atomicFile: TFile;
                if (existingFile instanceof TFile) {
                    await this.app.vault.modify(existingFile, fileContent);
                    atomicFile = existingFile;
                    updatedCount++;
                } else {
                    atomicFile = await this.app.vault.create(fileName, fileContent);
                    createdCount++;
                }

                storedKeys.add(dedupeKey);
                keysMutated = true;

                if (settings.linkBackToDailyNote) {
                    await this.linkToDailyNote(atomicFile, noteMoment);
                }
            }

            if (keysMutated) {
                const maxKeys = Number.isFinite(settings.maxImportedKeys) && settings.maxImportedKeys > 0
                    ? settings.maxImportedKeys
                    : DEFAULT_SETTINGS.maxImportedKeys;
                this.settings.importedKeys = Array.from(storedKeys).slice(-maxKeys);
                await this.saveSettings();
            }

            let message = 'Pebble Sync: Import complete.';
            const details = [];
            if (createdCount > 0) details.push(`created ${createdCount} new notes`);
            if (updatedCount > 0) details.push(`updated ${updatedCount} notes`);
            if (skippedDuplicates > 0) details.push(`skipped ${skippedDuplicates} duplicates`);
            if (skippedExisting > 0) details.push(`skipped ${skippedExisting} existing notes`);

            if (details.length === 0) {
                message = 'Pebble Sync: Nothing new to import.';
            } else {
                message += ` ${details.join(', ')}.`;
            }

            syncNotice.setMessage(message);
        } catch (error) {
            console.error('Pebble Sync import error', error);
            syncNotice.setMessage(`Pebble Sync: ${this.normalizeError(error)}`);
            importFailed = true;
        } finally {
            if (!importFailed) {
                setTimeout(() => syncNotice.hide(), 5000);
            }
        }
    }

    async linkToDailyNote(fileToLink: TFile, noteMoment: any) {
        const cfg = this.getDailyConfig();
        const dailyFileName = `${noteMoment.format(cfg.format)}.md`;
        const dailyPath = normalizePath((cfg.folder ? `${cfg.folder}/` : '') + dailyFileName);

        const dailyFile = await this.ensureDailyFile(dailyPath, cfg);
        if (!dailyFile) return;

        const currentContent = await this.app.vault.read(dailyFile);
        const markdownLink = this.app.fileManager.generateMarkdownLink(fileToLink, dailyFile.path, '', '');
        const embedLink = `!${markdownLink}`;
        if (currentContent.includes(embedLink)) return;

        const headingSetting = this.settings.sectionHeading.trim();
        const headingText = headingSetting.replace(/^#+\s*/, '').trim() || 'Pebble Imports';
        const headingLine = headingSetting || `## ${headingText}`;
        const headingPattern = '^#+\\s+' + escapeRegExp(headingText) + '\\s*$';
        const headingRegex = new RegExp(headingPattern, 'mi');

        if (headingRegex.test(currentContent)) {
            const lines = currentContent.split('\n');
            const headingIndex = lines.findIndex(line => headingRegex.test(line));
            let insertIndex = headingIndex + 1;

            while (insertIndex < lines.length && !/^#+\s/.test(lines[insertIndex])) {
                insertIndex++;
            }

            const insertion = [embedLink];
            if (lines[insertIndex - 1]?.trim() !== '') {
                insertion.unshift('');
            }
            lines.splice(insertIndex, 0, ...insertion, '');
            await this.app.vault.modify(dailyFile, lines.join('\n'));
        } else {
            const snippet = `\n\n${headingLine}\n${embedLink}\n`;
            await this.app.vault.append(dailyFile, snippet);
        }
    }

    normalizeApiUrl(rawUrl: string): string {
        if (!rawUrl) return '';
        let url = rawUrl.trim();
        if (!url) return '';

        if (url.startsWith('app://obsidian.md/')) {
            url = `https://${url.substring('app://obsidian.md/'.length)}`;
        }

        if (!/^https?:\/\//i.test(url)) {
            url = `https://${url.replace(/^\/+/, '')}`;
        }

        return url.replace(/\/+$/, '');
    }

    resolveNoteMoment(rawTimestamp: string) {
        const candidate = moment(rawTimestamp);
        return candidate.isValid() ? candidate : moment();
    }

    resolveBaseName(note: PebbleNote, triggerTags: Set<string>): string {
        const tags = new Set((note.tags || []).map(tag => tag.replace(/^#/, '').trim().toLowerCase()));
        const matchingTag = [...triggerTags].find(tag => tags.has(tag));

        if (matchingTag) {
            const tagName = matchingTag.charAt(0).toUpperCase() + matchingTag.slice(1);
            return sanitizeFileName(tagName) || 'Pebble Note';
        }

        const firstLine = (note.markdown || '').split('\n')[0]?.trim();
        if (firstLine) {
            const candidate = sanitizeFileName(firstLine.substring(0, 50) || 'Pebble Note');
            return candidate || 'Pebble Note';
        }

        return 'Pebble Note';
    }

    makeDedupeKey(note: PebbleNote): string {
        const timestamp = typeof note.createdAt === 'string' ? note.createdAt : '';
        const identifier = note.id || note.uuid || note.key || '';
        const hash = hashContent(note.markdown || '');
        return [timestamp, identifier, hash].filter(Boolean).join('|');
    }

    normalizeError(error: any): string {
        if (!error) {
            return 'Unknown error during import.';
        }

        if (typeof error === 'string') {
            return error;
        }

        if (error.response) {
            const { status, text } = error.response;
            const preview = typeof text === 'string' ? `: ${text.slice(0, 200)}` : '';
            return `API returned ${status}${preview}`;
        }

        if (error.status && error.message) {
            return `API returned ${error.status}: ${error.message}`;
        }

        if (error.message) {
            if (/network/i.test(error.message)) {
                return 'Network error. Check your connection and URL.';
            }
            if (/unauthorized|401/i.test(error.message)) {
                return 'Authorization failed. Verify your API key.';
            }
            return `Import failed - ${error.message}`;
        }

        return 'Import failed due to an unexpected error.';
    }

    async ensureDailyFile(path: string, dailyConfig: DailyConfig): Promise<TFile | null> {
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

    async ensureFolder(folderPath: string) {
        const trimmed = (folderPath || '').trim();
        if (!trimmed) return;

        if (!this.app.vault.getAbstractFileByPath(trimmed)) {
            await this.app.vault.createFolder(trimmed).catch(() => { });
        }
    }
}

class PebbleSyncSettingTab extends PluginSettingTab {
    plugin: PebbleSyncPlugin;

    constructor(app: any, plugin: PebbleSyncPlugin) {
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
            new Setting(containerEl)
                .setName('Forget imported history')
                .setDesc('Clears the deduplication log so every note is eligible for import again.')
                .addButton(button => {
                    button.setButtonText('Clear');
                    button.onClick(async () => {
                        this.plugin.settings.importedKeys = [];
                        await this.plugin.saveSettings();
                        new Notice('Pebble Sync: Import history cleared.');
                    });
                });
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
