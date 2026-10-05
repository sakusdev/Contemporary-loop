import { generateSong, normalizeSettings, DEFAULT_SETTINGS, STYLE_PRESETS, NOTE_NAMES, sectionAtBeat } from './music.js';
import { JazzPlayer, renderWav } from './audio.js';
import { exportMidi } from './midi.js';

const $ = id => document.getElementById(id);
const TRACK_INFO = { keys: { name: 'エレピ', color: '#d8b483' }, bass: { name: 'ベース', color: '#80b7ad' }, drums: { name: 'ドラム', color: '#9aaacb' }, lead: { name: 'リード', color: '#c9a2b4' } };
const STORAGE_KEY = 'contemporary-loop-v1';
let saved = {};
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; if (typeof saved !== 'object') saved = {}; } catch { /* storage can be unavailable in private mode */ }
const asNumber = (value, fallback, max = 1) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Number(value))) : fallback;
const mixer = { volume: asNumber(saved.mixer?.volume, .75), reverb: asNumber(saved.mixer?.reverb, .18, .5), levels: {}, muted: {}, solo: null };
for (const track of Object.keys(TRACK_INFO)) { mixer.levels[track] = asNumber(saved.mixer?.levels?.[track], { keys: .75, bass: .8, drums: .65, lead: .65 }[track]); mixer.muted[track] = saved.mixer?.muted?.[track] === true; }
let song;
let dirty = false;
let exporting = false;
let generating = false;
let rollPage = -1;
let rollEvents = [];
let needsDraw = true;
let seeking = false;
let messageTimer;
const player = new JazzPlayer({ onState: updateState, onEnded: () => handleEnded().catch(showError) });

