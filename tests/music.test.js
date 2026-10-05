import test from "node:test";
import assert from "node:assert/strict";
import { STYLE_PRESETS, generateSong, normalizeSettings, sectionAtBeat, chordAtBeat } from "../src/music.js";

test("generation is reproducible across styles, keys, and supported lengths", () => {
  for (const style of Object.keys(STYLE_PRESETS)) {
    for (let key = 0; key < 12; key++) {
      for (const bars of [32, 64, 96]) {
        const input = { seed: `repeat-${style}-${key}-${bars}`, style, key, bars };
        assert.deepEqual(generateSong(input), generateSong(input));
      }
    }
  }
});

test("normalization bounds input and resolves invalid values defensively", () => {
  const settings = normalizeSettings({ seed: "x".repeat(100), style: "unknown", key: 28, tempo: 999, bars: 80, complexity: -2, swing: 2, humanize: 4 });
  assert.equal(settings.seed.length, 80);
  assert.equal(settings.style, "contemporary");
  assert.equal(settings.key, 11);
  assert.equal(settings.tempo, 150);
  assert.equal(settings.bars, 64);
  assert.equal(settings.complexity, 0);
  assert.equal(settings.swing, 0.45);
  assert.equal(settings.humanize, 1);
});

test("events are sorted, bounded, well-formed, and span every section", () => {
  const song = generateSong({ seed: "invariants", style: "fusion", bars: 64, humanize: 1 });
  assert.equal(song.chords.length, song.bars);
  assert.equal(song.sections.reduce((sum, section) => sum + section.bars, 0), song.bars);
  for (const chord of song.chords) {
    assert.ok(chord.voicing.every((note, i, voices) => (i === 0 || note >= voices[i - 1] + 2) && note % 12 !== chord.root));
  }
  assert.ok(song.events.length > 0);
  for (let i = 0; i < song.events.length; i++) {
    const event = song.events[i];
    assert.ok(event.beat >= 0 && event.beat < song.totalBeats);
    assert.ok(event.duration > 0 && event.duration <= song.totalBeats - event.beat + 1e-9);
    assert.ok(event.velocity >= 0 && event.velocity <= 1);
    if (i) assert.ok(song.events[i - 1].beat <= event.beat);
    if (event.track === "drums") assert.ok(typeof event.drum === "string");
    else assert.ok(Number.isInteger(event.note));
  }
  for (const section of song.sections) {
    const start = section.startBar * 4, end = (section.startBar + section.bars) * 4;
    assert.ok(song.events.some(event => event.beat >= start && event.beat < end), `${section.name} should contain events`);
    assert.equal(sectionAtBeat(song, start)?.name, section.name);
  }
  const melody = song.events.filter(event => event.track === "lead");
  for (let i = 1; i < melody.length; i++) assert.ok(Math.abs(melody[i].note - melody[i - 1].note) <= 8);
  assert.equal(chordAtBeat(song, 0)?.bar, 0);
  assert.equal(sectionAtBeat(song, -1), null);
});

test("swing delays offbeat eighth notes across the ensemble", () => {
  const baseSettings = { seed: "swing-test", style: "fusion", bars: 32, complexity: 0, humanize: 0 };
  const straight = generateSong({ ...baseSettings, swing: 0 });
  const swung = generateSong({ ...baseSettings, swing: 0.4 });
  for (const track of ["keys", "bass", "drums"]) {
    const base = straight.events.find(event => event.track === track && Math.abs((event.beat % 1) - 0.5) < 1e-9);
    assert.ok(base, `expected an offbeat event for ${track}`);
    const result = swung.events.find(event => event.track === track && event.drum === base.drum && event.note === base.note && Math.abs(event.duration - base.duration) < 1e-9 && Math.abs(event.beat - (base.beat + 0.2)) < 1e-9);
    assert.ok(result, `${track} offbeat should be delayed by half the swing setting`);
  }
});

test("key complexity does not perturb existing drum timing", () => {
  const common = { seed: "independent-rng", style: "fusion", bars: 32, swing: 0.23, humanize: 0.8 };
  const quietKeys = generateSong({ ...common, complexity: 0 });
  const busyKeys = generateSong({ ...common, complexity: 1 });
  const identify = event => `${event.drum}:${event.beat.toFixed(5)}:${event.velocity.toFixed(5)}`;
  const busyDrums = new Set(busyKeys.events.filter(event => event.track === "drums").map(identify));
  for (const event of quietKeys.events.filter(event => event.track === "drums")) assert.ok(busyDrums.has(identify(event)));
});

