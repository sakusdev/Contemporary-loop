import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMidi, variableLength, DRUM_NOTES } from '../src/midi.js';
import { generateSong, STYLE_PRESETS } from '../src/music.js';

function parseMidi(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start, length) => new TextDecoder().decode(bytes.slice(start, start + length));
  assert.equal(text(0, 4), 'MThd'); assert.equal(view.getUint32(4), 6);
  let index = 14;
  const tracks = [];
  const readVariable = () => { let value = 0; for (let i = 0; i < 4; i++) { const n = bytes[index++]; value = value * 128 + (n & 127); if (!(n & 128)) return value; } throw new Error('Invalid variable length'); };
  while (index < bytes.length) {
    assert.equal(text(index, 4), 'MTrk');
    const length = view.getUint32(index + 4); index += 8; const end = index + length; let tick = 0; const events = [];
    while (index < end) {
      tick += readVariable(); const status = bytes[index++];
      if (status === 255) { const type = bytes[index++]; const length = readVariable(); const data = bytes.slice(index, index + length); index += length; events.push({ tick, status, type, data }); }
      else { const count = (status & 240) === 192 ? 1 : 2; events.push({ tick, status, data: bytes.slice(index, index + count) }); index += count; }
    }
    assert.equal(index, end); assert.equal(events.at(-1).type, 47); tracks.push(events);
  }
  assert.equal(view.getUint16(10), tracks.length);
  return { format: view.getUint16(8), ppq: view.getUint16(12), tracks };
}

test('MIDI contains valid conductor, instrument programs, tempo, markers and 4/4', () => {
  const song = generateSong({ seed: 'midi-check', tempo: 100 });
  const midi = parseMidi(encodeMidi(song));
  assert.equal(midi.format, 1); assert.equal(midi.ppq, 480); assert.equal(midi.tracks.length, 5);
  const tempo = midi.tracks[0].find(e => e.type === 81).data;
  assert.equal(tempo[0] * 65536 + tempo[1] * 256 + tempo[2], 600000);
  assert.deepEqual(Array.from(midi.tracks[0].find(e => e.type === 88).data), [4, 2, 24, 8]);
  assert.equal(midi.tracks[0].filter(e => e.type === 6).length, song.sections.length);
  for (const [index, program] of [[1, 4], [2, 33], [3, 11]]) assert.equal(midi.tracks[index].find(e => (e.status & 240) === 192).data[0], program);
  for (const events of midi.tracks) assert.equal(events.at(-1).tick, song.totalBeats * 480);
});
test('every MIDI note has a paired note-off with no stuck or overlapping pitches', () => {
  for (const style of Object.keys(STYLE_PRESETS)) {
    const song = generateSong({ seed: 'pairs', style, humanize: 0, complexity: 1 });
    for (const events of parseMidi(encodeMidi(song)).tracks.slice(1)) {
      const held = new Set();
      for (const event of events) {
        if ((event.status & 240) === 144) { assert.ok(!held.has(event.data[0])); held.add(event.data[0]); assert.ok(event.data[1] >= 1 && event.data[1] <= 127); }
        if ((event.status & 240) === 128) { assert.ok(held.has(event.data[0])); held.delete(event.data[0]); }
      }
      assert.equal(held.size, 0);
    }
  }
});
test('piano-band MIDI exports carry the instruments heard in the app', () => {
  for (const [style, programs] of [['bloom', [0, 32, 0]], ['carousel', [27, 33, 0]]]) {
    const midi = parseMidi(encodeMidi(generateSong({ seed: 'band-midi', style })));
    assert.deepEqual(midi.tracks.slice(1, 4).map(events => events.find(event => (event.status & 240) === 192).data[0]), programs);
    assert.ok(midi.tracks[4].filter(event => (event.status & 240) === 144).every(event => (event.status & 15) === 9));
  }
});
test('export respects mix mute, zero levels, and GM drum channel 10', () => {
  const song = generateSong();
  const midi = parseMidi(encodeMidi(song, { muted: { keys: true }, levels: { bass: 0 } }));
  for (const index of [1, 2]) assert.equal(midi.tracks[index].filter(e => (e.status & 240) === 144).length, 0);
  const drumEvents = midi.tracks[4].filter(e => (e.status & 240) === 144);
  assert.ok(drumEvents.length); assert.ok(drumEvents.every(e => (e.status & 15) === 9 && Object.values(DRUM_NOTES).includes(e.data[0])));
});
test('same-pitch overlaps terminate the old note before the new note', () => {
  const song = { title: 'Overlaps', settings: { tempo: 90 }, totalBeats: 4, events: [
    { track: 'keys', note: 60, beat: 0, duration: 3, velocity: .6 },
    { track: 'keys', note: 60, beat: 1, duration: 1, velocity: .6 },
  ] };
  const events = parseMidi(encodeMidi(song)).tracks[1].filter(e => [128, 144].includes(e.status & 240));
  assert.deepEqual(events.map(e => [e.tick, e.status & 240]), [[0, 144], [480, 128], [480, 144], [960, 128]]);
});
test('variable-length encoding handles boundaries and rejects invalid deltas', () => {
  assert.deepEqual(variableLength(127), [127]); assert.deepEqual(variableLength(128), [129, 0]); assert.deepEqual(variableLength(16384), [129, 128, 0]);
  for (const value of [-1, .5, NaN, 0x10000000]) assert.throws(() => variableLength(value), RangeError);
});
