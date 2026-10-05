/*
 * Small, dependency-free Web Audio engine for generated jazz arrangements.
 * Browser globals are intentionally only read inside methods so this module
 * can also be imported by Node based tooling.
 */

const TRACKS = ["keys", "bass", "drums", "lead"];
const DEFAULT_LEVELS = { keys: 0.75, bass: 0.8, drums: 0.65, lead: 0.65 };
const DEFAULT_TEMPO = 110;
const SCHEDULER_MS = 25;
const LOOKAHEAD = 0.15;
const TAIL_SECONDS = 2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const midiHz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

function audioContextConstructor() {
  if (typeof window === "undefined") return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function safeSet(param, value, time) {
  try { param.setValueAtTime(value, time); } catch (_) { param.value = value; }
}

function ramp(param, value, time) {
  try { param.linearRampToValueAtTime(value, time); } catch (_) { param.value = value; }
}

function makeImpulse(context) {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * 1.35));
  const buffer = context.createBuffer(2, length, rate);
  // Deterministic, exponentially decaying noise creates a short, soft room.
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let seed = 0x4a415a + channel * 7919;
    for (let i = 0; i < length; i += 1) {
      seed = (seed * 16807) % 2147483647;
      const noise = (seed / 1073741823.5) - 1;
      data[i] = noise * Math.pow(1 - i / length, 3.8) * 0.72;
    }
  }
  return buffer;
}

function makeNoise(context) {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x13579b;
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 48271) % 2147483647;
    data[i] = ((seed / 1073741823.5) - 1) * 0.65;
  }
  return buffer;
}

function buildGraph(context, options = {}) {
  const master = context.createGain();
  const compressor = context.createDynamicsCompressor();
  const analyser = context.createAnalyser();
  const dry = context.createGain();
  const reverbSend = context.createGain();
  const convolver = context.createConvolver();
  const wet = context.createGain();
  const noise = makeNoise(context);

  // Leave headroom before compression; generated arrangements can be dense.
  master.gain.value = 0.62 * clamp(options.volume ?? 0.75, 0, 1);
  compressor.threshold.value = -15;
  compressor.knee.value = 20;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.18;
  analyser.fftSize = 2048;
  dry.connect(master);
  reverbSend.connect(convolver);
  convolver.buffer = makeImpulse(context);
  convolver.connect(wet);
  wet.connect(master);
  master.connect(compressor);
  compressor.connect(analyser);
  analyser.connect(context.destination);

  const reverb = clamp(options.reverb ?? 0.18, 0, 1);
  reverbSend.gain.value = reverb * 0.35;
  wet.gain.value = 0.42;

  const tracks = {};
  for (const name of TRACKS) {
    const node = context.createGain();
    const level = (options.levels || DEFAULT_LEVELS)[name] ?? DEFAULT_LEVELS[name];
    node.gain.value = options.muted?.[name] ? 0 : clamp(level, 0, 1);
    node.connect(dry);
    node.connect(reverbSend);
    tracks[name] = node;
  }
  return { context, master, analyser, tracks, reverbSend, wet, noise, voices: new Set() };
}

function eventPan(event, track) {
  if (event.pan !== undefined && event.pan !== null && Number.isFinite(Number(event.pan))) {
    return clamp(Number(event.pan), -1, 1);
  }
  if (track === "keys") return -0.14;
  if (track === "lead") return 0.14;
  return 0;
}