test("theme develops across sections and ending resolves to a sustained tonic", () => {
  const song = generateSong({ seed: "form-and-ending", style: "contemporary", key: 7, bars: 32, humanize: 0 });
  const a = song.sections.find(section => section.name === "テーマ A");
  const b = song.sections.find(section => section.name === "テーマ B");
  const reprise = song.sections.find(section => section.name === "テーマ回帰");
  const leadNotes = section => song.events.filter(event => event.track === "lead" && event.beat >= section.startBar * 4 && event.beat < (section.startBar + section.bars) * 4).map(event => event.note);
  assert.notDeepEqual(leadNotes(a), leadNotes(b));
  assert.ok(reprise);
  const lastTwo = song.chords.slice(-2);
  assert.ok(lastTwo.every(chord => chord.root === song.settings.key));
  const endingStart = (song.bars - 1) * 4;
  const bass = song.events.filter(event => event.track === "bass" && event.beat >= endingStart);
  assert.equal(bass.length, 1);
  assert.equal(bass[0].note % 12, song.settings.key);
  assert.ok(bass[0].duration >= 3.7);
  assert.ok(song.events.some(event => event.track === "lead" && event.beat >= endingStart && event.duration >= 3.6));
  assert.ok(!song.events.some(event => event.track === "drums" && event.beat >= (song.bars - 2) * 4 && event.drum === "snare"));
});

test("piano-band styles retain their instruments, bounded events and cadence in every key and form", () => {
  for (const style of ["bloom", "carousel"]) for (let key = 0; key < 12; key++) for (const bars of [32, 64, 96]) {
    const song = generateSong({ style, key, bars, seed: "band-invariants", complexity: 1, swing: 0.45, humanize: 1 });
    assert.equal(song.chords.length, bars);
    assert.equal(song.sections.reduce((sum, section) => sum + section.bars, 0), bars);
    for (const section of song.sections) {
      const start = section.startBar * 4, end = start + section.bars * 4;
      assert.ok(song.events.some(event => event.track === "lead" && event.beat >= start && event.beat < end));
    }
    for (let i = 0; i < song.events.length; i++) {
      const event = song.events[i];
      assert.ok(Number.isFinite(event.beat) && event.beat >= 0 && event.beat < song.totalBeats);
      assert.ok(event.duration > 0 && event.beat + event.duration <= song.totalBeats + 1e-9);
      assert.ok(event.velocity > 0 && event.velocity <= 1);
      if (i) assert.ok(song.events[i - 1].beat <= event.beat);
      if (event.track !== "drums") assert.ok(Number.isInteger(event.note) && event.note >= 0 && event.note <= 127);
      if (song.instruments[event.track]) assert.equal(event.timbre, song.instruments[event.track]);
    }
    assert.ok(song.chords.slice(-2).every(chord => chord.root === key));
    const finalBass = song.events.filter(event => event.track === "bass" && event.beat >= (bars - 1) * 4 - 0.023);
    assert.equal(finalBass.length, 1);
    assert.equal(finalBass[0].note % 12, key);
    assert.ok(finalBass[0].duration >= 3.7);
  }
});

test("band themes span complete phrases, develop, grow in energy and change with the seed", () => {
  for (const style of ["bloom", "carousel"]) {
    const song = generateSong({ seed: "band-theme", style, humanize: 0, swing: 0, bars: 32 });
    const a = song.sections.find(section => section.name === "テーマ A"), b = song.sections.find(section => section.name === "テーマ B");
    const phraseNotes = section => song.events.filter(event => event.track === "lead" && event.beat >= section.startBar * 4 && event.beat < (section.startBar + 4) * 4);
    const theme = phraseNotes(a);
    for (let bar = a.startBar; bar < a.startBar + 4; bar++) assert.ok(theme.some(event => Math.floor(event.beat / 4) === bar), "each theme bar contains a melody");
    assert.notDeepEqual(theme.map(event => event.note), phraseNotes(b).map(event => event.note));
    const averageLeadVelocity = section => {
      const notes = song.events.filter(event => event.track === "lead" && event.beat >= section.startBar * 4 && event.beat < (section.startBar + section.bars) * 4);
      return notes.reduce((sum, event) => sum + event.velocity, 0) / notes.length;
    };
    assert.ok(averageLeadVelocity(song.sections.find(section => section.name === "テーマ回帰")) > averageLeadVelocity(song.sections[0]) * 2);
    const themes = new Set(Array.from({ length: 8 }, (_, i) => {
      const variant = generateSong({ ...song.settings, seed: "band-variation-" + i });
      return variant.events.filter(event => event.track === "lead" && event.beat >= a.startBar * 4 && event.beat < (a.startBar + 4) * 4).map(event => event.note).join(",");
    }));
    assert.ok(themes.size >= 3, "different seeds must produce different melodic phrases");
    if (style === "carousel") {
      const responseStart = (a.startBar + 3) * 4 + 2.5;
      assert.ok(theme.every(event => event.beat + event.duration < responseStart), "piano leaves room for the guitar answer");
      assert.ok(song.events.some(event => event.track === "keys" && event.beat >= responseStart && event.beat < (a.startBar + 4) * 4));
    }
  }
});
