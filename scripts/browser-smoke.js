import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const output = new URL('../test-results/', import.meta.url);
await mkdir(output, { recursive: true });
const port = 4179;
const server = spawn(process.execPath, ['scripts/serve.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
let browser;
try {
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* server starting */ }
    if (attempt === 59) throw new Error('Static server did not start');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.JAZZ_CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const desktop = await browser.newContext({ viewport: { width: 1365, height: 920 }, acceptDownloads: true });
  const page = await desktop.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const ready = async target => { await target.waitForFunction(() => !document.getElementById('song-meta').textContent.includes('準備中')); };
  await page.goto(origin + '/?seed=browser-check&bars=32&tempo=150'); await ready(page);
  assert.equal(await page.locator('#seed').inputValue(), 'browser-check');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#play').click(); await page.locator('#playback-state').getByText('PLAYING', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'テーマ A', exact: true }).click();
  await page.locator('#play').click();
  const paused = await page.locator('#elapsed').textContent(); await page.waitForTimeout(200);
  assert.equal(await page.locator('#elapsed').textContent(), paused);
  await page.locator('#mute-keys').click(); assert.equal(await page.locator('#mute-keys').getAttribute('aria-pressed'), 'true'); await page.locator('#mute-keys').click();
  await page.locator('#solo-bass').click(); assert.equal(await page.locator('#solo-bass').getAttribute('aria-pressed'), 'true'); await page.locator('#solo-bass').click();
  await page.locator('#tempo-number').fill('123'); assert.equal(await page.locator('#tempo').inputValue(), '123');
  await page.locator('input[name=style][value=fusion]').check(); assert.equal(await page.locator('#tempo').inputValue(), '108');
  await page.locator('#tempo-number').fill('150'); await page.locator('#generate').click();
  await page.locator('#playback-state').getByText('PLAYING', { exact: true }).waitFor(); await page.locator('#stop').click();
  const midiDownload = page.waitForEvent('download'); await page.locator('#export-midi').click();
  const firstMidi = await readFile(await (await midiDownload).path()); assert.equal(firstMidi.subarray(0, 4).toString(), 'MThd');
  await page.locator('#generate').click(); await page.locator('#stop').click();
  const midiAgain = page.waitForEvent('download'); await page.locator('#export-midi').click();
  const secondMidi = await readFile(await (await midiAgain).path());
  assert.equal(createHash('sha256').update(firstMidi).digest('hex'), createHash('sha256').update(secondMidi).digest('hex'));
  const wavDownload = page.waitForEvent('download', { timeout: 90000 }); await page.locator('#export-wav').click();
  const wav = await readFile(await (await wavDownload).path());
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt32LE(40), wav.length - 44); assert.equal(wav.readUInt16LE(22), 2);
  let peak = 0, sum = 0, clipped = 0, samples = 0;
  for (let i = 44; i < wav.length; i += 2) { const amplitude = Math.abs(wav.readInt16LE(i)) / 32768; peak = Math.max(peak, amplitude); sum += amplitude * amplitude; clipped += Number(amplitude > .999); samples++; }
  assert.ok(peak > .02, 'WAV should contain sound'); assert.ok(clipped / samples < .001, 'WAV should not clip');
  const nativeCheck = await page.evaluate(async () => {
    const { renderWav } = await import('/src/audio.js'); const { generateSong } = await import('/src/music.js');
    const song = generateSong({ seed: 'native-audio', bars: 32 }); const small = { ...song, totalBeats: 16, events: song.events.filter(e => e.beat < 16) };
    const blob = await renderWav(small, { muted: { keys: true, bass: true, drums: true, lead: true } });
    const bytes = new DataView(await blob.arrayBuffer()); let peak = 0;
    for (let i = 44; i < bytes.byteLength; i += 2) peak = Math.max(peak, Math.abs(bytes.getInt16(i, true)));
    return { peak, length: bytes.byteLength };
  });
  assert.equal(nativeCheck.peak, 0, 'All muted tracks should render absolute silence');
  await page.locator('#playback-mode').selectOption('continuous'); const oldSeed = await page.locator('#seed').inputValue();
  await page.locator('#seek').press('End'); await page.locator('#seek').press('ArrowLeft'); await page.locator('#play').click();
  await page.waitForFunction(seed => document.getElementById('seed').value !== seed, oldSeed);
  await page.locator('#stop').click(); await page.getByRole('button', { name: 'テーマ A', exact: true }).click();
  await page.screenshot({ path: new URL('desktop.png', output).pathname, fullPage: true });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); await ready(page); await desktop.setOffline(true); await page.reload(); await ready(page); await desktop.setOffline(false);
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(origin + '/?seed=mobile-check&bars=32'); await ready(phone);
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile must not scroll horizontally');
  await phone.locator('#play').click(); await phone.getByRole('button', { name: 'テーマ A', exact: true }).click();
  await phone.locator('#play').click(); await phone.screenshot({ path: new URL('mobile.png', output).pathname, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', desktop: '1365×920', mobile: '390×844', midi: 'reproducible', wav: { bytes: wav.length, peak: Number(peak.toFixed(4)), rms: Number(Math.sqrt(sum / samples).toFixed(4)), clippedSamples: clipped }, allMuted: 'silence', continuous: 'next seed', offline: 'reload works', pageErrors: 0 }, null, 2));
} finally { if (browser) await browser.close(); server.kill(); }
