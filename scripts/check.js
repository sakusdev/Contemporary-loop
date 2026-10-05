import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const dir of ['src', 'scripts', 'tests']) {
  for (const file of await readdir(new URL(`../${dir}/`, import.meta.url))) {
    if (!file.endsWith('.js')) continue;
    const path = new URL(`../${dir}/${file}`, import.meta.url);
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(path)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
const sw = spawnSync(process.execPath, ['--check', 'sw.js'], { stdio: 'inherit' });
if (sw.status !== 0) process.exit(sw.status || 1);
JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
console.log('JavaScript syntax and manifest: OK');
