import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeWav, JazzPlayer, renderWav } from "../src/audio.js";

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(value, time) { this.value = value; this.events.push({ type: "set", value, time }); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push({ type: "ramp", value, time }); }
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push({ type: "target", value, time, constant }); }
  cancelScheduledValues(time) { this.events.push({ type: "cancel", time }); }
}

class FakeNode {
  constructor(type) {
    this.kind = type;
    this.type = type;
    this.connections = [];
    this.gain = new FakeParam(1);
    this.frequency = new FakeParam(440);
    this.Q = new FakeParam(1);
    this.pan = new FakeParam(0);
    this.threshold = new FakeParam(-24);
    this.knee = new FakeParam(30);
    this.ratio = new FakeParam(12);
    this.attack = new FakeParam(0.003);
    this.release = new FakeParam(0.25);
  }
  connect(destination) { this.connections.push(destination); }
  disconnect() { this.connections.length = 0; }
  start(time) { this.startedAt = time; }
  stop(time) { this.stoppedAt = time; }
}

class FakeContextBase {
  constructor(channels = 2, length = 44100, sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.length = length;
    this.destination = new FakeNode("destination");
    this.currentTime = 0;
    this.state = "running";
    this.nodes = [];
  }
  add(node) { this.nodes.push(node); return node; }
  createGain() { return this.add(new FakeNode("gain")); }
  createDynamicsCompressor() { return this.add(new FakeNode("compressor")); }
  createAnalyser() { return this.add(new FakeNode("analyser")); }
  createConvolver() { return this.add(new FakeNode("convolver")); }
  createOscillator() { return this.add(new FakeNode("oscillator")); }
  createBiquadFilter() { return this.add(new FakeNode("filter")); }
  createBufferSource() { return this.add(new FakeNode("bufferSource")); }
  createStereoPanner() { return this.add(new FakeNode("stereoPanner")); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: (channel) => data[channel],
    };
  }
}

class FakeOfflineAudioContext extends FakeContextBase {
  constructor(channels, length, sampleRate) {
    super(channels, length, sampleRate);
    FakeOfflineAudioContext.last = this;
  }
  async startRendering() {
    const channels = Array.from({ length: 2 }, () => new Float32Array(this.length));
    return {
      numberOfChannels: 2,
      length: this.length,
      sampleRate: this.sampleRate,
      getChannelData: (channel) => channels[channel],
    };
  }
}

class FakeAudioContext extends FakeContextBase {
  constructor() {
    super();
    FakeAudioContext.last = this;
  }
  async resume() { this.state = "running"; }
  addEventListener(type, callback) {
    if (type === "statechange") this.onstatechange = callback;
  }
  changeState(state) {
    this.state = state;
    this.onstatechange?.();
  }
}

async function withFakeWindow(callback) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      AudioContext: FakeAudioContext,
      OfflineAudioContext: FakeOfflineAudioContext,
    },
  });
  try {
    await callback();
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
}

function basicSong(events = []) {
  return { settings: { tempo: 120 }, totalBeats: 8, events };
}

function trackGains(context) {
  // Track strips are the gain nodes connected to both dry and reverb buses.
  return context.nodes.filter((node) => node.kind === "gain"
    && node.connections.length === 2
    && node.connections.every((target) => target.kind === "gain"));
}

function pathToTrack(source, trackSet, seen = new Set()) {
  if (trackSet.has(source)) return [source];
  if (!source || seen.has(source) || !Array.isArray(source.connections)) return null;
  seen.add(source);
  for (const destination of source.connections) {
    const tail = pathToTrack(destination, trackSet, seen);
    if (tail) return [source, ...tail];
  }
  return null;
}

test("encodeWav writes a PCM header and interleaves clamped signed samples", () => {
  const channelData = [new Float32Array([-1, 0.5]), new Float32Array([1, -0.5])];
  const wav = encodeWav({
    numberOfChannels: 2,
    sampleRate: 48000,
    length: 2,
    getChannelData: (channel) => channelData[channel],
  });
  return wav.arrayBuffer().then((arrayBuffer) => {
    const view = new DataView(arrayBuffer);
    const text = (start, size) => String.fromCharCode(...new Uint8Array(arrayBuffer, start, size));
    assert.equal(wav.type, "audio/wav");
    assert.equal(text(0, 4), "RIFF");
    assert.equal(view.getUint32(4, true), arrayBuffer.byteLength - 8);
    assert.equal(text(8, 4), "WAVE");
    assert.equal(text(12, 4), "fmt ");
    assert.equal(view.getUint16(20, true), 1);
    assert.equal(view.getUint16(22, true), 2);
    assert.equal(view.getUint32(24, true), 48000);
    assert.equal(text(36, 4), "data");
    assert.equal(view.getUint32(40, true), 8);
    assert.equal(view.getInt16(44, true), -32768);
    assert.equal(view.getInt16(46, true), 32767);
    assert.equal(view.getInt16(48, true), 16383);
    assert.equal(view.getInt16(50, true), -16384);
  });
});