function beginVoice(graph, track, at, velocity, pan = 0) {
  const context = graph.context;
  const bus = context.createGain();
  const panner = typeof context.createStereoPanner === "function"
    ? context.createStereoPanner()
    : null;
  const sources = [];
  const nodes = panner ? [bus, panner] : [bus];
  let remaining = 0;
  let cleaned = false;
  const voice = {
    bus,
    sources,
    nodes,
    at,
    add(node) { nodes.push(node); return node; },
    source(node, startAt, stopAt) {
      sources.push(node);
      remaining += 1;
      node.onended = () => {
        try { node.disconnect(); } catch (_) { /* already disconnected */ }
        remaining -= 1;
        if (remaining <= 0) clean();
      };
      node.start(startAt);
      if (Number.isFinite(stopAt)) node.stop(stopAt);
    },
    cancel(time) {
      if (cleaned) return;
      const fadeEnd = time + 0.012;
      try {
        bus.gain.cancelScheduledValues(time);
        bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), time);
        bus.gain.linearRampToValueAtTime(0, fadeEnd);
      } catch (_) { bus.gain.value = 0; }
      for (const source of sources) {
        try { source.stop(fadeEnd); } catch (_) { /* source already ended */ }
      }
      // Covers voices whose sources have not started yet and engines that do
      // not dispatch `ended` after a context suspension.
      setTimeout(() => clean(), 60);
    },
  };
  const clean = () => {
    if (cleaned) return;
    cleaned = true;
    graph.voices.delete(voice);
    for (const node of nodes) {
      try { node.disconnect(); } catch (_) { /* already disconnected */ }
    }
  };
  voice.clean = clean;
  bus.gain.value = clamp(velocity, 0, 1);
  if (panner) {
    safeSet(panner.pan, clamp(pan, -1, 1), at);
    bus.connect(panner);
    panner.connect(graph.tracks[track] || graph.tracks.keys);
  } else {
    bus.connect(graph.tracks[track] || graph.tracks.keys);
  }
  graph.voices.add(voice);
  return voice;
}

function envelope(param, at, peak, attack, hold, release) {
  safeSet(param, 0, at);
  ramp(param, Math.max(0.0001, peak), at + attack);
  ramp(param, Math.max(0.0001, peak * 0.76), at + attack + hold);
  ramp(param, 0, at + attack + hold + release);
}

function osc(context, voice, type, frequency, at, stopAt) {
  const oscillator = voice.add(context.createOscillator());
  oscillator.type = type;
  safeSet(oscillator.frequency, frequency, at);
  voice.source(oscillator, at, stopAt);
  return oscillator;
}

function gain(context, voice, value = 1) {
  const node = voice.add(context.createGain());
  node.gain.value = value;
  return node;
}

function filter(context, voice, type, frequency, q = 0.7) {
  const node = voice.add(context.createBiquadFilter());
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  return node;
}

function noiseVoice(graph, voice, at, length, filterType, cutoff, q = 0.7) {
  const source = voice.add(graph.context.createBufferSource());
  source.buffer = graph.noise;
  source.loop = true;
  const shaped = filter(graph.context, voice, filterType, cutoff, q);
  source.connect(shaped);
  voice.source(source, at, at + length);
  return shaped;
}

