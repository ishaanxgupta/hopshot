// Hopshot audio: every sound is synthesised with WebAudio (no files).
// Positional sounds use manual distance attenuation + stereo pan + distance low-pass.

export const SOUND_NAMES = ['rifle', 'scout', 'shotgun', 'reload', 'empty', 'switch', 'hit', 'headshot', 'kill',
  'hurt', 'death', 'jump', 'land', 'slide', 'step'];

export function createAudio() {
  let ctx = null, master = null, noiseBuf = null;
  let volume = 0.7;
  let lx = 0, ly = 0, lz = 0, lyaw = 0;
  let active = 0;
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
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
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
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setTargetAtTime(0.0001, t + attack, dur / curve);
    osc.connect(g); g.connect(o);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  const SOUNDS = {
    rifle(o, t) {
      noise(o, t, 0.1, { f0: 2400, f1: 900, q: 0.7, gain: 0.7, curve: 4 });
      noise(o, t, 0.035, { type: 'highpass', f0: 4500, gain: 0.35 });
      tone(o, t, 0.12, { f0: 190, f1: 55, gain: 0.8, curve: 4 });
    },
    scout(o, t) {
      noise(o, t, 0.4, { type: 'lowpass', f0: 4200, f1: 300, q: 0.5, gain: 1.0, curve: 4 });
      noise(o, t, 0.05, { type: 'highpass', f0: 3000, gain: 0.5 });
      tone(o, t, 0.34, { f0: 130, f1: 35, gain: 1.0, curve: 4 });
      tone(o, t + 0.01, 0.5, { type: 'triangle', f0: 1500, f1: 1400, gain: 0.07, curve: 5 });
      noise(o, t + 0.11, 0.35, { type: 'lowpass', f0: 1200, f1: 250, gain: 0.25, curve: 3 }); // echo tail
    },
    shotgun(o, t) {
      noise(o, t, 0.28, { type: 'lowpass', f0: 3200, f1: 250, q: 0.5, gain: 1.0, curve: 4 });
      noise(o, t, 0.05, { type: 'highpass', f0: 2500, gain: 0.5 });
      tone(o, t, 0.28, { f0: 110, f1: 32, gain: 1.0, curve: 4 });
      noise(o, t + 0.07, 0.2, { type: 'lowpass', f0: 900, f1: 200, gain: 0.2 });
    },
    reload(o, t) {
      noise(o, t, 0.05, { f0: 900, q: 3, gain: 0.5 }); tone(o, t, 0.05, { type: 'square', f0: 220, f1: 140, gain: 0.12 });
      noise(o, t + 0.55, 0.06, { f0: 1300, q: 3, gain: 0.55 }); tone(o, t + 0.55, 0.08, { f0: 120, f1: 70, gain: 0.35 });
      noise(o, t + 1.1, 0.04, { f0: 2800, q: 4, gain: 0.5 });
      noise(o, t + 1.18, 0.05, { f0: 2000, q: 4, gain: 0.55 });
      tone(o, t + 1.18, 0.05, { type: 'square', f0: 330, f1: 200, gain: 0.1 });
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
    fn(out, t);
    const life = name === 'reload' ? 1500 : name === 'scout' || name === 'death' ? 1100 : 700;
    setTimeout(() => { active--; try { out.disconnect(); } catch (e) { /* already gone */ } }, life);
  }

  return { unlock, setVolume, setListener, play, names: SOUND_NAMES, get context() { return ctx; } };
}
