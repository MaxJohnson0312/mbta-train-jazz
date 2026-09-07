// The band. Web Audio synthesis + a swing transport that everything
// quantizes to. Live vehicle events arrive via triggerVehicleNote() /
// triggerHorn() / triggerBell(); buses arrive as a density value.
//
// Voice design notes (from listening feedback):
// - Percussive voices (rhodes/vibes/celesta) ring out with setTargetAtTime
//   (natural exponential decay, no hard endpoint) and oscillators stop well
//   after the tail — nothing cuts off abruptly.
// - Wind voices (trumpet/clarinet) are sustained: slow attack, held body,
//   delayed vibrato, gentle release. They must never read as "piano".
// - The rhythm bed (walking bass + drums) is optional and OFF by default.

import { BPM, SWING, BEATS_PER_BAR, PROGRESSION, RAIL_ROUTES } from "./config.js";

const LOOKAHEAD_MS = 25;
const HORIZON_S = 0.12;
const A4 = 440;

const midiHz = (m) => A4 * Math.pow(2, (m - 69) / 12);
// Our pitch numbers: semitones-from-C * octave; convert to MIDI (C4 = 60).
const pitchMidi = (semitoneFromC, octave) => 12 * (octave + 1) + semitoneFromC;
const pitchHz = (semitoneFromC, octave) => midiHz(pitchMidi(semitoneFromC, octave));

// Recorded-instrument samples (FluidR3_GM via gleitz/midi-js-soundfonts),
// self-hosted under samples/<voice>/<Note>.mp3. Synthesis stays as a fallback
// if a sample is missing or the load fails.
const SAMPLE_BASE = "samples";
const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const midiToName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
const MAX_SHIFT = 6;   // semitones we'll pitch-shift a neighbouring sample by

