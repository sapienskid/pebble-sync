# Pebble Sync

Pebble Sync pulls notes from your Pebble deployment into your Obsidian vault as atomic notes and can optionally embed links back into the matching Daily Note.

## Features
- Import Pebble notes on demand or on an interval; force mode overwrites existing files when needed.
- Deduplicate imports with an on-disk history (cleared via Settings → Pebble Sync → Forget imported history).
- Generate atomic notes with a configurable template, folder, and tag-derived naming.
- Automatically embed created notes beneath a configurable heading in the target Daily Note, respecting core Daily Notes settings when enabled.

## Requirements
- Obsidian 1.5.0 or newer.
- A deployed Pebble API endpoint.
- A Pebble API key (shared between Pebble app and plugin).

## Quick Start

### 1. Deploy Pebble backend (one click)

Use the Pebble deploy button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sapienskid/pebble)

After deploy:
- Add Worker secret `API_KEY` (one random value).
- Add KV binding `PEBBLE_SYNC_KV`.

### 2. Install plugin (manual/local vault)
1. Copy the release folder into your vault under `.obsidian/plugins/pebble-sync/`.
2. In Obsidian go to **Settings → Community plugins**:
   - Enable Community plugins.
   - Enable **Pebble Sync**.

### 3. Connect plugin to Pebble
1. Open **Settings → Pebble Sync**.
2. Set:
   - **API URL**: your Worker URL, for example `https://pebble.example.workers.dev`
   - **API Key**: same value used for Worker `API_KEY` secret
3. Run **Pebble Sync: Import new notes** (or click ribbon icon).

## Behaviour
- Hits `{API_URL}/api/sync/fetch` with header `X-API-Key: <value>`.
- Accepts payloads with `items: [{ type: 'note', markdown, createdAt, tags? }]`.
- Stores processed-note fingerprints (up to 5,000) to prevent duplicates; purge them with the “Forget imported history” button in Settings.
- Builds file names from the trigger tag (if present) or the first line of the note plus the captured timestamp (`<Folder>/<Name> dddd, MMMM Do YYYY HH-mm.md`).
- Embeds notes inside Daily Notes under a heading (default `## Pebble Imports`).

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

### Project structure

- `src/main.ts` - Main plugin source code
- `manifest.json` - Plugin manifest
- `versions.json` - Version compatibility mapping
- `main.js` - Compiled output (generated)
- `styles.css` - Plugin styles
- `esbuild.config.mjs` - Build configuration
- `tsconfig.json` - TypeScript configuration

### Release process

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
- “API returned …” errors come directly from the Pebble endpoint; check server logs and verify `API_KEY` matches in both app/plugin.
- Network issues: confirm the URL is HTTPS and reachable from your device.
- Use the developer console (`Cmd/Ctrl` + `Shift` + `I`) for additional logs.

## License
MIT – see `LICENSE` for details.