function scheduleDrum(graph, event, at, beatSeconds) {
  const context = graph.context;
  const drum = event.drum || "hat";
  const velocity = clamp(event.velocity ?? 0.72, 0.04, 1);
  const voice = beginVoice(graph, "drums", at, velocity, eventPan(event, "drums"));
  let life = 0.2;

  if (drum === "kick") {
    life = 0.34;
    const body = osc(context, voice, "sine", 130, at, at + life);
    safeSet(body.frequency, 130, at);
    ramp(body.frequency, 48, at + 0.14);
    const bodyEnv = gain(context, voice, 0.8);
    envelope(bodyEnv.gain, at, 0.95, 0.004, 0.025, 0.25);
    body.connect(bodyEnv);
    bodyEnv.connect(voice.bus);
    const click = noiseVoice(graph, voice, at, 0.025, "highpass", 2200);
    const clickEnv = gain(context, voice, 0.35);
    envelope(clickEnv.gain, at, 0.28, 0.001, 0.003, 0.018);
    click.connect(clickEnv);
    clickEnv.connect(voice.bus);
  } else if (drum === "snare" || drum === "rim") {
    life = drum === "rim" ? 0.12 : 0.28;
    const noiseFilter = noiseVoice(graph, voice, at, life, "highpass", drum === "rim" ? 1300 : 900, 0.6);
    const noiseEnv = gain(context, voice, 0.7);
    envelope(noiseEnv.gain, at, drum === "rim" ? 0.24 : 0.55, 0.002, 0.012, drum === "rim" ? 0.075 : 0.2);
    noiseFilter.connect(noiseEnv);
    noiseEnv.connect(voice.bus);
    if (drum === "snare") {
      const tone = osc(context, voice, "triangle", 185, at, at + 0.13);
      const toneEnv = gain(context, voice, 0.24);
      envelope(toneEnv.gain, at, 0.25, 0.002, 0.018, 0.095);
      tone.connect(toneEnv);
      toneEnv.connect(voice.bus);
    } else {
      const tone = osc(context, voice, "sine", 950, at, at + 0.07);
      const toneEnv = gain(context, voice, 0.3);
      envelope(toneEnv.gain, at, 0.3, 0.001, 0.003, 0.045);
      tone.connect(toneEnv);
      toneEnv.connect(voice.bus);
    }
  } else if (drum === "tom") {
    life = 0.38;
    const tone = osc(context, voice, "sine", 190, at, at + life);
    ramp(tone.frequency, 92, at + 0.24);
    const toneEnv = gain(context, voice, 0.72);
    envelope(toneEnv.gain, at, 0.62, 0.003, 0.045, 0.3);
    tone.connect(toneEnv);
    toneEnv.connect(voice.bus);
  } else {
    const open = drum === "openHat" || drum === "ride";
    const shaker = drum === "shaker";
    life = drum === "ride" ? 0.7 : open ? 0.42 : shaker ? 0.13 : 0.09;
    const cutoff = drum === "ride" ? 6200 : shaker ? 5400 : 7600;
    const noiseFilter = noiseVoice(graph, voice, at, life, "highpass", cutoff, drum === "ride" ? 1.1 : 0.6);
    const env = gain(context, voice, 0.5);
    envelope(env.gain, at, drum === "ride" ? 0.2 : shaker ? 0.12 : 0.22, 0.001, 0.006, life - 0.012);
    noiseFilter.connect(env);
    env.connect(voice.bus);
    if (drum === "ride") {
      // Quiet inharmonic metal partials soften the filtered-noise body.
      for (const ratio of [1, 1.48, 1.97, 2.51]) {
        const partial = osc(context, voice, "sine", 3300 * ratio, at, at + life * 0.72);
        const partialEnv = gain(context, voice, 0.08 / ratio);
        envelope(partialEnv.gain, at, 0.065 / ratio, 0.002, 0.02, life * 0.64);
        partial.connect(partialEnv);
        partialEnv.connect(voice.bus);
      }
    }
  }
  // If a malformed event leaves no source, release it on a bounded timer.
  if (!voice.sources.length) setTimeout(voice.clean, (life + 0.1) * 1000);
  return voice;
}

function pluckEnvelope(param, at, peak, attack, decay, sustain, hold, release) {
  safeSet(param, 0, at);
  ramp(param, Math.max(0.0001, peak), at + attack);
  ramp(param, Math.max(0.0001, peak * sustain), at + attack + decay);
  ramp(param, Math.max(0.0001, peak * sustain), at + attack + decay + hold);
  ramp(param, 0, at + attack + decay + hold + release);
}

function pluckTimes(duration, attack, decay) {
  const shapedAttack = Math.min(attack, duration * 0.2);
  const shapedDecay = Math.min(decay, Math.max(0.003, (duration - shapedAttack) * 0.55));
  return { attack: shapedAttack, decay: shapedDecay, hold: Math.max(0.003, duration - shapedAttack - shapedDecay) };
}

