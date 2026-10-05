/** Standard MIDI File format 1, with one conductor and four instrument tracks. */
export const MIDI_TRACKS = {
  keys: { name: 'Electric piano', channel: 0, program: 4 },
  bass: { name: 'Finger bass', channel: 1, program: 33 },
  lead: { name: 'Mellow lead', channel: 2, program: 11 },
  drums: { name: 'Drums', channel: 9 },
};
export const DRUM_NOTES = { kick: 36, snare: 38, hat: 42, openHat: 46, ride: 51, tom: 45, rim: 37, shaker: 70 };
const PPQ = 480;
const encoder = new TextEncoder();
const ascii = text => Array.from(encoder.encode(text));
const uint16 = n => [(n >>> 8) & 255, n & 255];
const uint32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
export function variableLength(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) throw new RangeError('Invalid MIDI delta time');
  const bytes = [value & 127];
  while ((value >>>= 7)) bytes.unshift((value & 127) | 128);
  return bytes;
}
const meta = (type, text) => { const bytes = ascii(text); return [255, type, ...variableLength(bytes.length), ...bytes]; };
function trackChunk(messages, lastTick) {
  messages.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let previous = 0;
  const bytes = [];
  for (const message of messages) {
    bytes.push(...variableLength(message.tick - previous), ...message.bytes);
    previous = message.tick;
  }
  bytes.push(...variableLength(Math.max(previous, lastTick) - previous), 255, 47, 0);
  return [...ascii('MTrk'), ...uint32(bytes.length), ...bytes];
}

export function encodeMidi(song, { levels = {}, muted = {}, volume = 1 } = {}) {
  if (!song || !Number.isFinite(song.totalBeats) || !Array.isArray(song.events)) throw new TypeError('A generated song is required');
  const lastTick = Math.round(song.totalBeats * PPQ);
  const tempo = Math.max(30, Math.min(280, Number(song.settings?.tempo) || 94));
  const microseconds = Math.round(60000000 / tempo);
  const conductor = [
    { tick: 0, order: 0, bytes: meta(3, song.title || 'Contemporary loop') },
    { tick: 0, order: 1, bytes: [255, 81, 3, ...uint32(microseconds).slice(1)] },
    { tick: 0, order: 2, bytes: [255, 88, 4, 4, 2, 24, 8] },
  ];
  for (const section of song.sections || []) conductor.push({ tick: Math.round(section.startBar * 4 * PPQ), order: 3, bytes: meta(6, section.name) });
  for (const chord of song.chords || []) conductor.push({ tick: Math.round(chord.beat * PPQ), order: 4, bytes: meta(1, chord.name) });
  const chunks = [trackChunk(conductor, lastTick)];

  for (const [track, info] of Object.entries(MIDI_TRACKS)) {
    const messages = [{ tick: 0, order: -2, bytes: meta(3, info.name) }];
    if (info.program !== undefined) messages.push({ tick: 0, order: -1, bytes: [192 | info.channel, info.program] });
    const level = Math.max(0, Math.min(1, (levels[track] ?? 1) * volume));
    const notes = muted[track] || level === 0 ? [] : song.events.filter(event => event.track === track).map(event => {
      const note = track === 'drums' ? DRUM_NOTES[event.drum] : event.note;
      const start = Math.max(0, Math.round(event.beat * PPQ));
      return { note, start, end: Math.min(lastTick, start + Math.max(1, Math.round(event.duration * PPQ))), velocity: Math.max(1, Math.min(127, Math.round(event.velocity * level * 127))) };
    }).filter(note => Number.isInteger(note.note) && note.note >= 0 && note.note < 128 && note.start < lastTick && note.end > note.start).sort((a, b) => a.start - b.start);
    // MIDI receivers cannot distinguish overlapping instances of the same pitch.
    // End the previous note before a repeated pitch so it never cuts the new note.
    const lastByPitch = new Map();
    for (const note of notes) {
      const previous = lastByPitch.get(note.note);
      if (previous && previous.end >= note.start) previous.end = note.start;
      lastByPitch.set(note.note, note);
    }
    for (const note of notes) {
      if (note.end <= note.start) continue;
      messages.push({ tick: note.start, order: 1, bytes: [144 | info.channel, note.note, note.velocity] });
      messages.push({ tick: note.end, order: 0, bytes: [128 | info.channel, note.note, 0] });
    }
    chunks.push(trackChunk(messages, lastTick));
  }
  const header = [...ascii('MThd'), ...uint32(6), ...uint16(1), ...uint16(chunks.length), ...uint16(PPQ)];
  return new Uint8Array([...header, ...chunks.flat()]);
}

export function exportMidi(song, options) { return new Blob([encodeMidi(song, options)], { type: 'audio/midi' }); }
