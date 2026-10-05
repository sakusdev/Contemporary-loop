/* Deterministic, client-side contemporary jazz composition. */

export const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

export const STYLE_PRESETS = {
  contemporary: { name: "コンテンポラリー", description: "浮遊感のあるコードと余白のあるグルーヴ", tempo: 94, swing: 0.12 },
  fusion: { name: "ジャズ・フュージョン", description: "しなやかなベースと熱を帯びたリズム", tempo: 108, swing: 0.08 },
  nocturne: { name: "ノクターン", description: "夜更けの静けさをたたえたスロウ・ジャズ", tempo: 72, swing: 0.18 },
  bossa: { name: "ボサ・ジャズ", description: "柔らかなシンコペーションと軽やかな揺れ", tempo: 112, swing: 0.05 },
};

export const DEFAULT_SETTINGS = {
  seed: "blue-hour-01", style: "contemporary", key: 4, tempo: 94,
  bars: 32, complexity: 0.55, swing: 0.12, humanize: 0.5,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mod = (n, m) => ((n % m) + m) % m;
const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)];

function hashSeed(value) {
  const s = String(value ?? DEFAULT_SETTINGS.seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rngFor(seed, label) {
  let state = (hashSeed(seed) ^ hashSeed(label)) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeSettings(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const style = Object.hasOwn(STYLE_PRESETS, raw.style) ? raw.style : DEFAULT_SETTINGS.style;
  const preset = STYLE_PRESETS[style];
  const numeric = (v, fallback, lo, hi) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
  };
  const allowedBars = [32, 64, 96];
  const wantedBars = Math.round(numeric(raw.bars, DEFAULT_SETTINGS.bars, 32, 96));
  const bars = allowedBars.reduce((best, n) => Math.abs(n - wantedBars) < Math.abs(best - wantedBars) ? n : best, allowedBars[0]);
  const key = Math.round(numeric(raw.key, DEFAULT_SETTINGS.key, 0, 11));
  return {
    seed: String(raw.seed ?? DEFAULT_SETTINGS.seed).slice(0, 80) || DEFAULT_SETTINGS.seed,
    style,
    key: mod(key, 12),
    tempo: Math.round(numeric(raw.tempo, preset.tempo, 60, 150)),
    bars,
    complexity: numeric(raw.complexity, DEFAULT_SETTINGS.complexity, 0, 1),
    swing: numeric(raw.swing, preset.swing, 0, 0.45),
    humanize: numeric(raw.humanize, DEFAULT_SETTINGS.humanize, 0, 1),
  };
}

const MODES = {
  contemporary: [0, 2, 3, 5, 7, 9, 10], // Dorian
  fusion: [0, 2, 4, 6, 7, 9, 10], // Lydian dominant color
  nocturne: [0, 2, 3, 5, 7, 8, 10], // Aeolian
  bossa: [0, 2, 4, 5, 7, 9, 10], // Mixolydian
};

const CHORD_TYPES = {
  min9: { label: "m9", tones: [0, 3, 7, 10, 14], piano: [3, 7, 10, 14] },
  min11: { label: "m11", tones: [0, 3, 7, 10, 14, 17], piano: [3, 7, 10, 14, 17] },
  maj9: { label: "maj9", tones: [0, 4, 7, 11, 14], piano: [4, 7, 11, 14] },
  maj9s11: { label: "maj9♯11", tones: [0, 4, 7, 11, 14, 18], piano: [4, 7, 11, 14, 18] },
  dom13sus: { label: "13sus", tones: [0, 5, 7, 10, 14, 21], piano: [5, 7, 10, 14, 21] },
  dom9: { label: "9", tones: [0, 4, 7, 10, 14], piano: [4, 7, 10, 14] },
  dom7alt: { label: "7alt", tones: [0, 4, 6, 10, 13], piano: [4, 6, 10, 13] },
  sixNine: { label: "6/9", tones: [0, 4, 7, 9, 14], piano: [4, 7, 9, 14] },
  dim9: { label: "m7♭5(9)", tones: [0, 3, 6, 10, 14], piano: [3, 6, 10, 14] },
};

const ROOTS = {
  contemporary: [0, 5, 3, 4, 0, 2, 5, 4],
  fusion: [0, 3, 5, 4, 0, 6, 2, 5],
  nocturne: [0, 5, 3, 4, 0, 2, 5, 0],
  bossa: [0, 5, 1, 4, 0, 3, 2, 5],
};

function chordType(style, degree, barInLoop, section, rng, complexity) {
  const byStyle = {
    contemporary: ["min11", "dom13sus", "maj9s11", "min9", "maj9s11", "dom9", "dim9", "dom13sus"],
    fusion: ["min9", "dom9", "maj9s11", "dom13sus", "min11", "dom7alt", "dim9", "dom9"],
    nocturne: ["min9", "maj9", "min11", "dom9", "maj9", "dim9", "min9", "dom9"],
    bossa: ["min9", "dom13sus", "maj9", "dom9", "maj9", "min9", "dim9", "dom9"],
  };
  if (section === "intro" && barInLoop === 0) return style === "nocturne" ? "min9" : "min11";
  if (section === "ending" && barInLoop === 0) return "min9";
  let type = byStyle[style][degree % 8];
  if (complexity < 0.28 && type === "dom7alt") type = "dom9";
  if (complexity > 0.68 && rng() < (complexity - 0.6) * 0.35) type = "dom7alt";
  return type;
}

function makeForm(bars) {
  if (bars === 32) return [
    { name: "イントロ", section: "intro", startBar: 0, bars: 2 },
    { name: "テーマ A", section: "A", startBar: 2, bars: 8 },
    { name: "テーマ B", section: "B", startBar: 10, bars: 8 },
    { name: "ソロ", section: "solo", startBar: 18, bars: 8 },
    { name: "テーマ回帰", section: "reprise", startBar: 26, bars: 4 },
    { name: "エンディング", section: "ending", startBar: 30, bars: 2 },
  ];
  if (bars === 64) return [
    { name: "イントロ", section: "intro", startBar: 0, bars: 4 },
    { name: "テーマ A", section: "A", startBar: 4, bars: 16 },
    { name: "テーマ B", section: "B", startBar: 20, bars: 8 },
    { name: "ソロ", section: "solo", startBar: 28, bars: 20 },
    { name: "テーマ回帰", section: "reprise", startBar: 48, bars: 12 },
    { name: "エンディング", section: "ending", startBar: 60, bars: 4 },
  ];
  return [
    { name: "イントロ", section: "intro", startBar: 0, bars: 4 },
    { name: "テーマ A", section: "A", startBar: 4, bars: 16 },
    { name: "テーマ B", section: "B", startBar: 20, bars: 16 },
    { name: "ソロ", section: "solo", startBar: 36, bars: 36 },
    { name: "テーマ回帰", section: "reprise", startBar: 72, bars: 20 },
    { name: "エンディング", section: "ending", startBar: 92, bars: 4 },
  ];
}

function voiceChord(root, intervals, previous) {
  let best = null, bestCost = Infinity;
  const search = (index, result, cost) => {
    if (index === intervals.length) {
      if (cost < bestCost) { bestCost = cost; best = result.slice(); }
      return;
    }
    const target = 60 + root + intervals[index];
    const reference = previous[index] ?? target;
    for (let octave = -2; octave <= 2; octave++) {
      const note = target + octave * 12;
      if (note < 52 || note > 84 || (result.length && note < result.at(-1) + 2)) continue;
      const nextCost = cost + Math.abs(note - reference) + Math.abs(note - target) * 0.12;
      if (nextCost < bestCost) search(index + 1, [...result, note], nextCost);
    }
  };
  search(0, [], 0);
  return best ?? intervals.map(interval => 60 + root + interval);
}

function buildChords(settings, sections, rng) {
  const chords = [];
  const mode = MODES[settings.style];
  const roots = ROOTS[settings.style];
  let prior = [60, 64, 67, 71, 74];
  for (let bar = 0; bar < settings.bars; bar++) {
    const sec = sections.find(s => bar >= s.startBar && bar < s.startBar + s.bars);
    const position = bar - sec.startBar;
    let degree = roots[position % roots.length];
    if (sec.section === "B") degree = roots[(position + 3) % roots.length];
    if (sec.section === "solo") degree = roots[(position + Math.floor(position / 4) + 2) % roots.length];
    if (sec.section === "reprise") degree = roots[position % roots.length];
    if (sec.section === "ending") degree = position >= sec.bars - 2 ? 0 : roots[(position + 1) % roots.length];
    const typeKey = chordType(settings.style, degree, position % roots.length, sec.section, rng, settings.complexity);
    const type = CHORD_TYPES[typeKey];
    const root = mod(settings.key + mode[degree % 7], 12);
    const voicing = voiceChord(root, type.piano, prior);
    prior = voicing;
    const chord = {
      bar, beat: bar * 4, duration: 4, root, quality: typeKey,
      name: `${NOTE_NAMES[root]}${type.label}`, voicing,
      tones: type.tones.map(i => mod(root + i, 12)),
    };
    chords.push(chord);
  }
  return chords;
}

function generateSong(input = {}) {
  const settings = normalizeSettings(input);
  const sections = makeForm(settings.bars);
  const chordRng = rngFor(settings.seed, "harmony");
  const chords = buildChords(settings, sections, chordRng);
  const events = [];
  const trackRng = {
    keys: rngFor(settings.seed, "keys"), bass: rngFor(settings.seed, "bass"),
    drums: rngFor(settings.seed, "drums"), lead: rngFor(settings.seed, "lead"),
  };
  const modeIntervals = MODES[settings.style];
  const scale = modeIntervals.map(n => mod(settings.key + n, 12));
  const totalBeats = settings.bars * 4;
  const humanAmount = settings.humanize * 0.022;
  const add = (track, beat, duration, payload, velocity, pan = 0) => {
    if (beat >= totalBeats) return;
    const fraction = beat - Math.floor(beat);
    const swung = fraction === 0.5 ? fraction + settings.swing * 0.5 : fraction;
    const timingKey = `${track}:${beat.toFixed(4)}:${payload.note ?? payload.drum ?? "event"}`;
    const timingOffset = rngFor(settings.seed, timingKey)() * 2 - 1;
    const shifted = beat + (swung - fraction) + timingOffset * humanAmount;
    const onset = clamp(shifted, 0, Math.max(0, totalBeats - 0.001));
    events.push({ track, beat: onset, duration: Math.max(0.04, Math.min(duration, totalBeats - onset)), ...payload,
      velocity: clamp(velocity, 0.03, 1), ...(pan ? { pan } : {}) });
  };
  const sectionFor = bar => sections.find(s => bar >= s.startBar && bar < s.startBar + s.bars);
  const chordFor = bar => chords[clamp(bar, 0, chords.length - 1)];

  // Warm, sparse electric-piano comping with a consistent syncopated language.
  for (let bar = 0; bar < settings.bars; bar++) {
    const sec = sectionFor(bar), local = bar - sec.startBar, chord = chordFor(bar), rng = trackRng.keys;
    const density = settings.complexity;
    let hits = [0.5, 2.5];
    if (settings.style === "nocturne") hits = [1.5, 3];
    if (settings.style === "bossa") hits = [0.5, 2, 3.5];
    if (settings.style === "fusion") hits = [0, 1.5, 2.75];
    if (rng() < density * 0.52) hits.push(pick(rng, [0.75, 1.75, 2.25, 3.25]));
    if (sec.section === "intro" && local < sec.bars - 1) hits = local % 2 ? [] : [2.5];
    if (sec.section === "ending") hits = local === sec.bars - 1 ? [0] : [0.5, 2.5];
    if (sec.section === "solo") hits = hits.filter((_, i) => i === 0 || rng() > 0.35);
    for (const beatInBar of hits) {
      const chordAt = chordFor(Math.min(settings.bars - 1, bar));
      chordAt.voicing.forEach((note, i) => add("keys", bar * 4 + beatInBar, 0.32 + rng() * 0.22,
        { note }, (sec.section === "intro" ? 0.25 : sec.section === "ending" ? 0.32 : 0.31 + rng() * 0.2) * (i === 0 ? 1 : 0.82), -0.18 + i * 0.08));
    }
  }

  // Bass plays a composed ostinato, using fifths/octaves and chromatic approaches into roots.
  for (let bar = 0; bar < settings.bars; bar++) {
    const sec = sectionFor(bar), local = bar - sec.startBar, chord = chordFor(bar), rng = trackRng.bass;
    const rootMidi = 36 + chord.root;
    const sparseIntro = sec.section === "intro" && local < sec.bars - 1;
    if (!sparseIntro) {
      let pattern = settings.style === "nocturne" ? [0, 2.5] : settings.style === "bossa" ? [0, 1.5, 2, 3] : settings.style === "fusion" ? [0, 1.5, 2.5, 3.5] : [0, 1.5, 2.5];
      if (sec.section === "ending" && local === sec.bars - 1) pattern = [0];
      for (let i = 0; i < pattern.length; i++) {
        const beatInBar = pattern[i];
        let note = rootMidi;
        if (i === 1 || (settings.style === "bossa" && i === 2)) note += rng() < 0.72 ? 7 : 12;
        if (i === pattern.length - 1 && bar < settings.bars - 1 && rng() < 0.58) {
          const nextRoot = chordFor(bar + 1).root;
          const delta = mod(nextRoot - chord.root, 12);
          note = rootMidi + (delta <= 6 ? delta - 1 : delta + 1);
        }
        if (settings.style === "fusion" && i === 2 && rng() < 0.45) note += 12;
        if (sec.section === "ending" && local === sec.bars - 1) note = rootMidi;
        const dur = sec.section === "ending" && local === sec.bars - 1 ? 3.8 : settings.style === "nocturne" ? 0.8 : settings.style === "bossa" ? 0.42 : 0.5;
        add("bass", bar * 4 + beatInBar, dur, { note: clamp(note, 32, 60) }, (i === 0 ? 0.66 : 0.48) + rng() * 0.12, 0.04);
      }
    }
  }

  // A shared groove skeleton, colored by style; fills are rare and only at phrase ends.
  for (let bar = 0; bar < settings.bars; bar++) {
    const sec = sectionFor(bar), local = bar - sec.startBar, rng = trackRng.drums;
    const fillRng = rngFor(settings.seed, `drum-fill-${bar}`);
    const quiet = sec.section === "intro" && local < sec.bars - 1;
    const final = sec.section === "ending" && local === sec.bars - 1;
    const kickHits = final ? [0] : settings.style === "nocturne" ? [0, 2.5] : settings.style === "bossa" ? [0, 2] : settings.style === "fusion" ? [0, 1.5, 3] : [0, 2.5];
    const snareHits = sec.section === "ending" ? [] : settings.style === "nocturne" ? [2] : settings.style === "bossa" ? [1, 3] : [1, 3];
    if (!quiet) {
      for (const b of kickHits) if (rng() > (sec.section === "solo" ? 0.12 : 0.05)) add("drums", bar * 4 + b, 0.16, { drum: "kick" }, 0.62 + rng() * 0.2);
      for (const b of snareHits) if (rng() > 0.08) add("drums", bar * 4 + b, 0.13, { drum: settings.style === "bossa" ? "rim" : "snare" }, 0.34 + rng() * 0.18);
    } else if (local % 2 === 1) {
      add("drums", bar * 4 + 3, 0.1, { drum: "hat" }, 0.18);
    }
    const hatStep = settings.style === "fusion" || settings.style === "bossa" ? 0.5 : 1;
    for (let b = 0; b < 4; b += hatStep) {
      if (final) continue;
      if (quiet && b < 3) continue;
      if (rng() < (settings.style === "nocturne" ? 0.42 : 0.78)) {
        const isOpen = !quiet && b >= 3.5 && rng() < 0.08;
        add("drums", bar * 4 + b, 0.08, { drum: isOpen ? "openHat" : settings.style === "bossa" ? "shaker" : "hat" }, (b % 1 === 0 ? 0.23 : 0.14) + rng() * 0.1, 0.12);
      }
    }
    if (final) add("drums", bar * 4, 0.2, { drum: "ride" }, 0.35);
    const phraseEnd = (bar + 1) % 4 === 0;
    if (!quiet && !final && phraseEnd && fillRng() < 0.48 * settings.complexity) {
      add("drums", bar * 4 + 3.5, 0.08, { drum: fillRng() < 0.6 ? "tom" : "rim" }, 0.24 + fillRng() * 0.14);
    }
  }

  // Construct a two-bar motif then develop it with transposition, sequence, rests and cadence tones.
  const melodyRng = trackRng.lead;
  const rhythmCells = [
    [{ at: 0, len: 0.75 }, { at: 1.25, len: 0.5 }, { at: 2, len: 1 }, { at: 3.5, len: 0.45 }, { at: 4, len: 0.7 }, { at: 5.5, len: 0.5 }, { at: 6.25, len: 0.8 }, { at: 7.5, len: 0.4 }],
    [{ at: 0.5, len: 0.5 }, { at: 1.5, len: 0.8 }, { at: 3, len: 0.7 }, { at: 4, len: 1 }, { at: 5.5, len: 0.45 }, { at: 6.5, len: 0.55 }, { at: 7, len: 0.7 }],
    [{ at: 0, len: 1.2 }, { at: 1.75, len: 0.5 }, { at: 2.5, len: 0.45 }, { at: 4.5, len: 0.55 }, { at: 5.5, len: 1 }, { at: 7, len: 0.55 }],
  ];
  const cell = pick(melodyRng, rhythmCells);
  const contour = [];
  for (let i = 0; i < cell.length; i++) {
    const step = pick(melodyRng, [-2, -1, 0, 1, 2]);
    contour.push(clamp((contour[i - 1] ?? 0) + step, -5, 5));
  }
  const phraseBars = settings.style === "nocturne" ? 4 : 4;
  let previousNote = null;
  for (const sec of sections) {
    if (!["A", "B", "solo", "reprise"].includes(sec.section)) continue;
    for (let phraseStart = sec.startBar; phraseStart < sec.startBar + sec.bars; phraseStart += phraseBars) {
      const phraseNo = Math.floor((phraseStart - sec.startBar) / phraseBars);
      const phraseEnd = Math.min(sec.startBar + sec.bars, phraseStart + phraseBars);
      const isTheme = sec.section === "A" || sec.section === "reprise";
      const busier = sec.section === "solo";
      if (sec.section === "solo" && melodyRng() < 0.16) continue;
      const transpose = sec.section === "B" ? (phraseNo % 2 ? -2 : 2) : sec.section === "reprise" ? 0 : (phraseNo % 3 === 1 ? 2 : 0);
      for (let i = 0; i < cell.length; i++) {
        const localBeat = cell[i].at + (phraseNo % 2 ? 0.12 : 0);
        const absoluteBeat = phraseStart * 4 + localBeat;
        if (Math.floor(absoluteBeat / 4) >= phraseEnd) continue;
        const bar = Math.floor(absoluteBeat / 4), chord = chordFor(bar);
        // Wide but singable register, with deliberate motif contour and slight phrase variation.
        let scaleStep = contour[i] + transpose + (phraseNo % 2 && i > 3 ? -1 : 0);
        if (i === cell.length - 1) scaleStep = 0;
        let note = 60 + settings.key + modeIntervals[mod(scaleStep, 7)] + Math.floor(scaleStep / 7) * 12;
        // Pick nearest available scale pitch in the target range.
        const candidates = [];
        for (let n = 62; n <= 82; n++) if (scale.includes(mod(n, 12))) candidates.push(n);
        const inRange = candidates.filter(n => previousNote == null || Math.abs(n - previousNote) <= 8);
        const melodicCandidates = inRange.length ? inRange : candidates;
        const nearestMelody = (pool, target) => pool.slice().sort((a, b) => {
          const scoreA = Math.abs(a - target) + (previousNote == null ? 0 : Math.abs(a - previousNote) * 0.35);
          const scoreB = Math.abs(b - target) + (previousNote == null ? 0 : Math.abs(b - previousNote) * 0.35);
          return scoreA - scoreB;
        })[0];
        note = nearestMelody(melodicCandidates, note) ?? 69;
        const beatWithin = absoluteBeat - bar * 4;
        const chordCandidates = melodicCandidates.filter(n => chord.tones.includes(mod(n, 12)));
        const chordTone = chord.tones.includes(mod(note, 12));
        const strongBeat = Math.abs(beatWithin - Math.round(beatWithin)) < 0.001 && Math.round(beatWithin) % 2 === 0;
        if (chordCandidates.length && (strongBeat || i === 0 || i === cell.length - 1 || (!chordTone && melodyRng() < 0.68))) {
          note = nearestMelody(chordCandidates, note);
        }
        const noteLen = cell[i].len * (busier && melodyRng() < 0.25 ? 0.72 : 1);
        if (!busier && melodyRng() < 0.11) continue;
        const velocity = (isTheme ? 0.49 : busier ? 0.45 : 0.42) + melodyRng() * 0.16;
        add("lead", absoluteBeat, noteLen, { note: clamp(note, 60, 84) }, velocity, 0.2);
        previousNote = note;
      }
    }
  }

  const endingChord = chords.at(-1);
  const endingCandidates = [];
  for (let n = 67; n <= 79; n++) if (endingChord.tones.includes(mod(n, 12))) endingCandidates.push(n);
  const endingNote = endingCandidates.sort((a, b) => Math.abs(a - (previousNote ?? 74)) - Math.abs(b - (previousNote ?? 74)))[0] ?? 74;
  add("lead", (settings.bars - 1) * 4, 3.7, { note: endingNote }, 0.4, 0.2);

  events.sort((a, b) => a.beat - b.beat || ["drums", "bass", "keys", "lead"].indexOf(a.track) - ["drums", "bass", "keys", "lead"].indexOf(b.track));
  const titleWords = ["Blue Hour", "Glass Garden", "Soft Signals", "Afterglow", "Quiet Current", "Open Sky"];
  const title = `${pick(rngFor(settings.seed, "title"), titleWords)} · ${NOTE_NAMES[settings.key]}`;
  const publicChords = chords.map(({ tones, ...chord }) => chord);
  return { title, seed: settings.seed, settings, bars: settings.bars, totalBeats, events, chords: publicChords,
    sections: sections.map(({ name, startBar, bars: length }) => ({ name, startBar, bars: length })) };
}

function sectionAtBeat(song, beat) {
  if (!song || !Array.isArray(song.sections) || !Number.isFinite(beat) || beat < 0) return null;
  const bar = Math.floor(beat / 4);
  return song.sections.find(section => bar >= section.startBar && bar < section.startBar + section.bars) ?? null;
}

function chordAtBeat(song, beat) {
  if (!song || !Array.isArray(song.chords) || !Number.isFinite(beat) || beat < 0) return null;
  const bar = Math.floor(beat / 4);
  return song.chords.find(chord => chord.bar === bar) ?? song.chords.at(-1) ?? null;
}

export { generateSong, sectionAtBeat, chordAtBeat };