function scheduleTimbre(graph, event, at, beatSeconds, timbre) {
  const context = graph.context;
  const track = TRACKS.includes(event.track) ? event.track : "keys";
  const velocity = clamp(event.velocity ?? 0.68, 0.03, 1);
  const frequency = midiHz(clamp(Math.round(event.note ?? 60), 0, 127));
  const duration = clamp(Number(event.duration) * beatSeconds || 0.2, 0.035, 12);
  const atEnd = at + duration;
  const release = timbre === "piano" ? 0.19 : timbre === "guitar" ? 0.14 : 0.16;
  const stopAt = atEnd + release + 0.012;
  const voice = beginVoice(graph, track, at, velocity, eventPan(event, track));
  const brightness = 0.55 + velocity * 0.7;

  if (timbre === "piano") {
    // A small set of partials with independent decay approximates hammer/tine
    // brightness while the low-passed fundamental keeps the body round.
    const bodyFilter = filter(context, voice, "lowpass", frequency * (5.5 + brightness * 2), 0.65);
    const partials = [
      { ratio: 1, level: 0.37, attack: 0.006, decay: 0.12, sustain: 0.69 },
      { ratio: 2.01, level: 0.115 * brightness, attack: 0.002, decay: 0.075, sustain: 0.45 },
      { ratio: 3.98, level: 0.036 * brightness, attack: 0.001, decay: 0.045, sustain: 0.24 },
    ];
    for (const partial of partials) {
      const times = pluckTimes(duration, partial.attack, partial.decay);
      const tone = osc(context, voice, "sine", frequency * partial.ratio, at, stopAt);
      const toneEnv = gain(context, voice, partial.level);
      pluckEnvelope(toneEnv.gain, at, partial.level, times.attack, times.decay,
        partial.sustain, times.hold, release);
      tone.connect(toneEnv);
      toneEnv.connect(bodyFilter);
    }
    bodyFilter.connect(voice.bus);
    // Deterministic, very brief hammer noise; its own envelope closes the gate.
    const hammer = noiseVoice(graph, voice, at, 0.024, "bandpass", Math.min(5200, frequency * 7), 0.8);
    const hammerEnv = gain(context, voice, 0.11 * brightness);
    pluckEnvelope(hammerEnv.gain, at, 0.065 * brightness, 0.001, 0.006, 0.16, 0.002, 0.014);
    hammer.connect(hammerEnv);
    hammerEnv.connect(voice.bus);
  } else if (timbre === "guitar") {
    // Clean pluck: a warm fundamental plus a quiet second partial, with a
    // naturally falling envelope that does not sustain like a keyboard synth.
    const lowpass = filter(context, voice, "lowpass", Math.min(5200, frequency * (4.2 + brightness)), 0.72);
    for (const partial of [
      { ratio: 1, level: 0.38, attack: 0.003, decay: 0.08, sustain: 0.27 },
      { ratio: 2.02, level: 0.075 * brightness, attack: 0.001, decay: 0.045, sustain: 0.12 },
    ]) {
      const times = pluckTimes(duration, partial.attack, partial.decay);
      const tone = osc(context, voice, "triangle", frequency * partial.ratio, at, stopAt);
      const toneEnv = gain(context, voice, partial.level);
      pluckEnvelope(toneEnv.gain, at, partial.level, times.attack, times.decay,
        partial.sustain, times.hold, release);
      tone.connect(toneEnv);
      toneEnv.connect(lowpass);
    }
    lowpass.connect(voice.bus);
  } else {
    // Rounded upright-bass pluck: low triangle body, subdued sine support,
    // and a short woody attack with no vibrato or sustained sub-oscillator.
    const body = osc(context, voice, "triangle", frequency, at, stopAt);
    const bodyFilter = filter(context, voice, "lowpass", Math.min(1150, frequency * 5.2), 0.58);
    const bodyEnv = gain(context, voice, 0.43);
    const bodyTimes = pluckTimes(duration, 0.009, 0.11);
    pluckEnvelope(bodyEnv.gain, at, 0.43, bodyTimes.attack, bodyTimes.decay, 0.32,
      bodyTimes.hold, release);
    body.connect(bodyFilter);
    bodyFilter.connect(bodyEnv);
    bodyEnv.connect(voice.bus);
    const fundamental = osc(context, voice, "sine", frequency * 0.5, at, stopAt);
    const subEnv = gain(context, voice, 0.13);
    const subTimes = pluckTimes(duration, 0.012, 0.08);
    pluckEnvelope(subEnv.gain, at, 0.13, subTimes.attack, subTimes.decay, 0.2,
      subTimes.hold, release);
    fundamental.connect(subEnv);
    subEnv.connect(voice.bus);
    const attack = noiseVoice(graph, voice, at, 0.022, "bandpass", Math.min(1700, frequency * 4), 0.65);
    const attackEnv = gain(context, voice, 0.07);
    pluckEnvelope(attackEnv.gain, at, 0.045, 0.001, 0.005, 0.12, 0.002, 0.014);
    attack.connect(attackEnv);
    attackEnv.connect(voice.bus);
  }
  return voice;
}