test("offline graph gates all synthesized noise and applies per-track mute and pan", async () => {
  await withFakeWindow(async () => {
    await renderWav(basicSong([
      { track: "keys", beat: 0, duration: 1, note: 60 },
      { track: "bass", beat: 1, duration: 1, note: 40 },
      { track: "lead", beat: 2, duration: 1, note: 72 },
      { track: "drums", beat: 3, duration: 0.1, drum: "hat" },
    ]), {
      sampleRate: 22050,
      levels: { keys: 0.5, bass: 0.6, drums: 0.7, lead: 0.8 },
      muted: { drums: true },
    });

    const context = FakeOfflineAudioContext.last;
    const noiseSources = context.nodes.filter((node) => node.kind === "bufferSource");
    const filters = context.nodes.filter((node) => node.kind === "filter");
    assert.ok(noiseSources.length > 0);
    assert.ok(noiseSources.every((source) => source.connections[0]?.kind === "filter"));
    assert.ok(filters.every((node) => node.connections[0]?.kind === "gain"), "filter output must pass through an envelope gain");
    assert.equal(trackGains(context).length, 4);
    assert.deepEqual(trackGains(context).map((node) => node.gain.value), [0.5, 0.6, 0, 0.8]);
    assert.deepEqual(context.nodes.filter((node) => node.kind === "stereoPanner").map((node) => node.pan.value), [-0.14, 0, 0.14, 0]);
  });
});

test("all audible envelopes reach silence before their source stops", async () => {
  await withFakeWindow(async () => {
    const events = [
      { track: "keys", beat: 0, duration: 0.1, note: 60 },
      { track: "bass", beat: 0, duration: 0.1, note: 38 },
      { track: "lead", beat: 0, duration: 0.1, note: 72 },
      ...["kick", "snare", "hat", "openHat", "ride", "tom", "rim", "shaker"].map((drum, i) => ({
        track: "drums", beat: 1 + i * 0.1, duration: 0.1, drum,
      })),
    ];
    await renderWav(basicSong(events), { sampleRate: 22050 });
    const context = FakeOfflineAudioContext.last;
    const tracks = new Set(trackGains(context));
    const sources = context.nodes.filter((node) => (node.kind === "oscillator" || node.kind === "bufferSource")
      && Number.isFinite(node.stoppedAt));
    assert.ok(sources.length > 12);

    for (const source of sources) {
      const route = pathToTrack(source, tracks);
      if (!route) continue; // Vibrato/FM oscillators modulate frequency, not the audio bus.
      const envelopes = route.filter((node) => node.kind === "gain" && node.gain.events.some((event) => event.type === "ramp"));
      for (const env of envelopes) {
        const final = env.gain.events.at(-1);
        assert.ok(final.value <= 0.0001, `${source.type} envelope must end at silence`);
        assert.ok(final.time <= source.stoppedAt + 1e-9,
          `${source.type} stops at ${source.stoppedAt}s before its envelope ends at ${final.time}s`);
      }
    }
  });
});

test("piano, guitar, and upright timbres keep gated envelopes on their requested track", async () => {
  await withFakeWindow(async () => {
    const events = [
      { track: "bass", timbre: "piano", beat: 0, duration: 0.08, note: 60, velocity: 0.4 },
      { track: "lead", timbre: "piano", beat: 0.5, duration: 3, note: 72, velocity: 0.95 },
      { track: "keys", timbre: "guitar", beat: 1, duration: 0.12, note: 64 },
      { track: "bass", timbre: "guitar", beat: 1.5, duration: 2.5, note: 52 },
      { track: "lead", timbre: "upright", beat: 2, duration: 0.09, note: 43 },
      { track: "bass", timbre: "upright", beat: 2.5, duration: 3.5, note: 36 },
    ];
    await renderWav(basicSong(events), { sampleRate: 22050, muted: { lead: true } });

    const context = FakeOfflineAudioContext.last;
    const tracks = trackGains(context);
    assert.equal(tracks.length, 4);
    assert.deepEqual(tracks.map((node) => node.gain.value), [0.75, 0.8, 0.65, 0]);
    const sharedTimbreFilters = context.nodes.filter((node) => node.kind === "filter"
      && node.connections[0]?.kind === "gain"
      && !node.connections[0].gain.events.some((event) => event.type === "ramp")
      && pathToTrack(node, new Set(tracks)));
    assert.equal(sharedTimbreFilters.length, 4, "each piano/guitar note uses one shared body filter");
    for (const sharedFilter of sharedTimbreFilters) {
      const partialEnvelopes = context.nodes.filter((node) => node.kind === "gain"
        && node.connections.includes(sharedFilter));
      assert.ok(partialEnvelopes.length >= 2, "each partial must have its own envelope before the shared filter");
      assert.ok(partialEnvelopes.every((node) => node.gain.events.at(-1)?.value === 0),
        "each partial envelope closes before the shared filter");
    }

    const sources = context.nodes.filter((node) =>
      (node.kind === "oscillator" || node.kind === "bufferSource") && Number.isFinite(node.stoppedAt));
    assert.ok(sources.length >= 15, "all timbres should include their pitched and/or attack sources");
    assert.ok(sources.length <= 18, "timbres should use only a small number of oscillators per note");
    const routedSources = tracks.map(() => 0);
    for (const source of sources) {
      const route = pathToTrack(source, new Set(tracks));
      assert.ok(route, `${source.kind} must reach a track strip`);
      routedSources[tracks.indexOf(route.at(-1))] += 1;
      const envelopes = route.filter((node) => node.kind === "gain"
        && node.gain.events.some((event) => event.type === "ramp"));
      assert.ok(envelopes.length > 0, `${source.kind} must pass through an envelope gate`);
      for (const env of envelopes) {
        const final = env.gain.events.at(-1);
        assert.equal(final.value, 0, "timbre envelope must close fully");
        assert.ok(final.time <= source.stoppedAt + 1e-9,
          `${source.kind} stops at ${source.stoppedAt}s before its envelope ends at ${final.time}s`);
      }
    }

    const noise = sources.filter((source) => source.kind === "bufferSource");
    assert.ok(noise.length > 0, "acoustic attack noise should be synthesized deterministically");
    assert.ok(noise.every((source) => source.loop && source.connections[0]?.kind === "filter"),
      "noise must be filtered and closed by its short envelope gate");
    assert.ok(routedSources[3] > 0, "new timbre sources still route through and obey the muted lead strip");
  });
});