export class Band {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.beat = 0;                 // next beat index to schedule
    this.startTime = 0;
    this.secPerBeat = 60 / BPM;
    this.timer = null;
    this.busDensity = 0;           // 0..1, set externally
    this.pendingNotes = [];        // quantized melodic queue
    this.activePerRoute = new Map();
    this.onBar = null;             // callback(chordName, barIndex)
    this.onNotePlayed = null;      // callback(routeId) for UI glow
    this.enabled = { cr: true, ferry: true, buses: true, rhythm: false };
    this.recentMelodic = [];       // timestamps for global note-rate cap
    this.buffers = {};             // voice -> { midi: AudioBuffer }
    this.useSamples = false;
    this.mutedRoutes = new Set();  // route ids (plus "CR" / "Boat") silenced from the legend
  }

  toggleRouteMute(key) {
    if (this.mutedRoutes.has(key)) this.mutedRoutes.delete(key);
    else this.mutedRoutes.add(key);
    return this.mutedRoutes.has(key);
  }

  // Fetch + decode every sampled note. Call after start() (needs the context).
  // onProgress(loaded, total) drives the loading UI.
  async loadSamples(onProgress) {
    let manifest;
    try {
      const r = await fetch(`${SAMPLE_BASE}/manifest.json`);
      if (!r.ok) throw new Error(r.status);
      manifest = await r.json();
    } catch {
      this.useSamples = false;
      return false;               // stay on synthesis
    }

    const jobs = [];
    for (const [voice, midis] of Object.entries(manifest))
      for (const midi of midis) jobs.push([voice, midi]);

    // Safari's decodeAudioData is callback-based and returns undefined, so
    // `await` on it yields undefined rather than a buffer. Normalize both forms.
    const decode = (arrayBuf) => new Promise((resolve, reject) => {
      const maybe = this.ctx.decodeAudioData(arrayBuf, resolve, reject);
      if (maybe && typeof maybe.then === "function") maybe.then(resolve, reject);
    });

    let done = 0;
    const load = async ([voice, midi]) => {
      try {
        const res = await fetch(`${SAMPLE_BASE}/${voice}/${midiToName(midi)}.mp3`);
        if (!res.ok) throw new Error(res.status);
        const buf = await decode(await res.arrayBuffer());
        // Never store a non-buffer: playSample would "succeed" and be silent.
        if (buf && buf.duration > 0) (this.buffers[voice] ||= {})[midi] = buf;
      } catch { /* leave the gap; playSample falls back to synthesis */ }
      // A throwing progress callback must not abort the whole load.
      try { if (onProgress) onProgress(++done, jobs.length); } catch {}
    };

    // modest concurrency so mobile doesn't choke on parallel decodes
    const queue = jobs.slice();
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (queue.length) await load(queue.shift());
    }));

    this.useSamples = Object.keys(this.buffers).length > 0;
    return this.useSamples;
  }

  // Play a recorded note. Returns false if this voice/pitch isn't available,
  // so callers can fall back to synthesis.
  playSample(voice, midi, t, vel, pan, fadeAfter = 3.0) {
    const bank = this.buffers[voice];
    if (!bank || !this.master) return false;

    let buf = bank[midi], rate = 1;
    if (!buf) {                                  // nearest sample, pitch-shifted
      let best = null, bestD = Infinity;
      for (const k of Object.keys(bank)) {
        if (!bank[k]) continue;
        const d = Math.abs(k - midi);
        if (d < bestD) { bestD = d; best = +k; }
      }
      if (best === null || bestD > MAX_SHIFT) return false;
      buf = bank[best];
      rate = Math.pow(2, (midi - best) / 12);
    }
    if (!buf) return false;   // fall through to synthesis rather than play silence

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan || 0;
    src.connect(g).connect(p).connect(this.master);

    const dur = buf.duration / rate;
    if (fadeAfter && fadeAfter < dur) {          // gentle tail, never a hard cut
      g.gain.setValueAtTime(vel, t + fadeAfter);
      g.gain.setTargetAtTime(0.0001, t + fadeAfter, 0.4);
      src.stop(t + fadeAfter + 2.0);
    }
    src.start(t);
    return true;
  }

  async start() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();

    // iOS/Android unlock: play a silent buffer inside the user gesture, and
    // resume again if the context is still suspended.
    const unlock = this.ctx.createBufferSource();
    unlock.buffer = this.ctx.createBuffer(1, 1, 22050);
    unlock.connect(this.ctx.destination);
    unlock.start(0);
    if (this.ctx.state === "suspended") await this.ctx.resume();

    // Mobile browsers suspend the context when the tab backgrounds; resume on
    // return (and on any tap, belt-and-suspenders for stubborn WebKit builds).
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    });
    document.addEventListener("touchend", () => {
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    }, { passive: true });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.startTime = this.ctx.currentTime + 0.1;
    this.beat = 0;
    this.timer = setInterval(() => this.tick(), LOOKAHEAD_MS);
  }

  setVolume(v) { if (this.master) this.master.gain.value = v; }

  // ---- transport ----
  beatTime(b) { return this.startTime + b * this.secPerBeat; }
  chordAt(b) { return PROGRESSION[Math.floor(b / BEATS_PER_BAR) % PROGRESSION.length]; }

  tick() {
    const until = this.ctx.currentTime + HORIZON_S;
    while (this.beatTime(this.beat) < until) {
      this.scheduleBeat(this.beat, this.beatTime(this.beat));
      this.beat++;
    }
    // flush quantized melodic notes due within the horizon
    const due = [];
    this.pendingNotes = this.pendingNotes.filter((n) =>
      n.time < until ? (due.push(n), false) : true
    );
    for (const n of due) this.playMelodic(n);
  }

  scheduleBeat(b, t) {
    const chord = this.chordAt(b);
    const beatInBar = b % BEATS_PER_BAR;
    if (beatInBar === 0 && this.onBar) this.onBar(chord.name, Math.floor(b / BEATS_PER_BAR));

    // Walking bass — the harmonic "bed", opt-in and independent of the buses.
    if (this.enabled.rhythm)
      this.bassNote(chord.bassNotes[beatInBar], t, 0.9 - Math.random() * 0.15);

    // Brushes & shaker — driven by how many buses are running. These play on
    // their own (buses ARE the drummer); the bed only adds a floor under them.
    if (!this.enabled.buses && !this.enabled.rhythm) return;
    const density = this.enabled.buses ? this.busDensity : 0.35;

    // Humanize: a drummer is never on the grid and never at one volume.
    const hum = () => (Math.random() - 0.5) * 0.014;             // ±7 ms
    const vel = (base, spread) => base * (1 - spread + Math.random() * spread * 2);
    const swung = t + this.secPerBeat * SWING;

    // Ride: the classic "spang-a-lang" — a quarter on every beat, with the
    // swung eighth landing after beats 2 and 4 (occasionally dropped).
    this.ride(t + hum(), vel(0.42 + density * 0.22, 0.28));
    const backbeat = beatInBar === 1 || beatInBar === 3;
    if (backbeat) {
      if (Math.random() < 0.88) this.ride(swung + hum(), vel(0.3 + density * 0.26, 0.3));
    } else if (density > 0.3 && Math.random() < density * 0.55) {
      this.ride(swung + hum(), vel(0.2 + density * 0.18, 0.35));
    }

    // Hi-hat "chick" closes on 2 and 4.
    if (backbeat) this.hat(t + hum(), vel(0.5, 0.22));

    // Shaker fills in as the bus fleet grows.
    if (density > 0.35) {
      if (Math.random() < 0.85) this.shaker(t + hum(), vel(0.18, 0.45));
      if (Math.random() < density) this.shaker(swung + hum(), vel(0.12, 0.5));
    }

    // Brush sweep across the top of a bar, now and then.
    if (beatInBar === 0 && Math.random() < 0.3) this.sweep(t + hum(), 0.09 + density * 0.09);
  }

  // Quantize an incoming event to the next swung 8th at/after now.
  nextGridTime() {
    const now = this.ctx.currentTime;
    const bFloat = (now - this.startTime) / this.secPerBeat;
    const bInt = Math.floor(bFloat);
    const frac = bFloat - bInt;
    let target;
    if (frac < 0) target = 0;
    else if (frac < SWING) target = bInt + SWING;
    else target = bInt + 1;
    return { time: this.beatTime(target), beat: Math.round(target) };
  }

  // ---- public triggers from live data ----
  triggerVehicleNote(routeId, progress01, directionId, isArrival) {
    if (!this.ctx) return;
    const style = RAIL_ROUTES[routeId];
    if (!style || this.mutedRoutes.has(routeId)) return;

    // global melodic rate cap ~8/s (prefer arrivals when crowded)
    const now = performance.now();
    this.recentMelodic = this.recentMelodic.filter((t) => now - t < 1000);
    if (this.recentMelodic.length >= 8 && !isArrival) return;
    // per-route polyphony cap
    const active = this.activePerRoute.get(routeId) || 0;
    if (active >= 4) return;
    this.recentMelodic.push(now);

    const { time, beat } = this.nextGridTime();
    const chord = this.chordAt(Math.max(0, beat));
    const p = directionId === 1 ? 1 - progress01 : progress01;
    const steps = chord.scale.length * 2; // two octaves of the scale
    const idx = Math.max(0, Math.min(steps - 1, Math.floor(p * steps)));
    const semis = chord.scale[idx % chord.scale.length] + (idx >= chord.scale.length ? 12 : 0);

    this.pendingNotes.push({
      routeId, time,
      midi: pitchMidi(semis, style.octave),
      hz: pitchHz(semis, style.octave),
      instrument: style.instrument,
      pan: style.pan || 0,
      vel: isArrival ? 0.8 : 0.55,
    });
  }

  // Commuter rail: a walking double-bass line. Trains are few and slow, so each
  // arrival plants one deep pizzicato note from the current chord's bass tones.
  triggerBassLine(progress01) {
    if (!this.ctx || !this.enabled.cr || this.mutedRoutes.has("CR")) return;
    const { time, beat } = this.nextGridTime();
    const chord = this.chordAt(Math.max(0, beat));
    const notes = chord.bassNotes;
    const semis = notes[Math.min(notes.length - 1, Math.floor(progress01 * notes.length))];
    if (!this.playSample("contrabass", pitchMidi(semis, 2), time, 0.6, -0.15, 1.8))
      this.contrabass(pitchHz(semis, 2), time, 0.75, -0.15);
  }

  triggerBell() {
    if (!this.ctx || !this.enabled.ferry || this.mutedRoutes.has("Boat")) return;
    const { time } = this.nextGridTime();
    if (!this.playSample("bell", pitchMidi(7, 5), time, 0.5, 0.4, null))
      this.bell(pitchHz(7, 5), time, 0.5);
  }

  playMelodic(n) {
    this.activePerRoute.set(n.routeId, (this.activePerRoute.get(n.routeId) || 0) + 1);
    setTimeout(() => {
      this.activePerRoute.set(n.routeId, Math.max(0, (this.activePerRoute.get(n.routeId) || 1) - 1));
    }, 2000);
    if (!this.playSample(n.instrument, n.midi, n.time, n.vel, n.pan)) {
      const fn = { rhodes: this.rhodes, vibes: this.vibes, trumpet: this.trumpet,
                   sax: this.sax, flute: this.flute, frenchhorn: this.frenchhorn,
                   tuba: this.tuba, violin: this.violin, celesta: this.celesta,
                   guitar: this.guitar }[n.instrument];
      if (fn) fn.call(this, n.hz, n.time, n.vel, n.pan);
    }
    if (this.onNotePlayed) {
      const delayMs = Math.max(0, (n.time - this.ctx.currentTime) * 1000);
      setTimeout(() => this.onNotePlayed(n.routeId), delayMs);
    }
  }

  // ---- shared voice plumbing ----
  out(pan) {
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan || 0;
    p.connect(this.master);
    return p;
  }

  // Percussive ring-out: fast attack, then a natural exponential tail with no
  // hard endpoint. `ring` is the perceived decay time; the caller must keep
  // its oscillators alive until ~t + ring * 1.6.
  strikeEnv(gainNode, t, peak, ring) {
    t = Math.max(0, t);   // humanized timing can nudge a note before zero
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + 0.005);
    g.setTargetAtTime(0.0001, t + 0.02, ring / 5);
  }

  // Sustained (wind) envelope: slow attack, held body, gentle release tail.
  windEnv(gainNode, t, peak, attack, hold, release) {
    t = Math.max(0, t);
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.setValueAtTime(peak, t + attack + hold);
    g.setTargetAtTime(0.0001, t + attack + hold, release / 3);
  }

  // Delayed vibrato onto an oscillator's frequency; caller stops the LFO.
  vibrato(osc, t, rateHz, depthHz, delay) {
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = rateHz;
    const depth = this.ctx.createGain();
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(depthHz, t + delay + 0.25);
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(t);
    return lfo;
  }

  // ---- melodic voices ----

  // Red Line: Rhodes-style electric piano. Warm strike, long ring, soft bark.
  rhodes(hz, t, vel, pan) {
    const dest = this.out(pan);
    const stop = t + 3.2;
    for (const [ratio, amp, ring] of [[1, 1, 1.6], [2.01, 0.22, 0.6], [5.04, 0.05, 0.15]]) {
      const o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = hz * ratio;
      const g = this.ctx.createGain();
      this.strikeEnv(g, t, vel * 0.27 * amp, ring);
      o.connect(g).connect(dest);
      o.start(t); o.stop(stop);
    }
  }

  // Green Line: vibraphone. Pure tone, slow tremolo, very long shimmering ring.
  vibes(hz, t, vel, pan) {
    const dest = this.out(pan);
    const stop = t + 4.5;
    const o = this.ctx.createOscillator();
    o.type = "sine"; o.frequency.value = hz;
    const o2 = this.ctx.createOscillator();
    o2.type = "sine"; o2.frequency.value = hz * 3.99;   // characteristic bar overtone
    const g = this.ctx.createGain();
    const g2 = this.ctx.createGain();
    this.strikeEnv(g, t, vel * 0.24, 2.8);
    this.strikeEnv(g2, t, vel * 0.06, 0.5);
    // motor tremolo — amplitude, not pitch
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 3.8;
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = vel * 0.09;
    lfo.connect(lfoG).connect(g.gain);
    o.connect(g).connect(dest); o2.connect(g2).connect(dest);
    o.start(t); o2.start(t); lfo.start(t);
    o.stop(stop); o2.stop(stop); lfo.stop(stop);
  }

  // Orange Line: harmon-muted trumpet. Breathy slow attack, buzzy formant,
  // held tone with vibrato — a horn phrase, not a key strike.
  trumpet(hz, t, vel, pan) {
    const dest = this.out(pan);
    const hold = 0.55, stop = t + 2.5;

    const o = this.ctx.createOscillator();
    o.type = "sawtooth"; o.frequency.value = hz;
    const lfo = this.vibrato(o, t, 5.5, hz * 0.012, 0.25);

    // harmon-mute "wah" formant: tight bandpass that opens slightly
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass"; f.Q.value = 7;
    f.frequency.setValueAtTime(Math.min(900, hz * 2), t);
    f.frequency.linearRampToValueAtTime(Math.min(1600, hz * 3.5), t + 0.35);
    const g = this.ctx.createGain();
    this.windEnv(g, t, vel * 0.72, 0.09, hold, 0.5);
    o.connect(f).connect(g).connect(dest);
    o.start(t); o.stop(stop); lfo.stop(stop);

    // breath noise at the attack
    const len = Math.ceil(this.ctx.sampleRate * 0.25);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const nz = this.ctx.createBufferSource();
    nz.buffer = buf;
    const nf = this.ctx.createBiquadFilter();
    nf.type = "bandpass"; nf.frequency.value = 2500; nf.Q.value = 1;
    const ng = this.ctx.createGain();
    this.windEnv(ng, t, vel * 0.03, 0.05, 0.05, 0.15);
    nz.connect(nf).connect(ng).connect(dest);
    nz.start(t); nz.stop(t + 0.25);
  }

  // Breath noise helper for wind voices: short filtered hiss at the attack.
  breath(dest, t, vel, freq, dur) {
    const len = Math.ceil(this.ctx.sampleRate * (dur + 0.05));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const nz = this.ctx.createBufferSource();
    nz.buffer = buf;
    const nf = this.ctx.createBiquadFilter();
    nf.type = "bandpass"; nf.frequency.value = freq; nf.Q.value = 1;
    const ng = this.ctx.createGain();
    this.windEnv(ng, t, vel, 0.04, dur * 0.4, dur * 0.5);
    nz.connect(nf).connect(ng).connect(dest);
    nz.start(t); nz.stop(t + dur + 0.05);
  }

  // Green E (Lechmere–Heath St): saxophone. Reedy saw+square blend through a
  // vocal-ish bandpass, breathy attack, confident vibrato.
  sax(hz, t, vel, pan) {
    const dest = this.out(pan);
    const hold = 0.5, stop = t + 2.4;
    const o = this.ctx.createOscillator();
    o.type = "sawtooth"; o.frequency.value = hz;
    const o2 = this.ctx.createOscillator();
    o2.type = "square"; o2.frequency.value = hz * 1.003;   // reedy beating
    const lfo = this.vibrato(o, t, 5.2, hz * 0.01, 0.28);
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = Math.min(1800, hz * 2.6); f.Q.value = 1.4;
    const g = this.ctx.createGain(); const g2 = this.ctx.createGain();
    this.windEnv(g, t, vel * 0.28, 0.07, hold, 0.4);
    this.windEnv(g2, t, vel * 0.1, 0.07, hold, 0.4);
    o.connect(f).connect(g).connect(dest);
    o2.connect(f);
    f.connect(g2);   // square shares the formant filter
    this.breath(dest, t, vel * 0.035, 1900, 0.2);
    o.start(t); o2.start(t);
    o.stop(stop); o2.stop(stop); lfo.stop(stop);
  }

  // Green B (to Boston College): flute. Nearly pure tone, airy attack,
  // gentle vibrato, floats above the band.
  flute(hz, t, vel, pan) {
    const dest = this.out(pan);
    const hold = 0.55, stop = t + 2.4;
    const o = this.ctx.createOscillator();
    o.type = "sine"; o.frequency.value = hz;
    const o2 = this.ctx.createOscillator();
    o2.type = "triangle"; o2.frequency.value = hz;       // faint upper harmonics
    const lfo = this.vibrato(o, t, 5.4, hz * 0.008, 0.25);
    const g = this.ctx.createGain(); const g2 = this.ctx.createGain();
    this.windEnv(g, t, vel * 0.3, 0.06, hold, 0.4);
    this.windEnv(g2, t, vel * 0.06, 0.06, hold, 0.4);
    o.connect(g).connect(dest); o2.connect(g2).connect(dest);
    this.breath(dest, t, vel * 0.045, 3200, 0.5);        // continuous airiness
    o.start(t); o2.start(t);
    o.stop(stop); o2.stop(stop); lfo.stop(stop);
  }

  // Green C (to Cleveland Circle): french horn. Dark, round, noble —
  // detuned saws through a heavy lowpass with a soft swelling attack.
  frenchhorn(hz, t, vel, pan) {
    const dest = this.out(pan);
    const hold = 0.6, stop = t + 2.8;
    for (const [ratio, amp] of [[1, 1], [1.004, 0.7]]) {
      const o = this.ctx.createOscillator();
      o.type = "sawtooth"; o.frequency.value = hz * ratio;
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = Math.min(750, hz * 2.2); f.Q.value = 0.5;
      const g = this.ctx.createGain();
      this.windEnv(g, t, vel * 0.34 * amp, 0.13, hold, 0.55);
      o.connect(f).connect(g).connect(dest);
      o.start(t); o.stop(stop);
    }
    // body: soft sine an octave below
    const ob = this.ctx.createOscillator();
    ob.type = "sine"; ob.frequency.value = hz / 2;
    const gb = this.ctx.createGain();
    this.windEnv(gb, t, vel * 0.1, 0.13, hold, 0.55);
    ob.connect(gb).connect(dest);
    ob.start(t); ob.stop(stop);
  }

  // Green D (Fenway–Riverside): tuba. Fat, round, bouncy low brass —
  // short "oom" notes with a tiny brassy blat at the front.
  tuba(hz, t, vel, pan) {
    const dest = this.out(pan);
    const stop = t + 1.8;
    const o = this.ctx.createOscillator();
    o.type = "triangle"; o.frequency.value = hz;
    const o2 = this.ctx.createOscillator();
    o2.type = "sine"; o2.frequency.value = hz;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 320; f.Q.value = 0.7;
    const g = this.ctx.createGain(); const g2 = this.ctx.createGain();
    this.windEnv(g, t, vel * 0.26, 0.05, 0.25, 0.3);
    this.windEnv(g2, t, vel * 0.16, 0.05, 0.25, 0.3);
    o.connect(f).connect(g).connect(dest);
    o2.connect(g2).connect(dest);
    // brassy blat at the attack
    const ob = this.ctx.createOscillator();
    ob.type = "sawtooth"; ob.frequency.value = hz;
    const fb = this.ctx.createBiquadFilter();
    fb.type = "lowpass"; fb.frequency.value = 600;
    const gb = this.ctx.createGain();
    this.strikeEnv(gb, t, vel * 0.12, 0.1);
    ob.connect(fb).connect(gb).connect(dest);
    o.start(t); o2.start(t); ob.start(t);
    o.stop(stop); o2.stop(stop); ob.stop(t + 0.4);
  }

  // Blue Line: violin. Bowed slow attack, singing sustain, prominent vibrato,
  // bright but rounded top.
  violin(hz, t, vel, pan) {
    const dest = this.out(pan);
    const hold = 0.7, stop = t + 3.0;
    for (const [ratio, amp] of [[1, 1], [1.006, 0.55]]) {
      const o = this.ctx.createOscillator();
      o.type = "sawtooth"; o.frequency.value = hz * ratio;
      const lfo = this.vibrato(o, t, 5.6, hz * 0.013, 0.2);
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = Math.min(3800, hz * 5); f.Q.value = 0.8;
      const f2 = this.ctx.createBiquadFilter();
      f2.type = "highpass"; f2.frequency.value = 250;
      const g = this.ctx.createGain();
      this.windEnv(g, t, vel * 0.24 * amp, 0.16, hold, 0.5);
      o.connect(f).connect(f2).connect(g).connect(dest);
      o.start(t); o.stop(stop); lfo.stop(stop);
    }
  }

  // Mattapan: celesta. Glassy, bright, quick but with a graceful tail.
  celesta(hz, t, vel, pan) {
    const dest = this.out(pan);
    const stop = t + 2.8;
    const o = this.ctx.createOscillator();
    o.type = "sine"; o.frequency.value = hz;
    const o2 = this.ctx.createOscillator();
    o2.type = "sine"; o2.frequency.value = hz * 2.98;
    const g = this.ctx.createGain(); const g2 = this.ctx.createGain();
    this.strikeEnv(g, t, vel * 0.22, 1.4);
    this.strikeEnv(g2, t, vel * 0.09, 0.4);
    o.connect(g).connect(dest); o2.connect(g2).connect(dest);
    o.start(t); o2.start(t); o.stop(stop); o2.stop(stop);
  }

  // Mattapan: jazz guitar. Warm plucked tone — quick pick attack, mellow body,
  // rolled-off highs like an archtop through a small amp.
  guitar(hz, t, vel, pan) {
    const dest = this.out(pan);
    const stop = t + 3.0;
    for (const [ratio, amp, ring] of [[1, 1, 1.5], [2, 0.35, 0.7], [3, 0.14, 0.35], [4, 0.06, 0.2]]) {
      const o = this.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = hz * ratio;
      const g = this.ctx.createGain();
      this.strikeEnv(g, t, vel * 0.25 * amp, ring);
      o.connect(g).connect(dest);
      o.start(t); o.stop(stop);
    }
    // pick transient
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = Math.min(3000, hz * 6); f.Q.value = 1.5;
    const len = Math.ceil(this.ctx.sampleRate * 0.05);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const nz = this.ctx.createBufferSource();
    nz.buffer = buf;
    const ng = this.ctx.createGain();
    this.strikeEnv(ng, t, vel * 0.05, 0.03);
    nz.connect(f).connect(ng).connect(dest);
    nz.start(t); nz.stop(t + 0.06);
  }

  // Commuter rail: pizzicato double bass — a deep, woody plucked note.
  contrabass(hz, t, vel, pan) {
    const dest = this.out(pan);
    const stop = t + 2.4;
    for (const [ratio, amp, ring] of [[1, 1, 1.1], [2, 0.3, 0.4], [3, 0.1, 0.2]]) {
      const o = this.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = hz * ratio;
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = 420; f.Q.value = 0.8;
      const g = this.ctx.createGain();
      this.strikeEnv(g, t, vel * 0.5 * amp, ring);
      o.connect(f).connect(g).connect(dest);
      o.start(t); o.stop(stop);
    }
  }

  // Commuter rail: low horn-section swell (two detuned saws + octave).
  horn(hz, t, vel) {
    const dest = this.out(-0.1);
    const stop = t + 3.5;
    for (const [ratio, amp] of [[1, 1], [1.006, 0.6], [2, 0.25]]) {
      const o = this.ctx.createOscillator();
      o.type = "sawtooth"; o.frequency.value = hz * ratio;
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = 750;
      const g = this.ctx.createGain();
      const gg = g.gain;
      gg.setValueAtTime(0.0001, t);
      gg.exponentialRampToValueAtTime(vel * 0.15 * amp, t + 0.6);
      gg.setValueAtTime(vel * 0.15 * amp, t + 1.1);
      gg.setTargetAtTime(0.0001, t + 1.1, 0.4);
      o.connect(f).connect(g).connect(dest);
      o.start(t); o.stop(stop);
    }
  }

  // Ferry: FM ship's bell, long fade.
  bell(hz, t, vel) {
    const dest = this.out(0.4);
    const stop = t + 4.5;
    const mod = this.ctx.createOscillator();
    mod.frequency.value = hz * 3.5;
    const modG = this.ctx.createGain();
    modG.gain.setValueAtTime(hz * 2, t);
    modG.gain.exponentialRampToValueAtTime(1, t + 2);
    const car = this.ctx.createOscillator();
    car.frequency.value = hz;
    mod.connect(modG).connect(car.frequency);
    const g = this.ctx.createGain();
    this.strikeEnv(g, t, vel * 0.4, 2.6);
    car.connect(g).connect(dest);
    mod.start(t); car.start(t); mod.stop(stop); car.stop(stop);
  }

  // ---- rhythm bed (opt-in) ----
  bassNote(semis, t, vel) {
    if (this.playSample("bass", pitchMidi(semis, 2), t, vel * 0.8, 0, 1.0)) return;
    const dest = this.out(0);
    const o = this.ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = pitchHz(semis, 2);
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 500;
    const g = this.ctx.createGain();
    this.strikeEnv(g, t, vel * 0.4, 0.5);
    o.connect(f).connect(g).connect(dest);
    o.start(t); o.stop(t + 1.2);
  }

  noiseBurst(t, vel, filterType, freq, q, decay) {
    t = Math.max(0, t);
    const len = Math.ceil(this.ctx.sampleRate * (decay + 0.1));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    this.strikeEnv(g, t, vel, decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + decay + 0.1);
  }

  ride(t, vel)  { this.noiseBurst(t, vel * 0.12, "bandpass", 5200, 1.2, 0.35); }
  hat(t, vel)   { this.noiseBurst(t, vel * 0.10, "highpass", 7000, 1, 0.06); }
  shaker(t, vel){ this.noiseBurst(t, vel * 0.5, "bandpass", 6800, 2.5, 0.05); }

  // Brush sweep: soft noise that swells and falls across most of a beat.
  sweep(t, vel) {
    t = Math.max(0, t);
    const dur = this.secPerBeat * 0.8;
    const len = Math.ceil(this.ctx.sampleRate * (dur + 0.1));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass"; f.Q.value = 0.8;
    f.frequency.setValueAtTime(1800, t);
    f.frequency.linearRampToValueAtTime(3600, t + dur);   // the sweep itself
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + dur + 0.1);
  }
}