function scheduleNote(graph, event, at, beatSeconds) {
  if (["piano", "guitar", "upright"].includes(event.timbre)) {
    return scheduleTimbre(graph, event, at, beatSeconds, event.timbre);
  }
  if (event.track === "drums") return scheduleDrum(graph, event, at, beatSeconds);
  const context = graph.context;
  const track = TRACKS.includes(event.track) ? event.track : "keys";
  const velocity = clamp(event.velocity ?? 0.68, 0.03, 1);
  const frequency = midiHz(clamp(Math.round(event.note ?? 60), 0, 127));
  const duration = clamp(Number(event.duration) * beatSeconds || 0.2, 0.035, 12);
  const release = track === "bass" ? 0.12 : track === "lead" ? 0.2 : 0.3;
  const stopAt = at + duration + release + 0.05;
  const voice = beginVoice(graph, track, at, velocity, eventPan(event, track));

  if (track === "keys") {
    const carrier = osc(context, voice, "sine", frequency, at, stopAt);
    const mod = osc(context, voice, "sine", frequency * 2.01, at, stopAt);
    const tine = osc(context, voice, "sine", frequency * 3.01, at, at + Math.min(0.45, duration + 0.12));
    const mainEnv = gain(context, voice, 0.72);
    const tineEnv = gain(context, voice, 0.11);
    envelope(mainEnv.gain, at, 0.58, 0.006, Math.max(0.015, duration - 0.006), release);
    envelope(tineEnv.gain, at, 0.19, 0.002, 0.018, Math.min(0.35, duration + 0.08));
    carrier.connect(mainEnv);
    mainEnv.connect(voice.bus);
    tine.connect(tineEnv);
    tineEnv.connect(voice.bus);
    const modEnv = gain(context, voice, frequency * 0.48);
    envelope(modEnv.gain, at, frequency * 0.48, 0.002, 0.035, 0.24);
    // A short FM index envelope creates the tine's soft initial shimmer.
    mod.connect(modEnv);
    modEnv.connect(carrier.frequency);
  } else if (track === "bass") {
    const fundamental = osc(context, voice, "triangle", frequency, at, stopAt);
    const sub = osc(context, voice, "sine", frequency * 0.5, at, stopAt);
    const lowpass = filter(context, voice, "lowpass", Math.min(1050, frequency * 5), 0.55);
    const mainEnv = gain(context, voice, 0.85);
    const subGain = gain(context, voice, 0.23);
    envelope(mainEnv.gain, at, 0.56, 0.008, Math.max(0.015, duration - 0.008), release);
    envelope(subGain.gain, at, 0.22, 0.01, Math.max(0.015, duration - 0.01), release);
    fundamental.connect(lowpass);
    lowpass.connect(mainEnv);
    mainEnv.connect(voice.bus);
    sub.connect(subGain);
    subGain.connect(voice.bus);
  } else {
    const fundamental = osc(context, voice, "sine", frequency, at, stopAt);
    const color = osc(context, voice, "triangle", frequency, at, stopAt);
    const colorGain = gain(context, voice, 0.11);
    const mainEnv = gain(context, voice, 0.86);
    envelope(mainEnv.gain, at, 0.5, 0.035, Math.max(0.015, duration - 0.035), release);
    envelope(colorGain.gain, at, 0.09, 0.05, Math.max(0.015, duration - 0.05), release);
    // Gentle vibrato begins after the attack, avoiding a synthetic wobble.
    const vibrato = osc(context, voice, "sine", 5.1, at, stopAt);
    const vibratoDepth = gain(context, voice, Math.max(0.2, frequency * 0.003));
    safeSet(vibratoDepth.gain, 0, at);
    ramp(vibratoDepth.gain, Math.max(0.2, frequency * 0.003), at + 0.22);
    vibrato.connect(vibratoDepth);
    vibratoDepth.connect(fundamental.frequency);
    fundamental.connect(mainEnv);
    mainEnv.connect(voice.bus);
    color.connect(colorGain);
    colorGain.connect(voice.bus);
  }
  return voice;
}

