import fs from 'fs';
import { join } from 'path';

const root = process.cwd();
const releaseDir = join(root, 'release');
const filesToCopy = ['manifest.json', 'main.js', 'styles.css', 'README.md', 'versions.json'];

if (!fs.existsSync(releaseDir)) fs.mkdirSync(releaseDir);

for (const file of filesToCopy) {
  const src = join(root, file);
  const dest = join(releaseDir, file);
  if (!fs.existsSync(src)) {
    console.warn(`prepare-release: source file missing: ${file}`);
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log(`Copied ${file} -> release/${file}`);
}

console.log('prepare-release: done');
