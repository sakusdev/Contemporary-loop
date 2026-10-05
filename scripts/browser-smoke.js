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
  const firstSeed = await page.locator('#seed').inputValue();
  assert.notEqual(firstSeed, 'browser-check', 'Generate must choose a new seed');
  assert.equal(new URL(page.url()).searchParams.get('seed'), firstSeed, 'Shared URL must follow the new song');
  const midiDownload = page.waitForEvent('download'); await page.locator('#export-midi').click();
  const firstMidi = await readFile(await (await midiDownload).path()); assert.equal(firstMidi.subarray(0, 4).toString(), 'MThd');
  await page.locator('#generate').click(); await page.locator('#stop').click();
  const secondSeed = await page.locator('#seed').inputValue();
  assert.notEqual(secondSeed, firstSeed, 'Repeated generation must choose another seed');
  const midiAgain = page.waitForEvent('download'); await page.locator('#export-midi').click();
  const secondMidi = await readFile(await (await midiAgain).path());
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  // Compare instrument tracks, excluding conductor titles and chord labels.
  const notesHash = bytes => hash(bytes.subarray(22 + bytes.readUInt32BE(18)));
  assert.notEqual(notesHash(firstMidi), notesHash(secondMidi), 'Regeneration must change the actual notes');
  await page.locator('#play').click(); await page.locator('#next-song').click();
  await page.locator('#playback-state').getByText('PLAYING', { exact: true }).waitFor(); await page.locator('#stop').click();
  assert.notEqual(await page.locator('#seed').inputValue(), secondSeed, 'Transport regeneration must choose another seed');
  const nextMidiDownload = page.waitForEvent('download'); await page.locator('#export-midi').click();
  assert.notEqual(notesHash(await readFile(await (await nextMidiDownload).path())), notesHash(secondMidi), 'Transport regeneration must change the notes while playing');
  await page.locator('#seed').fill(firstSeed); await page.locator('#generate-seed').click(); await page.locator('#stop').click();
  assert.equal(await page.locator('#seed').inputValue(), firstSeed, 'Seed generation must honor the entered seed');
  const reproducedDownload = page.waitForEvent('download'); await page.locator('#export-midi').click();
  assert.equal(hash(await readFile(await (await reproducedDownload).path())), hash(firstMidi), 'Explicit seed generation must reproduce the original notes');
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
  for (const [style, name, tempo, keysName, bassName, legend] of [
    ['bloom', 'Gardenia系', 126, 'ピアノ伴奏', 'コントラバス', 'PIANO LH'],
    ['carousel', 'Ferris Wheel系', 116, 'ギター', 'ベース', 'GUITAR'],
  ]) {
    await page.locator(`input[name=style][value=${style}]`).check();
    assert.equal(await page.locator('#tempo-number').inputValue(), String(tempo));
    const seed = 'browser-' + style;
    await page.locator('#seed').fill(seed); await page.locator('#generate-seed').click();
    await page.locator('#playback-state').getByText('PLAYING', { exact: true }).waitFor(); await page.locator('#stop').click();
    assert.ok((await page.locator('#song-meta').textContent()).includes(name));
    assert.equal(await page.locator('#track-keys .track-name').textContent(), keysName);
    assert.equal(await page.locator('#track-bass .track-name').textContent(), bassName);
    assert.equal(await page.locator('#legend-keys').textContent(), legend);
    const download = page.waitForEvent('download'); await page.locator('#export-midi').click();
    const original = await readFile(await (await download).path());
    await page.locator('#generate').click(); await page.locator('#stop').click();
    assert.notEqual(await page.locator('#seed').inputValue(), seed);
    const regeneratedDownload = page.waitForEvent('download'); await page.locator('#export-midi').click();
    assert.notEqual(notesHash(await readFile(await (await regeneratedDownload).path())), notesHash(original), `${name} must regenerate its actual notes`);
    await page.locator('#seed').fill(seed); await page.locator('#generate-seed').click(); await page.locator('#stop').click();
    const reproduced = page.waitForEvent('download'); await page.locator('#export-midi').click();
    assert.equal(hash(await readFile(await (await reproduced).path())), hash(original), `${name} must reproduce the entered seed`);
  }
  const bandAudio = await page.evaluate(async () => {
    const { renderWav } = await import('/src/audio.js'); const { generateSong } = await import('/src/music.js');
    const results = [];
    for (const style of ['bloom', 'carousel']) {
      const song = generateSong({ seed: 'native-band-' + style, style, bars: 32 });
      const bytes = new DataView(await (await renderWav(song)).arrayBuffer());
      const rate = bytes.getUint32(24, true), channels = bytes.getUint16(22, true);
      const intro = song.sections[0], reprise = song.sections.find(section => section.name === 'テーマ回帰');
      const sectionRange = section => [section.startBar * 4 * 60 / song.settings.tempo * rate, (section.startBar + section.bars) * 4 * 60 / song.settings.tempo * rate];
      const [introStart, introEnd] = sectionRange(intro), [repriseStart, repriseEnd] = sectionRange(reprise);
      let peak = 0, sum = 0, clipped = 0, introSum = 0, introCount = 0, repriseSum = 0, repriseCount = 0;
      const count = (bytes.byteLength - 44) / 2;
      for (let sample = 0; sample < count; sample++) {
        const amplitude = Math.abs(bytes.getInt16(44 + sample * 2, true)) / 32768, frame = Math.floor(sample / channels);
        peak = Math.max(peak, amplitude); sum += amplitude * amplitude; clipped += Number(amplitude > .999);
        if (frame >= introStart && frame < introEnd) { introSum += amplitude * amplitude; introCount++; }
        if (frame >= repriseStart && frame < repriseEnd) { repriseSum += amplitude * amplitude; repriseCount++; }
      }
      results.push({ style, bytes: bytes.byteLength, peak, rms: Math.sqrt(sum / count), clippedSamples: clipped, introRms: Math.sqrt(introSum / introCount), repriseRms: Math.sqrt(repriseSum / repriseCount) });
    }
    return results;
  });
  for (const result of bandAudio) {
    assert.ok(result.peak > .02, `${result.style} must render audible native audio`);
    assert.equal(result.clippedSamples, 0, `${result.style} must leave WAV headroom`);
    assert.ok(result.repriseRms > result.introRms * 1.3, `${result.style} must grow from introduction to reprise`);
  }
  await page.getByRole('button', { name: 'テーマ A', exact: true }).click();
  await page.screenshot({ path: new URL('desktop.png', output).pathname, fullPage: true });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); await ready(page); await desktop.setOffline(true); await page.reload(); await ready(page); await desktop.setOffline(false);
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(origin + '/?style=bloom&seed=mobile-check&bars=32'); await ready(phone);
  assert.equal(await phone.locator('#tempo').inputValue(), '126');
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile must not scroll horizontally');
  await phone.locator('#play').click(); await phone.getByRole('button', { name: 'テーマ A', exact: true }).click();
  await phone.locator('#next-song').click();
  assert.notEqual(await phone.locator('#seed').inputValue(), 'mobile-check', 'Touch transport regeneration must choose a new seed');
  const mobileSeed = await phone.locator('#seed').inputValue();
  await phone.locator('#generate').click();
  assert.notEqual(await phone.locator('#seed').inputValue(), mobileSeed, 'Touch generation must choose a new seed');
  await phone.locator('#playback-state').getByText('PLAYING', { exact: true }).waitFor();
  await phone.locator('#play').click(); await phone.screenshot({ path: new URL('mobile.png', output).pathname, fullPage: true });
  await phone.goto(origin + '/?style=carousel&bars=32'); await ready(phone);
  assert.equal(await phone.locator('input[name=style]:checked').inputValue(), 'carousel', 'Style-only links must work without a seed');
  assert.equal(await phone.locator('#tempo').inputValue(), '116');
  assert.equal(await phone.locator('#track-keys .track-name').textContent(), 'ギター');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', desktop: '1365×920', mobile: '390×844', regeneration: 'new seeds and notes on desktop and touch', midi: 'explicit seed reproduces notes in legacy and piano-band styles', wav: { bytes: wav.length, peak: Number(peak.toFixed(4)), rms: Number(Math.sqrt(sum / samples).toFixed(4)), clippedSamples: clipped }, bandAudio: bandAudio.map(result => Object.fromEntries(Object.entries(result).map(([key, value]) => [key, typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(4)) : value]))), allMuted: 'silence', continuous: 'next seed', offline: 'reload works', pageErrors: 0 }, null, 2));
} finally { if (browser) await browser.close(); server.kill(); }