function songTiming(song) {
  const tempo = clamp(song?.settings?.tempo ?? DEFAULT_TEMPO, 30, 280);
  const beatSeconds = 60 / tempo;
  const totalBeats = Math.max(0, Number(song?.totalBeats) || 0);
  return { tempo, beatSeconds, totalBeats, duration: totalBeats * beatSeconds };
}

function orderedEvents(song) {
  return (Array.isArray(song?.events) ? song.events : [])
    .filter((event) => event && Number.isFinite(Number(event.beat)) && Number(event.beat) >= 0)
    .map((event, index) => ({ event, index, beat: Number(event.beat) }))
    .sort((a, b) => a.beat - b.beat || a.index - b.index);
}

function setMasterFade(graph, from, to, start, end) {
  try {
    graph.master.gain.cancelScheduledValues(start);
    graph.master.gain.setValueAtTime(from, start);
    graph.master.gain.linearRampToValueAtTime(to, end);
  } catch (_) { graph.master.gain.value = to; }
}

export class JazzPlayer {
  constructor({ onState, onEnded } = {}) {
    this.onState = typeof onState === "function" ? onState : null;
    this.onEnded = typeof onEnded === "function" ? onEnded : null;
    this.song = null;
    this.events = [];
    this.context = null;
    this.graph = null;
    this.playing = false;
    this.anchorBeat = 0;
    this.anchorTime = 0;
    this.nextEvent = 0;
    this.scheduler = null;
    this.endTimer = null;
    this._volume = 0.75;
    this._levels = { ...DEFAULT_LEVELS };
    this._muted = {};
    this._reverb = 0.18;
    this._lastContextState = "unavailable";
    this._interrupted = false;
  }

  async load(song) {
    this.stop();
    this.song = song || null;
    this.events = this.song ? orderedEvents(this.song) : [];
    this.anchorBeat = 0;
    if (this.context && this.context.state !== "closed") this._ensureGraph();
    this._emitState();
  }

  async play() {
    if (!this.song) return;
    if (!this.context || this.context.state === "closed") this._createContext();
    if (!this.context) return;
    this._ensureGraph();
    try { await this.context.resume(); } catch (_) { /* state remains queryable */ }
    if (this.context.state !== "running") {
      this._emitState();
      return;
    }
    if (this.playing) {
      if (this._interrupted) {
        this.anchorTime = this.context.currentTime;
        this._interrupted = false;
        this._locateNextEvent();
        this._startScheduler();
      }
      this._emitState();
      return;
    }
    if (this.anchorBeat >= songTiming(this.song).totalBeats) this.anchorBeat = 0;
    this.anchorTime = this.context.currentTime;
    this.playing = true;
    this._interrupted = false;
    setMasterFade(this.graph, 0, 0.62 * this._volume, this.context.currentTime, this.context.currentTime + 0.018);
    this._locateNextEvent();
    this._startScheduler();
    this._emitState();
  }

  pause() {
    if (!this.playing) return;
    this.anchorBeat = this._currentBeat();
    this.playing = false;
    this._clearTimers();
    this._cancelVoices();
    this._locateNextEvent();
    this._emitState();
  }

  stop() {
    this.playing = false;
    this._clearTimers();
    this._cancelVoices();
    this.anchorBeat = 0;
    this.anchorTime = this.context?.currentTime || 0;
    this.nextEvent = 0;
    this._emitState();
  }

  seek(beat) {
    const { totalBeats } = songTiming(this.song || {});
    const wasPlaying = this.playing;
    const target = clamp(beat, 0, totalBeats);
    this.anchorBeat = target;
    if (this.context) this.anchorTime = this.context.currentTime;
    this._cancelVoices();
    this._locateNextEvent();
    if (wasPlaying && target < totalBeats) {
      this.playing = true;
      this._startScheduler();
    } else if (target >= totalBeats) {
      this.playing = false;
      this._clearTimers();
    }
    this._emitState();
  }

