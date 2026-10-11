import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('dist/extension', { recursive: true });
await build({ entryPoints: ['src/extension/background.ts'], outfile: 'dist/extension/background.js', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120' });
await build({ entryPoints: ['src/extension/options.ts'], outfile: 'dist/extension/options.js', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120' });
for (const file of ['manifest.json', 'options.html', 'options.css']) copyFileSync(`extension/${file}`, `dist/extension/${file}`);