test("offline export reports progress by scheduled batches", async () => {
  await withFakeWindow(async () => {
    const progress = [];
    const events = Array.from({ length: 601 }, (_, i) => ({ track: "keys", beat: 0, duration: 0.1, note: 60 + (i % 12) }));
    await renderWav(basicSong(events), { sampleRate: 22050, onProgress: (value) => progress.push(value) });
    assert.deepEqual(progress, [600 / 601, 1]);
  });
});

test("transport repeat play is idempotent; pause, seek, and stop preserve their contracts", async (t) => {
  await withFakeWindow(async () => {
    const song = basicSong([
      { track: "keys", beat: 0.2, duration: 0.4, note: 60 },
      { track: "bass", beat: 1, duration: 0.4, note: 40 },
      { track: "lead", beat: 2, duration: 0.4, note: 72 },
    ]);
    const player = new JazzPlayer();
    t.after(() => player.stop());
    await player.load(song);
    await player.play();
    const context = FakeAudioContext.last;
    const sourceCount = () => context.nodes.filter((node) => node.kind === "oscillator").length;
    const scheduledAtStart = sourceCount();
    await player.play();
    assert.equal(sourceCount(), scheduledAtStart, "calling play twice must not duplicate lookahead sources");

    context.currentTime = 0.15;
    assert.ok(Math.abs(player.getState().beat - 0.3) < 1e-9);
    player.pause();
    const pausedBeat = player.getState().beat;
    context.currentTime = 0.8;
    assert.equal(player.getState().beat, pausedBeat, "pause freezes transport position");
    player.seek(1.5);
    assert.equal(player.getState().beat, 1.5);
    assert.equal(player.getState().playing, false);
    await player.play();
    assert.equal(player.getState().playing, true);
    context.currentTime = 1.05;
    player.seek(0.5);
    assert.equal(player.getState().beat, 0.5);
    assert.equal(player.getState().playing, true, "seek preserves playing state");
    player.stop();
    assert.equal(player.getState().beat, 0);
    assert.equal(player.getState().playing, false);
  });
});

test("suspension freezes the beat and resume schedules only events at or after it", async (t) => {
  await withFakeWindow(async () => {
    const song = basicSong([0, 0.5, 1, 1.1, 1.3, 2].map((beat) => ({
      track: "keys", beat, duration: 0.15, note: 60,
    })));
    const player = new JazzPlayer();
    t.after(() => player.stop());
    await player.load(song);
    await player.play();
    const context = FakeAudioContext.last;
    context.currentTime = 0.5;
    context.changeState("suspended");
    const frozenBeat = player.getState().beat;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(player.getState().beat, frozenBeat);
    assert.equal(frozenBeat, 1);

    const previousSources = new Set(context.nodes.filter((node) => node.kind === "oscillator"));
    await player.play();
    const resumed = context.nodes.filter((node) => node.kind === "oscillator" && !previousSources.has(node));
    assert.ok(resumed.length > 0);
    assert.ok(resumed.every((source) => source.startedAt >= context.currentTime), "resume must not burst stale events");
    const countAfterResume = resumed.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(context.nodes.filter((node) => node.kind === "oscillator" && !previousSources.has(node)).length, countAfterResume,
      "a stationary suspended/resumed clock must not duplicate events");
    player.stop();
  });
});

test("empty songs are safe and finish without leaving transport running", async () => {
  await withFakeWindow(async () => {
    let ended = 0;
    const player = new JazzPlayer({ onEnded: () => { ended += 1; } });
    await player.play();
    assert.equal(player.getState().playing, false);
    await player.load({ settings: { tempo: 120 }, totalBeats: 0, events: [] });
    await player.play();
    assert.equal(player.getState().playing, false);
    assert.equal(player.getState().beat, 0);
    assert.equal(ended, 1);
  });
});