  setVolume(value) {
    this._volume = clamp(value, 0, 1);
    if (this.graph) {
      const time = this.context.currentTime;
      this.graph.master.gain.setTargetAtTime(0.62 * this._volume, time, 0.018);
    }
  }

  setTrackLevel(track, value) {
    if (!TRACKS.includes(track)) return;
    this._levels[track] = clamp(value, 0, 1);
    this._applyTrackLevel(track);
  }

  setMuted(track, muted) {
    if (!TRACKS.includes(track)) return;
    this._muted[track] = Boolean(muted);
    this._applyTrackLevel(track);
  }

  setReverb(value) {
    this._reverb = clamp(value, 0, 1);
    if (this.graph) this.graph.reverbSend.gain.setTargetAtTime(this._reverb * 0.35, this.context.currentTime, 0.03);
  }

  getState() {
    const timing = songTiming(this.song || {});
    const beat = this.playing ? this._currentBeat() : this.anchorBeat;
    return {
      playing: this.playing,
      beat,
      seconds: beat * timing.beatSeconds,
      duration: timing.duration,
      contextState: this.context?.state || this._lastContextState,
    };
  }

  get analyser() {
    return this.graph?.analyser || null;
  }

  _createContext() {
    const Context = audioContextConstructor();
    if (!Context) return;
    const wasPlaying = this.playing;
    if (wasPlaying && this.context) this.anchorBeat = this._currentBeat();
    this._cancelVoices();
    this.graph = null;
    this.context = new Context();
    this.anchorTime = this.context.currentTime;
    this._interrupted = wasPlaying;
    this._lastContextState = this.context.state;
    this._ensureGraph();
    if (typeof this.context.addEventListener === "function") {
      this.context.addEventListener("statechange", () => this._handleContextState());
    } else {
      this.context.onstatechange = () => this._handleContextState();
    }
  }

  _ensureGraph() {
    if (!this.context || this.context.state === "closed") return;
    if (this.graph) return;
    this.graph = buildGraph(this.context, { volume: this._volume, levels: this._effectiveLevels(), reverb: this._reverb });
  }

  _effectiveLevels() {
    const result = {};
    for (const track of TRACKS) result[track] = this._muted[track] ? 0 : this._levels[track];
    return result;
  }

  _applyTrackLevel(track) {
    if (!this.graph) return;
    this.graph.tracks[track].gain.setTargetAtTime(this._muted[track] ? 0 : this._levels[track], this.context.currentTime, 0.015);
  }

  _currentBeat() {
    if (!this.playing || !this.song || !this.context) return this.anchorBeat;
    const { beatSeconds, totalBeats } = songTiming(this.song);
    const elapsed = Math.max(0, this.context.currentTime - this.anchorTime);
    return clamp(this.anchorBeat + elapsed / beatSeconds, 0, totalBeats);
  }

