# Pebble Sync

Pebble Sync pulls notes from your Pebble deployment into a local notes vault by turning each item into its own atomic note and (optionally) embedding it back into the matching Daily Note. The plugin is plain JavaScript, ships unbundled, and is ready to distribute.

## Features
- Import Pebble notes on demand or on an interval; force mode overwrites existing files when needed.
- Deduplicate imports with an on-disk history (cleared via Settings → Pebble Sync → Forget imported history).
- Generate atomic notes with a configurable template, folder, and tag-derived naming.
- Automatically embed created notes beneath a configurable heading in the target Daily Note, respecting core Daily Notes settings when enabled.
- Works without a build step; the published bundle is just `manifest.json`, `main.js`, optional `styles.css`, `README.md`, and `versions.json`.

## Requirements
- Obsidian 1.5.0 or newer.
- A deployed Pebble API endpoint (Workers, Fly.io, etc.).
- A Pebble API key – keep it secret and out of version control.

## Installation (manual/local vault)
1. Copy the release folder into your vault under `.obsidian/plugins/pebble-sync/`.
2. In Obsidian go to **Settings → Community plugins**:
   - Enable Community plugins.
   - Enable **Pebble Sync**.
3. Open **Settings → Pebble Sync** and configure:
   - **API URL** – your deployment base URL, e.g. `https://pebble.example.workers.dev`.
   - **API Key** – stored locally via Obsidian’s data storage.
   - **Create atomic notes for imports** – must stay enabled for imports to work.
   - **Folder / template / trigger tags** – customize output files.
   - **Embed link in daily note** – toggle to push embeds into Daily Notes; inherit folder/format from the core plugin or provide fallbacks.

Run the command palette action **Pebble Sync: Import new notes** (or use the ribbon button) to pull the latest notes. Use **Force re-import** to overwrite existing files.

## Behaviour
- Hits `{API_URL}/api/sync/fetch` with header `X-API-Key: <value>`.
- Accepts payloads with `items: [{ type: 'note', markdown, createdAt, tags? }]`.
- Stores processed-note fingerprints (up to 5,000) to prevent duplicates; purge them with the “Forget imported history” button in Settings.
- Builds file names from the trigger tag (if present) or the first line of the note plus the captured timestamp (`<Folder>/<Name> dddd, MMMM Do YYYY HH-mm.md`).
- Embeds notes inside Daily Notes underneath a heading (default `## Pebble Imports`).

## Development

This plugin is built with TypeScript and uses esbuild for bundling.

### Prerequisites

- Node.js (LTS version, installed via nvm)
- pnpm

### Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Build the plugin:
   ```bash
   pnpm run build
   ```

3. For development with watch mode:
   ```bash
   pnpm run dev
   ```

### Project Structure

- `src/main.ts` - Main plugin source code
- `manifest.json` - Plugin manifest
- `versions.json` - Version compatibility mapping
- `main.js` - Compiled output (generated)
- `styles.css` - Plugin styles
- `esbuild.config.mjs` - Build configuration
- `tsconfig.json` - TypeScript configuration

### Release Process

1. Update version in `package.json`
2. Run `pnpm run version` to update manifest and versions.json
3. Build with `pnpm run build`
4. Package the following files for distribution:
   - `manifest.json`
   - `main.js`
   - `styles.css`
   - `README.md`
   - `versions.json`

Tip: run `node scripts/prepare-release.mjs` from the project root to automatically copy those files into the `release/` folder before creating a GitHub release or uploading assets. This helps avoid missing `main.js`/`manifest.json` in a release.

## Troubleshooting
- “No new notes” usually means the dedupe cache already contains the items – clear it in Settings if you need to re-import.
- “API returned …” errors come directly from the Pebble endpoint; check server-side logs and ensure `X-API-Key` validation matches.
- Network issues: confirm the URL is HTTPS and reachable from your device.
- Use the developer console (`Cmd/Ctrl` + `Shift` + `I`) for additional logs.

## License
MIT – see `LICENSE` for details.
