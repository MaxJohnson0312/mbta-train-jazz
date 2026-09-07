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
const pitchHz = (semitoneFromC, octave) => midiHz(12 * (octave + 1) + semitoneFromC);

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
  }

  async start() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
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

    if (!this.enabled.rhythm) return;   // bed is opt-in

    // Walking bass: quarter notes
    this.bassNote(chord.bassNotes[beatInBar], t, 0.9 - Math.random() * 0.15);

    // Drums
    const density = this.enabled.buses ? this.busDensity : 0.35;
    this.ride(t, 0.5 + density * 0.3);                       // downbeat ride
    if (density > 0.15) this.ride(t + this.secPerBeat * SWING, 0.25 + density * 0.35); // swung off-8th
    if (beatInBar === 1 || beatInBar === 3) this.hat(t, 0.5);
    if (density > 0.6 && Math.random() < density - 0.4) this.shaker(t + this.secPerBeat * 0.5, 0.15);
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
    if (!style) return;

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
      hz: pitchHz(semis, style.octave),
      instrument: style.instrument,
      pan: style.pan || 0,
      vel: isArrival ? 0.8 : 0.55,
    });
  }

  triggerHorn(progress01) {
    if (!this.ctx || !this.enabled.cr) return;
    const { time, beat } = this.nextGridTime();
    const chord = this.chordAt(Math.max(0, beat));
    const semis = chord.root + (progress01 > 0.5 ? 7 : 0);
    this.horn(pitchHz(semis, 3), time, 0.5);
  }

  triggerBell() {
    if (!this.ctx || !this.enabled.ferry) return;
    const { time } = this.nextGridTime();
    this.bell(pitchHz(7, 5), time, 0.5);
  }

  playMelodic(n) {
    this.activePerRoute.set(n.routeId, (this.activePerRoute.get(n.routeId) || 0) + 1);
    setTimeout(() => {
      this.activePerRoute.set(n.routeId, Math.max(0, (this.activePerRoute.get(n.routeId) || 1) - 1));
    }, 2000);
    const fn = { rhodes: this.rhodes, vibes: this.vibes, trumpet: this.trumpet,
                 clarinet: this.clarinet, celesta: this.celesta }[n.instrument];
    if (fn) fn.call(this, n.hz, n.time, n.vel, n.pan);
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
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + 0.005);
    g.setTargetAtTime(0.0001, t + 0.02, ring / 5);
  }

  // Sustained (wind) envelope: slow attack, held body, gentle release tail.
  windEnv(gainNode, t, peak, attack, hold, release) {
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
      this.strikeEnv(g, t, vel * 0.22 * amp, ring);
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
    this.windEnv(g, t, vel * 0.5, 0.09, hold, 0.5);
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

  // Blue Line: clarinet. Hollow odd-harmonic square, soft round attack,
  // held woody tone, light late vibrato.
  clarinet(hz, t, vel, pan) {
    const dest = this.out(pan);
    const hold = 0.6, stop = t + 2.6;

    const o = this.ctx.createOscillator();
    o.type = "square"; o.frequency.value = hz;
    const lfo = this.vibrato(o, t, 4.8, hz * 0.006, 0.35);
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = Math.min(2200, hz * 4); f.Q.value = 0.7;
    const g = this.ctx.createGain();
    this.windEnv(g, t, vel * 0.16, 0.11, hold, 0.45);   // square is loud; keep gain low
    o.connect(f).connect(g).connect(dest);

    // warm fundamental reinforcement
    const o2 = this.ctx.createOscillator();
    o2.type = "sine"; o2.frequency.value = hz;
    const g2 = this.ctx.createGain();
    this.windEnv(g2, t, vel * 0.12, 0.11, hold, 0.45);
    o2.connect(g2).connect(dest);

    o.start(t); o2.start(t);
    o.stop(stop); o2.stop(stop); lfo.stop(stop);
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
    this.strikeEnv(g, t, vel * 0.25, 2.6);
    car.connect(g).connect(dest);
    mod.start(t); car.start(t); mod.stop(stop); car.stop(stop);
  }

  // ---- rhythm bed (opt-in) ----
  bassNote(semis, t, vel) {
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
}