function initialSettings() {
  const query = new URLSearchParams(location.search);
  const settings = { ...DEFAULT_SETTINGS, bars: 64, seed: 'late-session', ...(saved.settings && typeof saved.settings === 'object' ? saved.settings : {}) };
  const preset = Object.hasOwn(STYLE_PRESETS, query.get('style')) ? STYLE_PRESETS[query.get('style')] : null;
  if (preset) {
    settings.tempo = preset.tempo; settings.swing = preset.swing;
    settings.complexity = preset.complexity ?? DEFAULT_SETTINGS.complexity;
  }
  for (const key of ['seed', 'style', 'key', 'tempo', 'bars', 'complexity', 'swing', 'humanize']) if (query.has(key)) settings[key] = query.get(key);
  return normalizeSettings(settings);
}
function controlsSettings() {
  return normalizeSettings({ seed: $('seed').value.trim(), style: document.querySelector('input[name=style]:checked').value, key: Number($('key').value), tempo: Number($('tempo').value), bars: Number($('bars').value), complexity: Number($('complexity').value) / 100, swing: Number($('swing').value) / 100, humanize: Number($('humanize').value) / 100 });
}
function writeControls(settings) {
  document.querySelector(`input[name=style][value=${settings.style}]`).checked = true;
  for (const key of ['seed', 'key', 'tempo', 'bars']) $(key).value = settings[key];
  $('tempo-number').value = settings.tempo;
  for (const key of ['complexity', 'swing', 'humanize']) $(key).value = Math.round(settings[key] * 100);
  updateOutputs();
}
function updateOutputs() {
  for (const key of ['complexity', 'swing', 'humanize']) $(key + '-output').value = $(key).value + '%';
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: song?.settings, mixer, mode: $('playback-mode').value })); } catch { /* playback does not require storage */ }
}
function effectiveMuted() {
  return Object.fromEntries(Object.keys(TRACK_INFO).map(track => [track, mixer.solo ? mixer.solo !== track : mixer.muted[track]]));
}
function applyMixer() {
  player.setVolume(mixer.volume);
  player.setReverb(mixer.reverb);
  const muted = effectiveMuted();
  for (const track of Object.keys(TRACK_INFO)) {
    player.setTrackLevel(track, mixer.levels[track]); player.setMuted(track, muted[track]);
    const row = $('track-' + track);
    if (row) {
      row.classList.toggle('is-muted', muted[track]);
      $('mute-' + track).setAttribute('aria-pressed', String(mixer.muted[track]));
      $('solo-' + track).setAttribute('aria-pressed', String(mixer.solo === track));
      $('level-output-' + track).value = Math.round(mixer.levels[track] * 100) + '%';
    }
  }
  $('master-volume').value = Math.round(mixer.volume * 100); $('master-output').value = Math.round(mixer.volume * 100) + '%';
  $('reverb').value = Math.round(mixer.reverb * 100); $('reverb-output').value = Math.round(mixer.reverb * 100) + '%';
}
function createMixer() {
  for (const [track, info] of Object.entries(TRACK_INFO)) {
    const row = document.createElement('div'); row.className = 'track-row'; row.id = 'track-' + track; row.style.setProperty('--track-color', info.color);
    const name = document.createElement('span'); name.className = 'track-name'; name.textContent = info.name;
    const mute = document.createElement('button'); mute.type = 'button'; mute.id = 'mute-' + track; mute.className = 'track-button'; mute.textContent = 'M'; mute.setAttribute('aria-label', info.name + 'をミュート');
    const solo = document.createElement('button'); solo.type = 'button'; solo.id = 'solo-' + track; solo.className = 'track-button'; solo.textContent = 'S'; solo.setAttribute('aria-label', info.name + 'をソロ');
    const level = document.createElement('input'); level.type = 'range'; level.id = 'level-' + track; level.min = 0; level.max = 100; level.value = Math.round(mixer.levels[track] * 100); level.setAttribute('aria-label', info.name + 'の音量');
    const output = document.createElement('output'); output.id = 'level-output-' + track; output.htmlFor = level.id;
    row.append(name, mute, solo, level, output); $('mixer-tracks').append(row);
    mute.addEventListener('click', () => { mixer.muted[track] = !mixer.muted[track]; if (mixer.solo === track) mixer.solo = null; applyMixer(); persist(); });
    solo.addEventListener('click', () => { mixer.solo = mixer.solo === track ? null : track; applyMixer(); persist(); });
    level.addEventListener('input', () => { mixer.levels[track] = Number(level.value) / 100; applyMixer(); persist(); });
  }
}
function randomSeed() {
  const bytes = new Uint32Array(2); crypto.getRandomValues(bytes);
  return 'session-' + Array.from(bytes, n => n.toString(36)).join('-');
}
function markDirty() {
  dirty = JSON.stringify(controlsSettings()) !== JSON.stringify(song.settings);
  $('dirty-state').hidden = !dirty;
  updateOutputs();
}
function formatTime(seconds) { const s = Math.max(0, Math.floor(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function shareUrl() {
  const url = new URL(location.href); url.hash = ''; url.search = '';
  for (const [key, value] of Object.entries(song.settings)) url.searchParams.set(key, String(value));
  return url.href;
}
function showMessage(text, error = false) {
  clearTimeout(messageTimer); $('message').textContent = text; $('message').classList.toggle('error', error);
  if (!error) messageTimer = setTimeout(() => { $('message').textContent = ''; }, 8000);
}
function showError(error) { console.error(error); showMessage('処理できませんでした。' + (error?.message || 'もう一度お試しください。'), true); }
async function generate(settings, play = false, synchronizeControls = true) {
  if (generating) return;
  generating = true; $('generate').disabled = true; $('generate-seed').disabled = true; $('next-song').disabled = true;
  try {
    const next = generateSong(settings);
    player.stop(); song = next;
    if (synchronizeControls) { writeControls(song.settings); dirty = false; $('dirty-state').hidden = true; }
    await player.load(song); applyMixer(); renderSong(); persist();
    if (location.search) history.replaceState(null, '', shareUrl());
    if (play) await playSong();
  } finally { generating = false; $('generate').disabled = false; $('generate-seed').disabled = false; $('next-song').disabled = false; }
}
function regenerate() {
  return generate({ ...controlsSettings(), seed: randomSeed() }, true);
}
async function playSong() {
  await player.play();
  if (!player.getState().playing) showMessage('音声を開始できませんでした。再生ボタンをもう一度押してください。', true);
}
async function handleEnded() {
  const mode = $('playback-mode').value;
  if (mode === 'repeat') { player.seek(0); await playSong(); }
  else if (mode === 'continuous') {
    const next = { ...song.settings, seed: randomSeed() };
    await generate(next, true, !dirty);
    if (dirty) markDirty();
  }
}
function renderSong() {
  const preset = STYLE_PRESETS[song.settings.style];
  for (const [track, info] of Object.entries(TRACK_INFO)) {
    const name = preset.trackNames?.[track] || info.name;
    $('track-' + track).querySelector('.track-name').textContent = name;
    $('mute-' + track).setAttribute('aria-label', name + 'をミュート');
    $('solo-' + track).setAttribute('aria-label', name + 'をソロ');
    $('level-' + track).setAttribute('aria-label', name + 'の音量');
  }
  $('legend-keys').textContent = preset.legends?.keys || 'KEYS';
  $('legend-lead').textContent = preset.legends?.lead || 'LEAD';
  $('song-title').textContent = song.title;
  $('song-meta').textContent = `${STYLE_PRESETS[song.settings.style].name} · ${NOTE_NAMES[song.settings.key]} · ${song.settings.tempo} BPM · ${song.bars} 小節`;
  $('seek').max = song.totalBeats; $('seek').value = 0;
  $('duration').textContent = formatTime(song.totalBeats * 60 / song.settings.tempo);
  $('arrangement').replaceChildren();
  for (const section of song.sections) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'section-button'; button.textContent = section.name;
    button.title = `${section.name} / ${section.startBar + 1}〜${section.startBar + section.bars} 小節`; button.style.flexGrow = section.bars; button.dataset.start = section.startBar;
    button.addEventListener('click', () => { player.seek(section.startBar * 4); needsDraw = true; updateState(player.getState()); });
    $('arrangement').append(button);
  }
  rollPage = -1; needsDraw = true; updateState(player.getState());
}
function updateState(state) {
  if (!song) return;
  const playing = state.playing;
  const interrupted = playing && state.contextState !== 'running';
  $('play-label').textContent = playing ? '一時停止' : '再生';
  $('play').setAttribute('aria-label', playing ? '一時停止' : '再生');
  $('play-icon').firstElementChild.setAttribute('d', playing ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'M8 5v14l11-7z');
  $('playing-dot').classList.toggle('active', playing && !interrupted);
  $('playback-state').textContent = interrupted ? 'SUSPENDED' : playing ? 'PLAYING' : state.beat >= song.totalBeats ? 'FINISHED' : state.beat > 0 ? 'PAUSED' : 'READY';
  const bar = Math.min(song.bars - 1, Math.floor(state.beat / 4));
  $('bar-counter').textContent = `${String(bar + 1).padStart(2, '0')} / ${song.bars}`;
  const section = sectionAtBeat(song, Math.min(state.beat, song.totalBeats - .001));
  $('section-name').textContent = section?.name || '';
  if (!seeking) $('seek').value = state.beat;
  $('elapsed').textContent = formatTime(state.seconds);
  $('seek').setAttribute('aria-valuetext', `${bar + 1}小節目、${formatTime(state.seconds)}`);
  for (const button of $('arrangement').children) { const active = Number(button.dataset.start) === section?.startBar; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'true' : 'false'); }
  const page = Math.floor(bar / 8) * 8;
  if (page !== rollPage) {
    rollPage = page; needsDraw = true;
    rollEvents = song.events.filter(event => event.beat < page * 4 + 32 && event.beat + event.duration >= page * 4);
    $('chord-strip').replaceChildren();
    for (let i = page; i < Math.min(page + 8, song.bars); i++) {
      const chord = song.chords.find(chord => chord.bar === i);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'chord-cell'; button.dataset.bar = i; button.title = `${i + 1}小節目: ${chord?.name || ''}`;
      const index = document.createElement('small'); index.textContent = String(i + 1).padStart(2, '0'); const label = document.createElement('strong'); label.textContent = chord?.name || '—';
      button.append(index, label); button.addEventListener('click', () => { player.seek(i * 4); needsDraw = true; updateState(player.getState()); }); $('chord-strip').append(button);
    }
  }
  for (const button of $('chord-strip').children) button.classList.toggle('active', Number(button.dataset.bar) === bar);
}

const canvas = $('piano-roll');
const context = canvas.getContext('2d');
function drawRoll(beat) {
  if (!context || !song) return;
  const width = canvas.clientWidth, height = canvas.clientHeight, ratio = Math.min(devicePixelRatio || 1, 2);
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
  const left = width < 430 ? 25 : 36, right = 8, top = 8, bottom = height - 34, plotWidth = width - left - right;
  const minNote = 32, maxNote = 85, rowHeight = (bottom - top) / (maxNote - minNote);
  const x = value => left + (value - rollPage * 4) / 32 * plotWidth;
  const y = note => bottom - (note - minNote) * rowHeight;
  context.font = '8px ui-monospace, monospace'; context.textBaseline = 'middle';
  for (let note = 36; note <= 84; note += 12) { context.strokeStyle = '#263132'; context.lineWidth = .6; context.beginPath(); context.moveTo(left, y(note)); context.lineTo(width - right, y(note)); context.stroke(); context.fillStyle = '#627670'; context.fillText('C' + (note / 12 - 1), 0, y(note)); }
  for (let i = 0; i <= 32; i++) { context.strokeStyle = i % 4 ? '#1b2525' : '#2b3737'; context.lineWidth = i % 4 ? .5 : 1; context.beginPath(); context.moveTo(x(rollPage * 4 + i), top); context.lineTo(x(rollPage * 4 + i), bottom + 10); context.stroke(); }
  context.save(); context.beginPath(); context.rect(left, top, plotWidth, bottom - top + 17); context.clip();
  for (const event of rollEvents) {
    const start = Math.max(left, x(event.beat)), end = Math.min(width - right, x(event.beat + event.duration));
    if (event.track === 'drums') { context.globalAlpha = .25 + event.velocity * .4; context.fillStyle = TRACK_INFO.drums.color; context.fillRect(start, bottom + 10, Math.max(1.1, plotWidth / 300), 3); continue; }
    const active = beat >= event.beat && beat < event.beat + event.duration && player.playing;
    context.globalAlpha = active ? 1 : .45 + event.velocity * .3; context.fillStyle = TRACK_INFO[event.track].color;
    context.fillRect(start, y(event.note) - rowHeight * .42, Math.max(1.5, end - start - .5), Math.max(1.7, rowHeight * .7));
  }
  context.globalAlpha = 1;
  const position = x(Math.max(rollPage * 4, Math.min(rollPage * 4 + 32, beat)));
  context.fillStyle = '#eeeee509'; context.fillRect(left, top, Math.max(0, position - left), bottom - top + 17);
  context.strokeStyle = '#e1d6bc'; context.lineWidth = 1; context.beginPath(); context.moveTo(position, top); context.lineTo(position, bottom + 16); context.stroke(); context.restore();
}
let lastFrame = 0;
function frame(now) {
  const state = player.getState();
  if (song && (needsDraw || (state.playing && now - lastFrame >= 40))) { updateState(state); drawRoll(state.beat); needsDraw = false; lastFrame = now; }
  requestAnimationFrame(frame);
}
function download(blob, extension, source = song) {
  const safeSeed = source.seed.replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 40) || 'session';
  const link = document.createElement('a'); const url = URL.createObjectURL(blob);
  link.href = url; link.download = `contemporary-loop-${safeSeed}.${extension}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}

$('composer-form').addEventListener('submit', event => { event.preventDefault(); regenerate().catch(showError); });
$('generate-seed').addEventListener('click', () => generate(controlsSettings(), true).catch(showError));
$('composer-form').addEventListener('input', event => { if (event.target.id === 'tempo') $('tempo-number').value = $('tempo').value; markDirty(); });
$('tempo-number').addEventListener('input', event => { const value = Number(event.target.value); if (value >= 60 && value <= 150) $('tempo').value = Math.round(value); markDirty(); });
$('tempo-number').addEventListener('change', () => { $('tempo').value = normalizeSettings({ tempo: $('tempo-number').value }).tempo; $('tempo-number').value = $('tempo').value; markDirty(); });
document.querySelectorAll('input[name=style]').forEach(input => input.addEventListener('change', () => { const preset = STYLE_PRESETS[input.value]; $('tempo').value = preset.tempo; $('tempo-number').value = preset.tempo; $('swing').value = Math.round(preset.swing * 100); if (preset.complexity != null) $('complexity').value = Math.round(preset.complexity * 100); markDirty(); }));
$('random-seed').addEventListener('click', () => { $('seed').value = randomSeed(); markDirty(); });
$('play').addEventListener('click', () => { if (player.playing) { player.pause(); needsDraw = true; } else playSong().catch(showError); });
$('stop').addEventListener('click', () => { player.stop(); needsDraw = true; });
$('next-song').addEventListener('click', () => regenerate().catch(showError));
$('seek').addEventListener('pointerdown', () => { seeking = true; });
$('seek').addEventListener('input', () => { player.seek(Number($('seek').value)); needsDraw = true; });
for (const event of ['pointerup', 'pointercancel', 'change', 'blur']) $('seek').addEventListener(event, () => { seeking = false; });
$('master-volume').addEventListener('input', () => { mixer.volume = Number($('master-volume').value) / 100; applyMixer(); persist(); });
$('reverb').addEventListener('input', () => { mixer.reverb = Number($('reverb').value) / 100; applyMixer(); persist(); });
$('playback-mode').addEventListener('change', persist);
$('share').addEventListener('click', async () => { const url = shareUrl(); history.replaceState(null, '', url); try { await navigator.clipboard.writeText(url); showMessage('同じ曲を再現できるリンクをコピーしました。'); } catch { window.prompt('このリンクで同じ曲を再現できます。コピーして共有してください。', url); } });
$('export-midi').addEventListener('click', () => { try { download(exportMidi(song, { levels: mixer.levels, muted: effectiveMuted(), volume: mixer.volume }), 'mid'); showMessage('MIDIを書き出しました。'); } catch (error) { showError(error); } });
$('export-wav').addEventListener('click', async () => {
  if (exporting) return;
  exporting = true; const source = song; const options = { volume: mixer.volume, reverb: mixer.reverb, levels: { ...mixer.levels }, muted: effectiveMuted() };
  $('export-wav').disabled = true; $('export-midi').disabled = true; $('export-progress').hidden = false; $('export-progress').value = 0; $('export-note').textContent = '音声をレンダリングしています…';
  try {
    const blob = await renderWav(source, { ...options, onProgress: value => { $('export-progress').value = value * .8; } });
    $('export-progress').value = 1; download(blob, 'wav', source); showMessage('WAVを書き出しました。'); $('export-note').textContent = '現在の1曲を書き出します。';
  } catch (error) { showError(error); $('export-note').textContent = '書き出せませんでした。もう一度お試しください。'; }
  finally { exporting = false; $('export-wav').disabled = false; $('export-midi').disabled = false; $('export-progress').hidden = true; }
});
document.addEventListener('keydown', event => { if (event.code === 'Space' && !event.repeat && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(event.target.tagName) && !event.target.isContentEditable) { event.preventDefault(); $('play').click(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { needsDraw = true; updateState(player.getState()); } });
new ResizeObserver(() => { needsDraw = true; }).observe(canvas);
window.addEventListener('pagehide', () => player.pause());

createMixer();
if (['continuous', 'repeat', 'once'].includes(saved.mode)) $('playback-mode').value = saved.mode;
await generate(initialSettings());
if (!(window.AudioContext || window.webkitAudioContext)) { $('play').disabled = true; $('generate').disabled = true; $('generate-seed').disabled = true; $('export-wav').disabled = true; showMessage('このブラウザはWeb Audioに対応していません。新しいブラウザで開いてください。', true); }
else if (!(window.OfflineAudioContext || window.webkitOfflineAudioContext)) $('export-wav').disabled = true;
requestAnimationFrame(frame);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => { /* offline caching is optional */ });