  _locateNextEvent() {
    const beat = this.anchorBeat - 0.00001;
    let low = 0;
    let high = this.events.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.events[mid].beat < beat) low = mid + 1;
      else high = mid;
    }
    this.nextEvent = low;
  }

  _startScheduler() {
    this._clearTimers();
    this.scheduler = setInterval(() => this._scheduleAhead(), SCHEDULER_MS);
    this._scheduleAhead();
  }

  _scheduleAhead() {
    if (!this.playing || !this.context || !this.graph || !this.song) return;
    if (this.context.state !== "running") {
      if (!this._interrupted) {
        this.anchorBeat = this._currentBeat();
        this._interrupted = true;
      }
      this._cancelVoices();
      return;
    }
    if (this._interrupted) {
      this._interrupted = false;
      this.anchorTime = this.context.currentTime;
      this._locateNextEvent();
    }
    const { beatSeconds, totalBeats } = songTiming(this.song);
    if (this._currentBeat() >= totalBeats) {
      this._finish();
      return;
    }
    const horizonBeat = this._currentBeat() + LOOKAHEAD / beatSeconds;
    while (this.nextEvent < this.events.length && this.events[this.nextEvent].beat <= horizonBeat && this.events[this.nextEvent].beat < totalBeats) {
      const item = this.events[this.nextEvent++];
      const at = this.anchorTime + (item.beat - this.anchorBeat) * beatSeconds;
      if (at >= this.context.currentTime - 0.01) scheduleNote(this.graph, item.event, Math.max(at, this.context.currentTime), beatSeconds);
    }
  }

  _finish() {
    if (!this.playing) return;
    this.anchorBeat = songTiming(this.song || {}).totalBeats;
    this.playing = false;
    this._clearTimers();
    this._cancelVoices();
    this._emitState();
    if (this.onEnded) this.onEnded();
  }

  _cancelVoices() {
    if (!this.graph) return;
    const time = this.context?.currentTime || 0;
    for (const voice of [...this.graph.voices]) voice.cancel(time);
  }

  _clearTimers() {
    if (this.scheduler !== null) clearInterval(this.scheduler);
    if (this.endTimer !== null) clearTimeout(this.endTimer);
    this.scheduler = null;
    this.endTimer = null;
  }

  _handleContextState() {
    if (!this.context) return;
    const state = this.context.state;
    this._lastContextState = state;
    if (state !== "running" && this.playing) {
      if (!this._interrupted) this.anchorBeat = this._currentBeat();
      this._interrupted = true;
      this.anchorTime = this.context.currentTime;
      this._cancelVoices();
      this._locateNextEvent();
    } else if (state === "running" && this.playing && this._interrupted) {
      this.anchorTime = this.context.currentTime;
      this._interrupted = false;
      this._locateNextEvent();
      this._scheduleAhead();
    }
    this._emitState();
  }

  _emitState() {
    if (this.onState) this.onState(this.getState());
  }
}

/** Render the same synth graph to a deterministic PCM WAV Blob. */
export async function renderWav(song, {
  volume = 0.75,
  levels = DEFAULT_LEVELS,
  muted = {},
  reverb = 0.18,
  sampleRate = 44100,
  onProgress,
} = {}) {
  const Offline = typeof window !== "undefined" && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
  if (!Offline) throw new Error("OfflineAudioContext is not available in this browser.");
  const timing = songTiming(song || {});
  // 96 four-beat bars at 60 BPM plus the render tail fits under this bound.
  const seconds = Math.min(402, timing.duration + TAIL_SECONDS);
  const safeRate = clamp(sampleRate, 22050, 96000);
  const frameCount = Math.max(1, Math.ceil(seconds * safeRate));
  const offline = new Offline(2, frameCount, safeRate);
  const effectiveLevels = {};
  for (const track of TRACKS) effectiveLevels[track] = muted[track] ? 0 : clamp(levels?.[track] ?? DEFAULT_LEVELS[track], 0, 1);
  const graph = buildGraph(offline, { volume: clamp(volume, 0, 1), levels: effectiveLevels, muted, reverb: clamp(reverb, 0, 1) });
  const events = orderedEvents(song || []);
  const fadeIn = Math.min(0.035, Math.max(0.005, timing.duration * 0.005));
  setMasterFade(graph, 0, 0.62 * clamp(volume, 0, 1), 0, fadeIn);
  setMasterFade(graph, 0.62 * clamp(volume, 0, 1), 0, Math.max(fadeIn, seconds - 0.12), seconds);

  const batch = 600;
  for (let start = 0; start < events.length; start += batch) {
    const end = Math.min(events.length, start + batch);
    for (let index = start; index < end; index += 1) {
      const item = events[index];
      if (item.beat >= timing.totalBeats || item.beat * timing.beatSeconds >= seconds) continue;
      scheduleNote(graph, item.event, item.beat * timing.beatSeconds, timing.beatSeconds);
    }
    if (onProgress) onProgress(events.length ? end / events.length : 1);
    if (end < events.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!events.length && onProgress) onProgress(1);
  const rendered = await offline.startRendering();
  return encodeWav(rendered);
}

/** Encode an AudioBuffer as a standards-compliant 16-bit PCM WAV Blob. */
export function encodeWav(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeString = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataBytes, true);
  const channelData = Array.from({ length: channels }, (_, channel) => audioBuffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = clamp(channelData[channel][frame], -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export default JazzPlayer;
