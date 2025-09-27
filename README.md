# pebble sync (Obsidian plugin)

Minimal Obsidian plugin that imports notes from your Pebble app into Daily Notes, filing each note by its creation date.

Features
- Ribbon icon to trigger import
- Uses Daily Notes core plugin settings (folder/format/template) when enabled
- One-way import from Pebble to Obsidian
- Groups notes by createdAt and appends to the correct daily note
- Custom daily filename format (e.g., dddd, MMMM Do YYYY) and optional template path
- Minimal formatting: - [HH:mm] content #tags
- Dedupe: remembers what’s already imported
- No build step required (plain JavaScript)

Requirements
- Obsidian 1.5.0+
- Your Pebble deployment URL
- Your Pebble API key (do not commit it anywhere)

Install (local vault)
1) Copy this folder to your vault under:
   .obsidian/plugins/pebble-sync
   Resulting files:
   - .obsidian/plugins/pebble-sync/manifest.json
   - .obsidian/plugins/pebble-sync/main.js
   - .obsidian/plugins/pebble-sync/README.md
   - .obsidian/plugins/pebble-sync/styles.css (optional)

2) In Obsidian:
   - Settings → Community plugins → Enable community plugins
   - Browse → Optional; since this is local, use “Installed plugins”
   - Enable “pebble sync”

3) Configure:
   - Settings → pebble sync
   - API Base URL: your deployment, e.g. https://pebble.sp03201122.workers.dev
   - API Key: paste your Pebble API key (stored locally; field is hidden)
   - Use Daily Notes core settings: ON to inherit folder/format/template from core plugin
   - Folder for daily files: if not using core settings, set your folder or leave blank for vault root
   - Daily file name format: e.g., dddd, MMMM Do YYYY (ignored if using core settings)
   - Template file path: e.g., Templates/daily_note_template (ignored if core sets a template)
   - Section heading: heading under which notes are appended (default ## Pebble)
   - Ensure frontmatter tag: ensure YAML contains tags: [journal] (configurable)
   - Frontmatter journal tag: set the tag value, default journal
   - Add date to frontmatter: add date: YYYY-MM-DD to YAML (toggle)

4) Import:
   - Open Command Palette → “Pebble Sync: Import now”
   - Notes are appended to the correct daily note files

Security
- Your API key is stored with Obsidian’s plugin data inside your vault (not synced by the plugin).
- Do not commit or publish your key. If the key is ever compromised, rotate it server-side.

How it works
- Makes a GET request to: {API_BASE_URL}/api/sync/fetch with Authorization: Bearer {API_KEY}
- Expects JSON: { items: [ { type: 'note', markdown, createdAt, tags? } ] }
- Groups by date (using the configured Date format)
- Resolves Daily Notes folder, file name, and template using core plugin (if enabled), otherwise plugin settings
- Ensures/creates the daily note file (respects custom file name format and template)
- Ensures YAML frontmatter exists with tags: [journal] (configurable) and adds date: YYYY-MM-DD (optional)
- Ensures the section heading exists, then appends lines like:
  - [HH:mm] Note content #tag1 #tag2
- Dedupe: remembers imported items via a lightweight key so re-imports don’t duplicate lines. Keeps at most 5,000 keys.

Notes & assumptions
- Only items of type "note" are imported. Tasks are ignored for now.
- The plugin does not poll; run the command whenever you want to import.
- If your daily notes are managed by another plugin, keep the same folder/format here.

Troubleshooting
- If import fails: check the Developer Console (Ctrl/Cmd+Shift+I) for logs.
- Verify API Base URL and API Key in settings.
- Ensure your daily folder exists or let the plugin create it.

Uninstall
- Disable the plugin in Obsidian.
- Delete the folder .obsidian/plugins/pebble-sync.

Migrating to a dedicated repository later
- This plugin is intentionally plain JS to avoid a build step.
- If you later move to TypeScript, a typical structure would include:
  - src/main.ts, tsconfig.json
  - esbuild or rollup config to produce main.js
  - release the built folder (manifest.json + main.js) for Obsidian.

License
- MIT (or your preferred license)
