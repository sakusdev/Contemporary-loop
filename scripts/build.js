import { mkdir, cp, rm } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'styles.css', 'icon.svg', 'manifest.webmanifest', 'sw.js', 'src']) await cp(new URL(name, root), new URL(name, output), { recursive: true });
console.log('Static app built in dist/');
