// Hopshot audio: every sound is synthesised with WebAudio (no files).
// Positional sounds use manual distance attenuation + stereo pan + distance low-pass.

// Fire sounds are named after the guns (shared/weapons.js GUNS[].key); 'rifle' / 'scout' / 'shotgun'
// are the old slot names and play the slot's first gun. Reload sounds take opts.dur (seconds) so the
// click-clack timeline stretches over this gun's real reload time.
export const GUN_SOUNDS = ['maul', 'vireo', 'kestrel', 'halberd', 'breaker', 'squall'];
export const SOUND_NAMES = [...GUN_SOUNDS, 'rifle', 'scout', 'shotgun', 'reload', 'reload_rifle', 'reload_sniper', 'reload_shotgun',
  'bolt', 'pump', 'empty', 'switch', 'hit', 'headshot', 'kill', 'hurt', 'death', 'jump', 'land', 'slide', 'step'];

export function createAudio() {
  let ctx = null, master = null, noiseBuf = null;
  let volume = 0.7;
  let lx = 0, ly = 0, lz = 0, lyaw = 0;
  let active = 0;
  let PM = 1;                // pitch multiplier for the voice being built (reload family)
  const MAX_VOICES = 28;

  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) { ctx = null; return false; }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.15;
    master = ctx.createGain();
    master.gain.value = volume * volume;
    master.connect(comp); comp.connect(ctx.destination);
    // 1.5 s of white noise, shared by every noise voice
    const n = Math.floor(ctx.sampleRate * 1.5);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  function unlock() {
    if (!ensure()) return;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, +v || 0));
    if (master) master.gain.setTargetAtTime(volume * volume, ctx.currentTime, 0.02);
  }
  function setListener(x, y, z, yaw) { lx = x; ly = y; lz = z; lyaw = yaw; }

  // --- voice building blocks. `o` is the voice output node, `t` the start time ---
  function noise(o, t, dur, { type = 'bandpass', f0 = 1000, f1 = f0, q = 0.8, gain = 0.5, attack = 0.002, curve = 3 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0 * PM, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * PM), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setTargetAtTime(0.0001, t + attack, dur / curve);
    src.connect(f); f.connect(g); g.connect(o);
    src.start(t, Math.random() * 1.0);
    src.stop(t + dur + 0.05);
  }
  function tone(o, t, dur, { type = 'sine', f0 = 440, f1 = f0, gain = 0.4, attack = 0.002, curve = 3 } = {}) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0 * PM, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * PM), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setTargetAtTime(0.0001, t + attack, dur / curve);
    osc.connect(g); g.connect(o);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  // a bolt-action cycle: lift, pull back, push forward, lock. k scales loudness.
  function bolt(o, t, k) {
    noise(o, t, 0.04, { f0: 2200, q: 4, gain: 0.35 * k }); tone(o, t, 0.04, { type: 'square', f0: 300, f1: 200, gain: 0.07 * k });
    noise(o, t + 0.09, 0.1, { f0: 700, f1: 1200, q: 1.5, gain: 0.14 * k, attack: 0.03 });
    noise(o, t + 0.2, 0.05, { f0: 1600, q: 4, gain: 0.4 * k }); tone(o, t + 0.2, 0.05, { f0: 140, f1: 90, gain: 0.2 * k });
    noise(o, t + 0.28, 0.05, { f0: 2400, q: 4, gain: 0.45 * k }); tone(o, t + 0.28, 0.06, { type: 'square', f0: 260, f1: 160, gain: 0.08 * k });
  }
  // a pump-action rack: forend back, forend forward
  function pump(o, t, k) {
    noise(o, t, 0.06, { f0: 1100, f1: 700, q: 2.5, gain: 0.5 * k }); tone(o, t, 0.06, { type: 'square', f0: 200, f1: 120, gain: 0.1 * k });
    noise(o, t + 0.13, 0.07, { f0: 1900, f1: 1300, q: 3, gain: 0.55 * k }); tone(o, t + 0.13, 0.07, { f0: 130, f1: 70, gain: 0.3 * k });
  }

  const SOUNDS = {
    // ---- guns: each has its own weight, pitch and tail
    maul(o, t) {      // heavy battle rifle: deep thump, mid bark, short rumble
      noise(o, t, 0.13, { f0: 1700, f1: 520, q: 0.7, gain: 0.8, curve: 4 });
      noise(o, t, 0.04, { type: 'highpass', f0: 3800, gain: 0.3 });
      tone(o, t, 0.16, { f0: 150, f1: 42, gain: 1.0, curve: 4 });
      tone(o, t, 0.09, { type: 'sawtooth', f0: 210, f1: 90, gain: 0.16, curve: 4 });
      noise(o, t + 0.06, 0.14, { type: 'lowpass', f0: 700, f1: 200, gain: 0.18 });
    },
    vireo(o, t) {     // light carbine: bright, snappy tick
      noise(o, t, 0.07, { f0: 3400, f1: 1500, q: 0.9, gain: 0.55, curve: 4 });
      noise(o, t, 0.025, { type: 'highpass', f0: 6000, gain: 0.32 });
      tone(o, t, 0.07, { f0: 300, f1: 105, gain: 0.55, curve: 4 });
      tone(o, t, 0.03, { type: 'square', f0: 1900, f1: 1200, gain: 0.05, curve: 4 });
    },
    kestrel(o, t) {   // light bolt-action: sharp crack, medium boom, echo, then the bolt
      noise(o, t, 0.3, { type: 'lowpass', f0: 4800, f1: 400, q: 0.5, gain: 0.85, curve: 4 });
      noise(o, t, 0.04, { type: 'highpass', f0: 3600, gain: 0.55 });
      tone(o, t, 0.24, { f0: 175, f1: 48, gain: 0.85, curve: 4 });
      tone(o, t + 0.005, 0.4, { type: 'triangle', f0: 1700, f1: 1500, gain: 0.06, curve: 5 });
      noise(o, t + 0.1, 0.3, { type: 'lowpass', f0: 1400, f1: 300, gain: 0.2, curve: 3 });
      bolt(o, t + 0.5, 1.0);
    },
    halberd(o, t) {   // heavy rifle: huge low boom, long tail, slow bolt
      noise(o, t, 0.6, { type: 'lowpass', f0: 3600, f1: 160, q: 0.5, gain: 1.1, curve: 4 });
      noise(o, t, 0.06, { type: 'highpass', f0: 2400, gain: 0.55 });
      tone(o, t, 0.6, { f0: 100, f1: 24, gain: 1.2, curve: 4 });
      tone(o, t, 0.2, { type: 'sawtooth', f0: 140, f1: 50, gain: 0.2, curve: 4 });
      noise(o, t + 0.14, 0.6, { type: 'lowpass', f0: 900, f1: 150, gain: 0.3, curve: 3 });
      noise(o, t + 0.3, 0.45, { type: 'lowpass', f0: 500, f1: 120, gain: 0.14, curve: 3 });
      bolt(o, t + 0.8, 0.8);
    },
    breaker(o, t) {   // pump shotgun: wide blast, then the pump racks
      noise(o, t, 0.3, { type: 'lowpass', f0: 3200, f1: 230, q: 0.5, gain: 1.0, curve: 4 });
      noise(o, t, 0.05, { type: 'highpass', f0: 2500, gain: 0.5 });
      tone(o, t, 0.3, { f0: 112, f1: 32, gain: 1.0, curve: 4 });
      noise(o, t + 0.07, 0.22, { type: 'lowpass', f0: 900, f1: 200, gain: 0.2 });
      pump(o, t + 0.36, 1.0);
    },
    squall(o, t) {    // auto shotgun: short, punchy pops with a metallic rattle
      noise(o, t, 0.13, { type: 'lowpass', f0: 2600, f1: 320, q: 0.6, gain: 0.85, curve: 4 });
      noise(o, t, 0.03, { type: 'highpass', f0: 3000, gain: 0.4 });
      tone(o, t, 0.13, { f0: 150, f1: 48, gain: 0.85, curve: 4 });
      tone(o, t + 0.01, 0.06, { type: 'square', f0: 700, f1: 420, gain: 0.07, curve: 4 });
    },
    // old slot names
    rifle(o, t, op) { SOUNDS.maul(o, t, op); },
    scout(o, t, op) { SOUNDS.kestrel(o, t, op); },
    shotgun(o, t, op) { SOUNDS.breaker(o, t, op); },

    // ---- handling
    bolt(o, t) { bolt(o, t, 1); },
    pump(o, t) { pump(o, t, 1); },
    reload(o, t, op) { SOUNDS.reload_rifle(o, t, op); },
    reload_rifle(o, t, op) {      // mag out, mag in, charging handle
      const d = Math.max(0.5, (op && op.dur) || 2.2);
      noise(o, t + d * 0.12, 0.05, { f0: 900, q: 3, gain: 0.5 }); tone(o, t + d * 0.12, 0.05, { type: 'square', f0: 220, f1: 140, gain: 0.12 });
      noise(o, t + d * 0.2, 0.18, { f0: 500, f1: 900, q: 1.2, gain: 0.12, attack: 0.05 });
      noise(o, t + d * 0.58, 0.06, { f0: 1300, q: 3, gain: 0.55 }); tone(o, t + d * 0.58, 0.08, { f0: 120, f1: 70, gain: 0.35 });
      noise(o, t + d * 0.84, 0.04, { f0: 2800, q: 4, gain: 0.5 });
      noise(o, t + d * 0.84 + 0.08, 0.05, { f0: 2000, q: 4, gain: 0.55 });
      tone(o, t + d * 0.84 + 0.08, 0.05, { type: 'square', f0: 330, f1: 200, gain: 0.1 });
    },
    reload_sniper(o, t, op) {     // mag out and in, then a full bolt cycle
      const d = Math.max(0.6, (op && op.dur) || 2.4);
      noise(o, t + d * 0.1, 0.06, { f0: 800, q: 3, gain: 0.5 }); tone(o, t + d * 0.1, 0.06, { type: 'square', f0: 180, f1: 120, gain: 0.12 });
      noise(o, t + d * 0.5, 0.07, { f0: 1100, q: 3, gain: 0.6 }); tone(o, t + d * 0.5, 0.1, { f0: 100, f1: 60, gain: 0.4 });
      bolt(o, t + d * 0.8, 1.0);
    },
    reload_shotgun(o, t, op) {    // shells go in one at a time, then the action closes
      const d = Math.max(0.6, (op && op.dur) || 2.2);
      const n = 5;
      for (let i = 0; i < n; i++) {
        const tt = t + d * (0.08 + (0.74 * i) / n);
        noise(o, tt, 0.05, { f0: 1500 + i * 60, q: 3.5, gain: 0.5 }); tone(o, tt, 0.06, { f0: 150, f1: 90, gain: 0.3 });
        noise(o, tt + 0.05, 0.03, { f0: 2600, q: 4, gain: 0.25 });
      }
      pump(o, t + d * 0.88, 1.0);
    },
    empty(o, t) {
      tone(o, t, 0.04, { type: 'triangle', f0: 1400, f1: 800, gain: 0.35, curve: 5 });
      noise(o, t, 0.03, { f0: 3000, q: 2, gain: 0.25 });
    },
    switch(o, t) {
      noise(o, t, 0.14, { f0: 500, f1: 2200, q: 1.2, gain: 0.3, attack: 0.04 });
      noise(o, t + 0.1, 0.04, { f0: 1800, q: 4, gain: 0.45 });
      tone(o, t + 0.1, 0.05, { type: 'square', f0: 260, f1: 170, gain: 0.08 });
    },
    hit(o, t) {
      tone(o, t, 0.07, { type: 'triangle', f0: 1700, f1: 1500, gain: 0.5, curve: 5 });
      noise(o, t, 0.02, { type: 'highpass', f0: 5000, gain: 0.2 });
    },
    headshot(o, t) {
      tone(o, t, 0.12, { type: 'triangle', f0: 2300, f1: 2200, gain: 0.5, curve: 4 });
      tone(o, t + 0.045, 0.16, { type: 'triangle', f0: 3100, f1: 3000, gain: 0.45, curve: 4 });
      noise(o, t, 0.03, { type: 'highpass', f0: 5000, gain: 0.3 });
    },
    kill(o, t) {
      const notes = [660, 880, 1320];
      for (let i = 0; i < 3; i++) {
        tone(o, t + i * 0.07, 0.16, { type: 'square', f0: notes[i], gain: 0.13, curve: 4 });
        tone(o, t + i * 0.07, 0.2, { type: 'triangle', f0: notes[i] * 2, gain: 0.12, curve: 4 });
      }
    },
    hurt(o, t) {
      noise(o, t, 0.16, { type: 'lowpass', f0: 700, f1: 200, gain: 0.7, curve: 3 });
      tone(o, t, 0.18, { type: 'sawtooth', f0: 220, f1: 110, gain: 0.25, curve: 3 });
      tone(o, t, 0.12, { f0: 90, f1: 55, gain: 0.5 });
    },
    death(o, t) {
      tone(o, t, 0.7, { type: 'sawtooth', f0: 320, f1: 55, gain: 0.3, curve: 3 });
      noise(o, t, 0.6, { type: 'lowpass', f0: 1200, f1: 120, gain: 0.5, curve: 3 });
      tone(o, t, 0.5, { f0: 100, f1: 38, gain: 0.7, curve: 3 });
    },
    jump(o, t) {
      noise(o, t, 0.16, { f0: 350, f1: 1000, q: 0.9, gain: 0.25, attack: 0.03 });
      tone(o, t, 0.08, { f0: 150, f1: 220, gain: 0.12 });
    },
    land(o, t) {
      tone(o, t, 0.14, { f0: 130, f1: 48, gain: 0.7, curve: 4 });
      noise(o, t, 0.12, { type: 'lowpass', f0: 800, f1: 250, gain: 0.5, curve: 4 });
    },
    slide(o, t) {
      noise(o, t, 0.55, { f0: 700, f1: 1700, q: 0.7, gain: 0.32, attack: 0.08, curve: 2 });
      noise(o, t, 0.5, { type: 'highpass', f0: 3000, gain: 0.08, attack: 0.1, curve: 2 });
    },
    step(o, t) {
      const f = 260 + Math.random() * 220;
      noise(o, t, 0.07, { f0: f, q: 1.2, gain: 0.4, curve: 4 });
      tone(o, t, 0.06, { f0: 90 + Math.random() * 30, f1: 60, gain: 0.25 });
    },
  };

  const LIFE = { kestrel: 1200, halberd: 2000, breaker: 900, death: 1100, bolt: 600, pump: 500 };

  function play(name, opts) {
    const fn = SOUNDS[name];
    if (!fn || !ensure()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (ctx.state !== 'running' && ctx.state !== 'suspended') return;
    if (active >= MAX_VOICES) return;

    let vol = opts && opts.volume != null ? opts.volume : 1;
    let pan = 0, lp = 0;
    const pos = opts && opts.pos;
    if (pos) {
      const dx = pos[0] - lx, dy = pos[1] - ly, dz = pos[2] - lz;
      const d = Math.hypot(dx, dy, dz);
      if (d > 90) return;
      vol *= 1 / (1 + d * d * 0.012);
      if (vol < 0.02) return;
      if (d > 0.5) {
        // listener right vector = (cos yaw, 0, -sin yaw)
        pan = Math.max(-1, Math.min(1, (dx * Math.cos(lyaw) - dz * Math.sin(lyaw)) / d)) * 0.85;
      }
      lp = Math.max(1500, 16000 / (1 + d * 0.09));
    }

    const out = ctx.createGain();
    out.gain.value = vol;
    let tail = out;
    if (lp) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; f.Q.value = 0.4;
      out.connect(f); tail = f;
    }
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      tail.connect(p); tail = p;
    }
    tail.connect(master);

    active++;
    const t = ctx.currentTime + 0.005;
    PM = (opts && opts.pitch) || 1;
    fn(out, t, opts);
    PM = 1;
    const life = LIFE[name] || (name.startsWith('reload') ? 400 + ((opts && opts.dur) || 2.4) * 1000 : 700);
    setTimeout(() => { active--; try { out.disconnect(); } catch (e) { /* already gone */ } }, life);
  }

  return { unlock, setVolume, setListener, play, names: SOUND_NAMES, get context() { return ctx; } };
}
