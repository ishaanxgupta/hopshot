// Hopshot voice chat: a peer-to-peer WebRTC audio mesh between the humans of a PRIVATE room.
//
//   const voice = createVoice({ net, audio, touch, settings, onChange(), onNotice(text) });
//   main.js wires net events to: onWelcome(), sync() (join / leave / team / lobby / match),
//   onSignal({ from, d }), onVoiceState(), onClose(); calls frame(t, players, listener) every
//   frame and shutdown() on pagehide. UI: toggleMic(), setPtt(down), toggleSpeaker(),
//   setPeerMuted(id, m), setPeerVolume(id, v), configure(settings); read view / info(id) /
//   isSpeaking(id). `version` changes whenever something the UI shows (other than the speaking
//   flags, see `speakVersion`) changes.
//
// Who hears whom (protocol.voiceAllowed): team modes during countdown / playing -> teammates
// only; free-for-all, and lobby / results of every mode -> everyone in the room. Enforced on the
// SENDING side: each peer has one audio transceiver and its sender carries the microphone track
// only while that peer is allowed to hear us (and has not turned their speaker off); otherwise
// RTCRtpSender.replaceTrack(null) - nothing is sent to them at all. Re-evaluated on every team /
// phase / roster / voice-state change. The listener side also silences peers it may not hear.
//
// Signaling: the "perfect negotiation" pattern over the game WebSocket (net.sendRtc). The lower
// player id adds the transceiver and makes the offer (impolite); the higher id answers (polite).
// ICE restarts on failure (the offerer restarts, with backoff); a peer that cannot be reached
// gets a notice ("Voice can't reach Nova (network)"). ICE servers come from the server's welcome.
//
// Audio: remote streams are played through WebAudio (audio.js's AudioContext): per peer
// source -> analyser (speaking detection) and source -> gain (user volume / mute / policy) ->
// proximity gain -> [dry | HRTF/equal-power panner] -> voice bus -> destination. Chrome only
// feeds a remote MediaStream into WebAudio while the stream is also attached to a media element,
// so each one is attached to a muted <audio>. Proximity (setting, match phase 'playing' only):
// volume falls off with distance (FFA silent beyond FFA_RANGE m; teammates never below
// TEAM_FLOOR) and the voice is panned to where the speaker is relative to the camera yaw.
// Elsewhere it is plain, centred, full volume. Per-frame work is throttled and allocation-free.
//
// Relay fallback (protocol.js VOICE RELAY): when a pair has not reached 'connected' RELAY_AFTER_MS
// after its P2P attempt started (RELAY_DISC_MS after a working link dropped), or ICE failed, that
// pair switches to the relay; when P2P connects again it switches back. Each side decides alone
// from its own RTCPeerConnection, and the ICE restarts keep running in the background. Sending:
// the microphone source -> AudioWorklet (resampled to 48 kHz, 20 ms blocks) -> WebCodecs
// AudioEncoder (Opus mono ~24 kbps) -> one binary frame per 20 ms over the game WebSocket, addressed
// to the relay-mode peers that the SAME gate as setSending() allows (transmitting, voiceAllowed,
// not deaf) and that can play it (roster `relay`). Receiving: AudioDecoder per sender -> AudioBuffers
// scheduled into that peer's existing chain (relayIn -> analyser + gain -> prox -> dry/pan -> bus),
// so mute, volume, proximity, panning and speaking indicators work the same. A small adaptive
// jitter buffer (JB_START, grows on underruns, drops frames that would play far behind) keeps
// latency bounded. Relayed audio is played only while this side's P2P link to the sender is NOT
// connected (never twice). Without AudioEncoder / AudioDecoder / AudioWorklet the client stays
// P2P-only and says so once. Each pair's outcome (p2p / relay / failed + ICE candidate TYPES) is
// reported to the server ('vstat') for its log.
// Test hooks (URL, via main.js): voicetest=1 replaces getUserMedia with an oscillator tone;
// voice=relay skips P2P (relay only); voice=p2p turns the relay off.

import { voiceAllowed, VOICE_MAX_PAYLOAD } from '../shared/protocol.js';

const NEAR = 4;              // m: full volume inside this
const FFA_RANGE = 45;        // m: silent beyond this (free-for-all)
const TEAM_FLOOR = 0.35;     // teammates never quieter than this
const PROX_EVERY_MS = 50;
const LEVEL_EVERY_MS = 60;
const SPEAK_ON = 0.018;      // RMS (0..1) that counts as speech
const SPEAK_OFF = 0.010;
const SPEAK_HOLD_MS = 320;
const MIC_IDLE_MS = 60000;   // push-to-talk keeps the microphone open this long after the last use
const CONNECT_TIMEOUT_MS = 20000;
const RESTART_DELAYS = [3000, 10000, 30000];
const STATE_GAP_MS = 150;
// relay
const RELAY_AFTER_MS = 5000;   // P2P not connected this long after the attempt started -> relay
const RELAY_DISC_MS = 3000;    // a link that was up and is down this long -> relay
const RELAY_CHECK_MS = 250;    // relay decisions run on a timer (rAF stops in background tabs)
const RELAY_BITRATE = 24000;
const FRAME_SAMPLES = 960;     // 20 ms at 48 kHz
const FRAME_US = 20000;
const DEC_CFG = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 };
const JB_START = 0.08, JB_MIN = 0.06, JB_MAX = 0.24, JB_STEP = 0.02;   // jitter buffer target (s)
const JB_SLACK = 0.1;          // a frame that would play more than target + this ahead is dropped
const JB_CALM_MS = 5000;       // no underrun for this long -> target shrinks by 10 ms
const VSTAT_GAP_MS = 1500;     // per pair, between two reports
const CAND_TYPES = ['host', 'srflx', 'prflx', 'relay'];

// Capture worklet (inlined; loaded from a Blob URL): mono input -> 48 kHz (linear resampling)
// -> one Float32Array of FRAME_SAMPLES per 20 ms posted to the main thread.
const WORKLET_SRC = `
class HopshotVoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.step = sampleRate / 48000; this.pos = 0; this.prev = 0; this.out = new Float32Array(${FRAME_SAMPLES}); this.n = 0; }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x || !x.length) return true;
    const len = x.length, step = this.step;
    let p = this.pos, n = this.n, out = this.out;
    while (p <= len - 1) {
      const i = Math.floor(p), f = p - i;
      const a = i < 0 ? this.prev : x[i];
      const b = i + 1 < len ? x[i + 1] : a;
      out[n++] = a + (b - a) * f;
      if (n === ${FRAME_SAMPLES}) { this.port.postMessage(out, [out.buffer]); out = new Float32Array(${FRAME_SAMPLES}); n = 0; }
      p += step;
    }
    this.pos = p - len; this.prev = x[len - 1]; this.n = n; this.out = out;
    return true;
  }
}
registerProcessor('hopshot-voice-capture', HopshotVoiceCapture);
`;

const supported = () => typeof RTCPeerConnection === 'function' && typeof MediaStream === 'function';

function loadPrefs() {
  try { const v = JSON.parse(sessionStorage.getItem('hopshot.voicePeers') || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export function createVoice(opts) {
  const net = opts.net, audio = opts.audio;
  const TOUCH = !!opts.touch;
  const onChange = opts.onChange || (() => {});
  const onNotice = opts.onNotice || (() => {});
  const cfg = { voiceVolume: 0.9, micDefault: false, pttKey: 'KeyV', proximity: true, noiseSuppression: true, echoCancellation: true };
  // test hooks: mode 'relay' = relay only (no RTCPeerConnection), 'p2p' = relay off; testTone = oscillator mic
  const FORCE_RELAY = opts.mode === 'relay', NO_RELAY = opts.mode === 'p2p';
  const TEST_TONE = !!opts.testTone;

  const S = {
    enabled: false, selfId: 0, ice: [],
    micWanted: false, ptt: false, pttUsed: false, autoTried: false,
    micState: 'off',          // off | pending | live | denied | nomic | error
    stream: null, track: null, micSrc: null, micAn: null, micBuf: null, micPromise: null, idleTimer: 0, toneOsc: null,
    spk: true,
    selfLevel: 0, selfSpeaking: false, selfSpeakUntil: 0,
    sentMic: false, sentDeaf: false, sentRelay: false, stateTimer: 0, stateSentAt: -1e9,
    relayCap: false, relayKnown: false, relayNoted: false,   // this browser can encode + decode the relay
    statTokens: 10, statAt: 0,                               // vstat budget (all pairs)
  };
  // relay sender: capture worklet + Opus encoder
  const CAP = { on: false, loading: null, failed: false, node: null, sink: null, src: null, enc: null, encCfg: null,
    ts: 0, seq: 0, sent: 0, skipped: 0, dropped: 0, encErrors: 0, encMs: 0, capAt: new Float64Array(64), ids: [],
    testSent: TEST_TONE ? new Float64Array(1024).fill(-1) : null };
  const peers = new Map();    // id -> peer
  const prefs = loadPrefs();  // lower-case name -> { m: muted, v: volume }
  let version = 1, speakVersion = 1;
  const changed = () => { version++; onChange(); };

  // ------------------------------------------------------------------ audio graph
  let ctx = null, bus = null, busComp = null;
  function ensureCtx() {
    if (ctx) return ctx;
    if (!audio.context) audio.unlock();
    ctx = audio.context;
    if (!ctx) return null;
    busComp = ctx.createDynamicsCompressor();
    busComp.threshold.value = -18; busComp.knee.value = 10; busComp.ratio.value = 4; busComp.attack.value = 0.005; busComp.release.value = 0.2;
    bus = ctx.createGain();
    bus.gain.value = busGain();
    bus.connect(busComp); busComp.connect(ctx.destination);
    return ctx;
  }
  function busGain() { return S.spk ? cfg.voiceVolume * cfg.voiceVolume * 1.6 : 0; }
  function setParam(p, v, tau) {
    if (!ctx) return;
    try { p.setTargetAtTime(v, ctx.currentTime, tau); } catch { p.value = v; }
  }
  // a user gesture resumes the shared context (the lobby can be reached without any click)
  const resume = () => { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); else if (!ctx && S.enabled) ensureCtx(); };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, resume, { capture: true, passive: true });

  // ------------------------------------------------------------------ helpers
  const roster = () => net.state.roster;
  const nameOf = (id) => { const e = roster().get(id); return e ? e.name : 'player ' + id; };
  const myTeam = () => net.state.match.myTeam || net.state.team || '';
  const transmitting = () => S.micState === 'live' && !!S.track && (S.micWanted || S.ptt);
  function prefFor(name) { return prefs[String(name || '').toLowerCase()] || null; }
  function savePrefs() { try { sessionStorage.setItem('hopshot.voicePeers', JSON.stringify(prefs)); } catch { /* storage off */ } }

  // ------------------------------------------------------------------ peers
  function createPeer(id) {
    const e = roster().get(id);
    const pf = prefFor(e && e.name);
    const peer = {
      id, polite: S.selfId > id, initiator: S.selfId < id,
      pc: null, sender: null, makingOffer: false, ignoreOffer: false, answerPending: false, chain: Promise.resolve(),
      state: 'new', since: performance.now(), restarts: 0, restartTimer: 0, discTimer: 0, noticed: false, closed: false,
      sendTrack: null,       // the track the sender carries (null = sending nothing)
      allowed: true, hear: true,
      mic: !!(e && e.mic), deaf: !!(e && e.deaf),
      muted: pf ? !!pf.m : false, volume: pf && Number.isFinite(pf.v) ? pf.v : 1,
      el: null, stream: null, src: null, an: null, buf: null, gain: null, prox: null, dry: null, wet: null, pan: null,
      level: 0, speaking: false, speakUntil: 0, hasAudio: false,
      proxG: 1, px: 0, py: 0, pz: -1, spatial: false, appliedGain: -1,
      // relay: relay = we send to it over the relay; relayCap = it can send + play relayed voice
      relay: false, relayCap: !!(e && e.relay), relayAt: 0, stuckAt: 0, wasUp: false, upAt: 0, timedOut: false,
      relayIn: null, postAn: null, rx: null,
      statSent: '', statAt: -1e9, statBusy: false,
    };
    if (FORCE_RELAY) {           // test hook: no peer-to-peer at all
      peers.set(id, peer);
      applyPeer(peer);
      return peer;
    }
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: S.ice, bundlePolicy: 'max-bundle' });
    } catch (err) {
      console.warn('[voice] RTCPeerConnection failed', err);
      peer.state = 'failed';
      peers.set(id, peer);
      return peer;
    }
    peer.pc = pc;
    pc.onicecandidate = (ev) => { if (ev.candidate && !peer.closed) net.sendRtc(id, { k: 'ice', c: ev.candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      if (peer.closed) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (!peer.closed && pc.localDescription) net.sendRtc(id, { k: 'sdp', type: pc.localDescription.type, sdp: pc.localDescription.sdp });
      } catch (err) { console.warn('[voice] offer failed', err); } finally { peer.makingOffer = false; }
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([ev.track]);
      attachRemote(peer, stream);
    };
    const onState = () => updateConnState(peer);
    pc.onconnectionstatechange = onState;
    pc.oniceconnectionstatechange = onState;
    if (peer.initiator) {
      try {
        const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
        peer.sender = tr.sender;
      } catch (err) { console.warn('[voice] addTransceiver failed', err); }
    }
    peers.set(id, peer);
    applyPeer(peer);
    return peer;
  }

  function closePeer(peer) {
    if (peer.closed) return;
    peer.closed = true;
    clearTimeout(peer.restartTimer); clearTimeout(peer.discTimer);
    try { if (peer.pc) peer.pc.close(); } catch { /* closed */ }
    if (peer.el) { try { peer.el.pause(); } catch { /* ignore */ } peer.el.srcObject = null; peer.el = null; }
    for (const k of ['src', 'relayIn', 'postAn', 'an', 'gain', 'prox', 'dry', 'wet', 'pan']) { if (peer[k]) { try { peer[k].disconnect(); } catch { /* gone */ } peer[k] = null; } }
    if (peer.rx && peer.rx.dec) { try { peer.rx.dec.close(); } catch { /* closed */ } peer.rx.dec = null; }
    peer.stream = null;
    peers.delete(peer.id);
  }
  function closeAll() { for (const p of Array.from(peers.values())) closePeer(p); }

  function updateConnState(peer) {
    const pc = peer.pc;
    if (!pc || peer.closed) return;
    const cs = pc.connectionState || '';
    const ics = pc.iceConnectionState || '';
    let s;
    if (cs === 'connected' || ics === 'connected' || ics === 'completed') s = 'connected';
    else if (cs === 'failed' || ics === 'failed') s = 'failed';
    else if (cs === 'disconnected' || ics === 'disconnected') s = 'disconnected';
    else if (cs === 'closed') s = 'closed';
    else s = 'connecting';
    if (s === peer.state) return;
    const prev = peer.state;
    peer.state = s;
    if (prev === 'connected') peer.since = performance.now();   // the watchdog times this outage
    clearTimeout(peer.discTimer);
    if (s === 'connected') {
      const told = peer.noticed;
      peer.restarts = 0; peer.noticed = false; peer.timedOut = false;
      peer.wasUp = true; peer.upAt = performance.now();
      if (prev === 'failed' && told) onNotice('Voice reconnected to ' + nameOf(peer.id));
      tuneSender(peer);
      stopRelayPlayback(peer);           // P2P carries this peer again: cut what the relay queued
    } else if (s === 'failed') {
      scheduleRestart(peer, true);
    } else if (s === 'disconnected') {
      // often recovers by itself (wifi blip); restart if it does not
      peer.discTimer = setTimeout(() => { if (!peer.closed && peer.state === 'disconnected') scheduleRestart(peer, false); }, 4000);
    }
    updateRelay(peer, performance.now());
    changed();
  }

  /** "Voice can't reach X" once per outage - only when the relay cannot cover for P2P either. */
  function cantReach(peer) {
    if (peer.noticed) return;
    peer.noticed = true;
    let text = "Voice can't reach " + nameOf(peer.id) + ' (network)';
    if (!S.relayNoted && S.relayKnown && !NO_RELAY && net.state.voice && net.state.voice.relay && !relayOn()) {
      S.relayNoted = true;
      text += " - this browser can't use the voice relay";
    }
    onNotice(text);
  }

  function scheduleRestart(peer, failed) {
    if (peer.closed) return;
    if (failed && !relayLink(peer)) cantReach(peer);
    if (!peer.pc || !peer.initiator || peer.restartTimer) return;       // the offerer drives restarts
    if (peer.restarts >= RESTART_DELAYS.length) return;
    const delay = RESTART_DELAYS[peer.restarts++];
    peer.restartTimer = setTimeout(() => {
      peer.restartTimer = 0;
      if (peer.closed || peer.state === 'connected') return;
      try { peer.pc.restartIce(); } catch { /* old browser: nothing to do */ }
    }, delay);
  }

  function tuneSender(peer) {
    const s = peer.sender;
    if (!s || !s.getParameters) return;
    try {
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) return;
      p.encodings[0].maxBitrate = 40000;
      s.setParameters(p).catch(() => {});
    } catch { /* unsupported */ }
  }

  /** Incoming signal (net 'rtc' event; d already sanitised). Processed in order per peer. */
  function onSignal(m) {
    if (!S.enabled || !m || m.from === S.selfId) return;
    let peer = peers.get(m.from);
    if (!peer) {
      const e = roster().get(m.from);
      if (e && e.bot) return;
      peer = createPeer(m.from);       // the server only relays from humans of this room
    }
    if (!peer.pc) return;
    const d = m.d;
    peer.chain = peer.chain.then(() => handleSignal(peer, d)).catch((err) => console.warn('[voice] signal', err));
  }

  async function handleSignal(peer, d) {
    const pc = peer.pc;
    if (peer.closed) return;
    if (d.k === 'sdp') {
      const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.answerPending);
      const collision = d.type === 'offer' && !ready;
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      peer.answerPending = d.type === 'answer';
      await pc.setRemoteDescription({ type: d.type, sdp: d.sdp });
      peer.answerPending = false;
      if (d.type === 'offer') {
        adoptTransceiver(peer);
        await pc.setLocalDescription();
        if (!peer.closed && pc.localDescription) net.sendRtc(peer.id, { k: 'sdp', type: pc.localDescription.type, sdp: pc.localDescription.sdp });
      }
    } else if (d.k === 'ice' && d.c) {
      try { await pc.addIceCandidate(d.c); } catch (err) { if (!peer.ignoreOffer) console.warn('[voice] candidate', err); }
    }
  }

  /** Answerer: use the transceiver the offer created, and make it send too (one m-line per pair). */
  function adoptTransceiver(peer) {
    if (peer.sender) return;
    const t = peer.pc.getTransceivers().find((x) => x.receiver && x.receiver.track && x.receiver.track.kind === 'audio');
    if (!t) return;
    if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
    peer.sender = t.sender;
    // apply the current gate to the new sender (it starts with no track)
    const want = peer.sendTrack;
    peer.sendTrack = undefined;
    setSending(peer, want || null);
  }

  // ------------------------------------------------------------------ remote audio
  /** The per-peer chain (P2P stream and relay both feed it): analyser + gain -> prox -> dry/pan -> bus. */
  function ensureChain(peer) {
    if (peer.gain) return true;
    if (peer.closed || !ensureCtx()) return false;
    peer.an = ctx.createAnalyser(); peer.an.fftSize = 512; peer.an.smoothingTimeConstant = 0;
    peer.buf = new Uint8Array(peer.an.fftSize);
    peer.gain = ctx.createGain();
    peer.prox = ctx.createGain();
    peer.dry = ctx.createGain(); peer.wet = ctx.createGain();
    peer.pan = ctx.createPanner();
    peer.pan.panningModel = TOUCH ? 'equalpower' : 'HRTF';
    peer.pan.distanceModel = 'linear'; peer.pan.refDistance = 1; peer.pan.maxDistance = 10000; peer.pan.rolloffFactor = 0;
    setPanPos(peer, 0, 0, -1, true);
    peer.dry.gain.value = 1; peer.wet.gain.value = 0;
    peer.gain.connect(peer.prox);
    peer.prox.connect(peer.dry); peer.dry.connect(bus);
    peer.prox.connect(peer.pan); peer.pan.connect(peer.wet); peer.wet.connect(bus);
    newRelayInput(peer);
    if (TEST_TONE) {               // test hook: level AFTER mute / volume (debug().peers[].postLevel)
      peer.postAn = ctx.createAnalyser(); peer.postAn.fftSize = 512; peer.postAn.smoothingTimeConstant = 0;
      peer.gain.connect(peer.postAn);
    }
    applyPeer(peer);               // mute / volume / policy gain on the new chain
    return true;
  }

  function attachRemote(peer, stream) {
    if (peer.closed) return;
    peer.stream = stream;
    if (!peer.el) {
      const el = document.createElement('audio');
      el.muted = true; el.autoplay = true; el.setAttribute('playsinline', '');
      peer.el = el;
    }
    peer.el.srcObject = stream;
    const pr = peer.el.play(); if (pr && pr.catch) pr.catch(() => {});
    if (!ensureChain(peer)) return;
    if (peer.src) { try { peer.src.disconnect(); } catch { /* gone */ } }
    try {
      peer.src = ctx.createMediaStreamSource(stream);
      peer.src.connect(peer.an);
      peer.src.connect(peer.gain);
      peer.hasAudio = true;
    } catch (err) { console.warn('[voice] remote audio', err); }
    applyPeer(peer);
    changed();
  }

  function setPanPos(peer, x, y, z, now) {
    const p = peer.pan;
    if (p.positionX) {
      if (now) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
      else { setParam(p.positionX, x, 0.06); setParam(p.positionY, y, 0.06); setParam(p.positionZ, z, 0.06); }
    } else p.setPosition(x, y, z);
    peer.px = x; peer.py = y; peer.pz = z;
  }

  // ------------------------------------------------------------------ policy: who hears whom
  function setSending(peer, track) {
    if (peer.sendTrack === track) return;
    peer.sendTrack = track;
    if (!peer.sender) return;          // adoptTransceiver applies it later
    peer.sender.replaceTrack(track).catch((err) => console.warn('[voice] replaceTrack', err));
  }

  /** Re-evaluate one peer: may it hear us (sending), may we hear it (listening), its gain. Returns true if that changed. */
  function applyPeer(peer) {
    const M = net.state.match;
    const e = roster().get(peer.id);
    const team = e ? e.team : '';
    const was = peer.allowed;
    peer.allowed = voiceAllowed(M.teams, M.phase, myTeam(), team);
    setSending(peer, transmitting() && peer.allowed && !peer.deaf ? S.track : null);
    peer.hear = peer.allowed && !peer.muted;
    const g = peer.hear ? peer.volume : 0;
    if (peer.gain && peer.appliedGain !== g) { peer.appliedGain = g; setParam(peer.gain.gain, g, 0.03); }
    return was !== peer.allowed;
  }

  function evaluate(quiet) {
    let any = false;
    for (const p of peers.values()) if (applyPeer(p)) any = true;
    ensureCapture();
    if (!quiet || any) changed();
  }

  /** Bring the peer set in line with the roster (humans other than us), then re-evaluate. */
  function sync() {
    if (!S.enabled) { if (peers.size) closeAll(); return; }
    const R = roster();
    for (const e of R.values()) {
      if (e.bot || e.id === S.selfId) continue;
      const p = peers.get(e.id);
      if (!p) createPeer(e.id);
      else { p.mic = !!e.mic; p.deaf = !!e.deaf; p.relayCap = !!e.relay; }
    }
    for (const p of Array.from(peers.values())) {
      const e = R.get(p.id);
      if (!e || e.bot) closePeer(p);
    }
    evaluate();
  }

  // ------------------------------------------------------------------ microphone
  function setMicState(s) { if (S.micState !== s) { S.micState = s; changed(); } }

  /** Use a capture stream as the microphone (the getUserMedia result, or the test tone). */
  function adoptStream(stream) {
    const track = stream.getAudioTracks()[0];
    if (!track) { stream.getTracks().forEach((t) => t.stop()); setMicState('nomic'); return false; }
    S.stream = stream; S.track = track;
    track.onended = () => {           // unplugged / revoked
      if (S.track !== track) return;
      releaseMic();
      S.micWanted = false;
      setMicState('nomic');
      onNotice('Microphone disconnected');
      evaluate(); sendState();
    };
    if (ensureCtx()) {
      if (ctx.state !== 'running') ctx.resume().catch(() => {});   // iOS interrupts the context on capture start
      try {
        S.micSrc = ctx.createMediaStreamSource(stream);
        S.micAn = ctx.createAnalyser(); S.micAn.fftSize = 512; S.micAn.smoothingTimeConstant = 0;
        S.micBuf = new Uint8Array(S.micAn.fftSize);
        S.micSrc.connect(S.micAn);          // analysis only: never to the speakers
      } catch { /* level meter only */ }
    }
    setMicState('live');
    return true;
  }

  /** Test hook (?voicetest=1): a steady 440 Hz tone instead of the microphone - no permission prompt. */
  function acquireTone() {
    if (!ensureCtx()) { setMicState('error'); return Promise.resolve(false); }
    const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 440;
    const g = ctx.createGain(); g.gain.value = 0.3;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(g); g.connect(dest); osc.start();
    S.toneOsc = osc;
    return Promise.resolve(adoptStream(dest.stream));
  }

  function acquireMic() {
    if (S.track && S.track.readyState === 'live') return Promise.resolve(true);
    if (S.micPromise) return S.micPromise;
    if (TEST_TONE) return acquireTone();
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      setMicState('nomic');
      onNotice(window.isSecureContext === false ? 'Microphone needs a secure (https) page. You can still listen.' : 'This browser has no microphone access. You can still listen.');
      return Promise.resolve(false);
    }
    setMicState('pending');
    S.micPromise = md.getUserMedia({
      audio: { echoCancellation: cfg.echoCancellation, noiseSuppression: cfg.noiseSuppression, autoGainControl: true, channelCount: 1 },
      video: false,
    }).then((stream) => adoptStream(stream)).catch((err) => {
      const n = err && err.name;
      if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') {
        setMicState('denied');
        onNotice('Microphone blocked - allow it in the browser’s site settings');
      } else if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') {
        setMicState('nomic'); onNotice('No microphone found');
      } else if (n === 'NotReadableError' || n === 'AbortError') {
        setMicState('nomic'); onNotice('The microphone is busy in another app');
      } else { setMicState('error'); onNotice('Could not start the microphone'); }
      return false;
    }).finally(() => { S.micPromise = null; });
    return S.micPromise;
  }

  function releaseMic() {
    clearTimeout(S.idleTimer); S.idleTimer = 0;
    stopCapture();
    if (S.toneOsc) { try { S.toneOsc.stop(); S.toneOsc.disconnect(); } catch { /* stopped */ } S.toneOsc = null; }
    if (S.micSrc) { try { S.micSrc.disconnect(); } catch { /* gone */ } S.micSrc = null; }
    S.micAn = null;
    if (S.stream) S.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    S.stream = null; S.track = null;
    if (S.micState === 'live' || S.micState === 'pending') S.micState = 'off';
    for (const p of peers.values()) setSending(p, null);
    S.selfSpeaking = false; S.selfLevel = 0;
  }

  function maybeRelease() {
    clearTimeout(S.idleTimer); S.idleTimer = 0;
    if (S.micWanted || S.ptt || !S.track) return;
    if (S.pttUsed && !TOUCH) S.idleTimer = setTimeout(() => { if (!S.micWanted && !S.ptt) { releaseMic(); changed(); } }, MIC_IDLE_MS);
    else releaseMic();
  }

  function toggleMic() {
    if (!S.enabled) return;
    resume();
    if (S.micWanted) {
      S.micWanted = false;
      maybeRelease();
      evaluate(); sendState();
      return;
    }
    S.micWanted = true;
    changed();
    acquireMic().then((ok) => {
      if (!ok) S.micWanted = false;
      evaluate(); sendState();
    });
  }

  function setPtt(down) {
    down = !!down;
    if (!S.enabled || down === S.ptt) return;
    S.ptt = down;
    if (down) {
      S.pttUsed = true;
      clearTimeout(S.idleTimer); S.idleTimer = 0;
      resume();
      acquireMic().then(() => { evaluate(); sendState(); });
      changed();
    } else {
      maybeRelease();
      evaluate(); sendState();
    }
  }

  function toggleSpeaker() {
    if (!S.enabled) return;
    resume();
    S.spk = !S.spk;
    if (ensureCtx() && bus) setParam(bus.gain, busGain(), 0.03);
    changed(); sendState();
  }

  // voice state broadcast (coalesced)
  function sendState() {
    if (!S.enabled || !net.state.connected) return;
    const mic = transmitting(), deaf = !S.spk, rl = relayOn();
    if (mic === S.sentMic && deaf === S.sentDeaf && rl === S.sentRelay) return;
    if (S.stateTimer) return;
    const wait = Math.max(0, STATE_GAP_MS - (performance.now() - S.stateSentAt));
    S.stateTimer = setTimeout(() => {
      S.stateTimer = 0;
      const m = transmitting(), d = !S.spk, r = relayOn();
      if (m === S.sentMic && d === S.sentDeaf && r === S.sentRelay) return;
      S.sentMic = m; S.sentDeaf = d; S.sentRelay = r; S.stateSentAt = performance.now();
      net.sendVoiceState(m, d, r);
    }, wait);
  }

  // ------------------------------------------------------------------ net lifecycle
  function onWelcome() {
    closeAll();
    const v = net.state.voice || {};
    S.selfId = net.state.id;
    S.enabled = !!v.enabled && supported();
    S.ice = Array.isArray(v.ice) ? v.ice : [];
    S.sentMic = false; S.sentDeaf = false; S.sentRelay = false;   // the server starts every new player at mic off, speaker on, no relay
    if (!S.enabled) { if (S.track) { S.micWanted = false; releaseMic(); } changed(); return; }
    if (!relayTimer) relayTimer = setInterval(relayTick, RELAY_CHECK_MS);
    if (S.micWanted && !S.track) acquireMic().then((ok) => { if (!ok) S.micWanted = false; evaluate(); sendState(); });
    else if (!S.micWanted && cfg.micDefault && !S.autoTried) {
      S.autoTried = true;
      autoMic();
    }
    sync();
    sendState();
  }

  /** "Mic on by default": only when the browser already allows it (or on desktop, where a prompt is fine). */
  async function autoMic() {
    let state = 'prompt';
    try { if (navigator.permissions && navigator.permissions.query) state = (await navigator.permissions.query({ name: 'microphone' })).state; } catch { /* unknown */ }
    if (state === 'granted' || (state === 'prompt' && !TOUCH)) { if (!S.micWanted) toggleMic(); }
  }

  function onVoiceState(m) {
    const p = peers.get(m.id);
    if (!p) return;
    p.mic = !!m.mic; p.deaf = !!m.deaf; p.relayCap = !!m.relay;
    applyPeer(p);
    ensureCapture();
    changed();
  }

  function onLeave(id) { const p = peers.get(id); if (p) { closePeer(p); changed(); } }
  function onClose() { if (peers.size) { closeAll(); changed(); } }

  function shutdown() {
    clearInterval(relayTimer); relayTimer = 0;
    closeAll();
    S.micWanted = false; S.ptt = false;
    releaseMic();
    clearTimeout(S.stateTimer); S.stateTimer = 0;
    changed();
  }

  // ------------------------------------------------------------------ per frame
  let lastProx = -1e9, lastLevel = -1e9, lastWatch = -1e9;
  function frame(t, players, L) {
    if (!S.enabled) return;
    // (a clock that went backwards, e.g. a caller with its own time base, must not stall the throttles)
    if (t - lastProx >= PROX_EVERY_MS || t < lastProx) { lastProx = t; proximity(players, L); }
    if (t - lastLevel >= LEVEL_EVERY_MS || t < lastLevel) { lastLevel = t; levels(t); }
    if (t - lastWatch >= 1000 || t < lastWatch) { lastWatch = t; watchdog(t); }
  }

  function proximity(players, L) {
    if (!ctx) return;
    const M = net.state.match;
    const on = cfg.proximity && M.phase === 'playing' && L;
    const mine = myTeam();
    const cy = on ? Math.cos(L.yaw) : 1, sy = on ? Math.sin(L.yaw) : 0;
    const ey = on ? L.y + (L.eyeHeight || 1.6) : 0;
    for (const peer of peers.values()) {
      if (!peer.gain) continue;
      let g = 1, x = 0, y = 0, z = -1, spatial = false;
      if (on) {
        let p = null;
        for (let i = 0; i < players.length; i++) if (players[i].id === peer.id) { p = players[i]; break; }
        if (p) {
          const dx = p.x - L.x, dy = p.y + 1.5 - ey, dz = p.z - L.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          g = d <= NEAR ? 1 : d >= FFA_RANGE ? 0 : 1 - (d - NEAR) / (FFA_RANGE - NEAR);
          g = g * g * (3 - 2 * g);                                // smooth fade, 0 at FFA_RANGE
          const e = roster().get(peer.id);
          if (M.teams && e && e.team && e.team === mine && g < TEAM_FLOOR) g = TEAM_FLOOR;
          if (d > 0.3) {
            // listener frame: right = (cos yaw, 0, -sin yaw), forward = (-sin yaw, 0, -cos yaw) = local -Z
            x = (dx * cy - dz * sy) / d;
            z = (dx * sy + dz * cy) / d;
            y = dy / d;
            spatial = true;
          }
        }
      }
      if (Math.abs(g - peer.proxG) > 0.005) { peer.proxG = g; setParam(peer.prox.gain, g, 0.08); }
      if (spatial !== peer.spatial) {
        peer.spatial = spatial;
        setParam(peer.dry.gain, spatial ? 0 : 1, 0.06);
        setParam(peer.wet.gain, spatial ? (TOUCH ? 1.25 : 1) : 0, 0.06);
      }
      if (Math.abs(x - peer.px) + Math.abs(y - peer.py) + Math.abs(z - peer.pz) > 0.02) setPanPos(peer, x, y, z, false);
    }
  }

  function rms(an, buf) {
    an.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / buf.length);
  }

  function levels(t) {
    let flip = false;
    for (const peer of peers.values()) {
      let r = 0;
      if (peer.an && peer.hasAudio) r = rms(peer.an, peer.buf);
      peer.level = Math.max(r, peer.level * 0.6);
      const loud = peer.allowed && (peer.speaking ? r > SPEAK_OFF : r > SPEAK_ON);
      if (loud) peer.speakUntil = t + SPEAK_HOLD_MS;
      const sp = t < peer.speakUntil;
      if (sp !== peer.speaking) { peer.speaking = sp; flip = true; }
    }
    let r = 0;
    if (S.micAn && transmitting()) r = rms(S.micAn, S.micBuf);
    S.selfLevel = Math.max(r, S.selfLevel * 0.6);
    if (S.selfSpeaking ? r > SPEAK_OFF : r > SPEAK_ON) S.selfSpeakUntil = t + SPEAK_HOLD_MS;
    const ss = transmitting() && t < S.selfSpeakUntil;
    if (ss !== S.selfSpeaking) { S.selfSpeaking = ss; flip = true; }
    if (flip) speakVersion++;
  }

  function watchdog(t) {
    evaluate(true);            // safety net: the policy also follows team / phase without an event
    for (const peer of peers.values()) {
      if (peer.state === 'connected' || peer.closed) continue;
      if (t - peer.since > CONNECT_TIMEOUT_MS && !peer.timedOut) {
        peer.timedOut = true;
        if (!relayLink(peer)) cantReach(peer);      // the relay covers for P2P: no alarm
        if (peer.state !== 'failed') scheduleRestart(peer, false);
      }
    }
  }

  // ------------------------------------------------------------------ relay: decisions
  /** This client can use the relay (browser support, server offers it, not turned off). */
  const relayOn = () => S.relayCap && !NO_RELAY && !CAP.failed && !!(net.state.voice && net.state.voice.relay);
  /** Both ends of this pair can use the relay. */
  const relayLink = (peer) => relayOn() && peer.relayCap;
  /** What carries this peer right now: 'p2p' | 'relay' | ''. */
  const linkOf = (peer) => (peer.state === 'connected' ? 'p2p' : peer.relay && relayLink(peer) ? 'relay' : '');

  /** P2P is not working for this pair (yet): no RTCPeerConnection, failed, or not connected for long enough. */
  function stuck(peer, now) {
    if (FORCE_RELAY || !peer.pc) return true;
    if (peer.state === 'connected') return false;
    if (peer.state === 'failed') return true;
    return now - peer.since >= (peer.wasUp ? RELAY_DISC_MS : RELAY_AFTER_MS);
  }

  function updateRelay(peer, now) {
    if (peer.closed) return;
    const st = stuck(peer, now);
    if (st && !peer.stuckAt) peer.stuckAt = now; else if (!st) peer.stuckAt = 0;
    const want = st && relayOn();
    if (want !== peer.relay) {
      peer.relay = want;
      if (want) peer.relayAt = now;
      changed();
    }
    reportStat(peer, now, st);
  }

  let relayTimer = 0;
  function relayTick() {
    if (!S.enabled) return;
    const now = performance.now();
    for (const peer of peers.values()) updateRelay(peer, now);
    ensureCapture();
    if (S.statTokens < 10) { S.statTokens = Math.min(10, S.statTokens + (now - S.statAt) / 2000); }
    S.statAt = now;
  }

  // Browser support, decided once (async). Until then the relay is off.
  async function detectRelay() {
    if (NO_RELAY) return false;
    const g = globalThis;
    if (typeof g.AudioEncoder !== 'function' || typeof g.AudioDecoder !== 'function' || typeof g.AudioData !== 'function' ||
      typeof g.EncodedAudioChunk !== 'function' || typeof g.AudioWorkletNode !== 'function') return false;
    try {
      const base = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: RELAY_BITRATE };
      for (const c of [{ ...base, opus: { frameDuration: FRAME_US } }, base]) {
        const r = await g.AudioEncoder.isConfigSupported(c);
        if (r && r.supported) { CAP.encCfg = c; break; }
      }
      const d = await g.AudioDecoder.isConfigSupported(DEC_CFG);
      return !!(CAP.encCfg && d && d.supported);
    } catch { return false; }
  }
  detectRelay().then((ok) => {
    S.relayCap = ok; S.relayKnown = true;
    if (S.enabled) { evaluate(true); sendState(); }
  });

  // ------------------------------------------------------------------ relay: diagnostics ('vstat')
  /** ICE candidate TYPES seen on this connection (never addresses) + the selected pair's types. */
  async function candTypes(pc) {
    const r = { local: '', remote: '', pair: '' };
    if (!pc || typeof pc.getStats !== 'function') return r;
    const stats = await pc.getStats();
    const types = new Map(), loc = new Set(), rem = new Set();
    let sel = '', pair = null;
    stats.forEach((s) => {
      if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
        if (!CAND_TYPES.includes(s.candidateType)) return;
        types.set(s.id, s.candidateType);
        (s.type === 'local-candidate' ? loc : rem).add(s.candidateType);
      } else if (s.type === 'transport' && s.selectedCandidatePairId) sel = s.selectedCandidatePairId;
    });
    stats.forEach((s) => {
      if (pair || s.type !== 'candidate-pair') return;
      if (sel ? s.id === sel : (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s;
    });
    if (pair) { const a = types.get(pair.localCandidateId), b = types.get(pair.remoteCandidateId); if (a && b) r.pair = a + '-' + b; }
    const list = (set) => CAND_TYPES.filter((t) => set.has(t)).join(',');
    r.local = list(loc); r.remote = list(rem);
    return r;
  }

  /** Report this pair's outcome to the server log when it changes (rate limited). */
  function reportStat(peer, now, st) {
    if (!net.state.connected || !net.state.voice || !net.state.voice.relay || peer.statBusy) return;
    const out = peer.state === 'connected' ? 'p2p' : !st ? '' : relayLink(peer) ? 'relay' : 'failed';
    if (!out || out === peer.statSent) return;
    if (now - peer.statAt < VSTAT_GAP_MS || S.statTokens < 1) return;
    S.statTokens--;
    peer.statSent = out; peer.statAt = now; peer.statBusy = true;
    const msg = { to: peer.id, state: out, ms: (out === 'p2p' ? peer.upAt : peer.stuckAt || now) - peer.since };
    if (out !== 'p2p') msg.why = FORCE_RELAY ? 'forced' : (!peer.pc || peer.state === 'failed') ? 'failed' : peer.wasUp ? 'disconnected' : 'timeout';
    if (out === 'failed') msg.nr = !relayOn() ? (NO_RELAY ? 'off' : 'self') : 'peer';
    candTypes(peer.pc).then((c) => { msg.local = c.local; msg.remote = c.remote; msg.pair = c.pair; }, () => {}).then(() => {
      peer.statBusy = false;
      if (!peer.closed) net.sendVoiceStat(msg);
    });
  }

  // ------------------------------------------------------------------ relay: sending
  function relayTargets(out) {
    out.length = 0;
    for (const p of peers.values()) if (p.relay && p.relayCap && p.sendTrack && !p.closed) out.push(p.id);
    return out;
  }
  function ensureCapture() {
    const want = relayOn() && transmitting() && !!S.micSrc && relayTargets(CAP.ids).length > 0;
    if (want && !CAP.on) startCapture();
    else if (!want && CAP.on) stopCapture();
  }

  function loadWorklet() {
    if (!CAP.loading) {
      CAP.loading = (async () => {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
        try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        return true;
      })().catch((err) => { console.warn('[voice] relay capture unavailable', err); return false; });
    }
    return CAP.loading;
  }

  function relayBroken(what, err) {
    console.warn('[voice] relay ' + what + ' failed', err);
    CAP.failed = true; CAP.on = false;
    evaluate(true); sendState();               // tell the others we cannot use the relay
  }

  async function startCapture() {
    CAP.on = true;                             // the decision; the graph follows once the worklet is in
    if (!ensureCtx() || !ctx.audioWorklet) { relayBroken('capture', 'no AudioWorklet'); return; }
    if (!(await loadWorklet())) { relayBroken('capture', 'worklet'); return; }
    if (!CAP.on || !S.micSrc) return;          // stopped / mic released meanwhile
    try {
      if (!CAP.node) {
        CAP.node = new AudioWorkletNode(ctx, 'hopshot-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        CAP.node.port.onmessage = (ev) => onCaptured(ev.data);
        CAP.sink = ctx.createGain(); CAP.sink.gain.value = 0;      // keeps the node pulled; silent
        CAP.node.connect(CAP.sink); CAP.sink.connect(ctx.destination);
      }
      if (!CAP.enc || CAP.enc.state === 'closed') {
        CAP.enc = new AudioEncoder({ output: onEncoded, error: (err) => { CAP.encErrors++; console.warn('[voice] relay encoder', err); CAP.enc = null; } });
        CAP.enc.configure(CAP.encCfg);
      }
      if (CAP.src !== S.micSrc) {
        if (CAP.src) { try { CAP.src.disconnect(CAP.node); } catch { /* gone */ } }
        S.micSrc.connect(CAP.node);
        CAP.src = S.micSrc;
      }
    } catch (err) { relayBroken('encoder', err); }
  }

  function stopCapture() {
    CAP.on = false;
    if (CAP.src && CAP.node) { try { CAP.src.disconnect(CAP.node); } catch { /* gone */ } }
    CAP.src = null;
  }

  /** 20 ms of 48 kHz mono from the worklet -> encoder. */
  function onCaptured(f32) {
    if (!CAP.on) return;
    if (!CAP.enc) {                            // the encoder errored: a new one
      try {
        CAP.enc = new AudioEncoder({ output: onEncoded, error: (err) => { CAP.encErrors++; console.warn('[voice] relay encoder', err); CAP.enc = null; } });
        CAP.enc.configure(CAP.encCfg);
      } catch (err) { relayBroken('encoder', err); return; }
      if (CAP.encErrors > 5) { relayBroken('encoder', 'too many errors'); return; }
    }
    if (CAP.enc.state !== 'configured' || CAP.enc.encodeQueueSize > 4) { CAP.dropped++; return; }
    const ts = CAP.ts;
    CAP.ts += FRAME_US;
    CAP.capAt[(ts / FRAME_US) & 63] = performance.now();
    let ad = null;
    try {
      ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: f32.length, numberOfChannels: 1, timestamp: ts, data: f32 });
      CAP.enc.encode(ad);
    } catch (err) { CAP.dropped++; } finally { if (ad) ad.close(); }
  }

  function onEncoded(chunk) {
    const t0 = CAP.capAt[(chunk.timestamp / FRAME_US) & 63];
    if (t0) CAP.encMs += ((performance.now() - t0) - CAP.encMs) * 0.05;
    const n = chunk.byteLength;
    if (n < 1 || n > VOICE_MAX_PAYLOAD) { CAP.dropped++; return; }
    const ids = relayTargets(CAP.ids);         // the policy is re-checked for every frame
    if (!ids.length) return;
    const bytes = new Uint8Array(n);
    chunk.copyTo(bytes);
    if (net.sendVoiceFrame(ids, CAP.seq, bytes)) {
      if (CAP.testSent && t0) CAP.testSent[CAP.seq & 1023] = performance.timeOrigin + t0;
      CAP.seq = (CAP.seq + 1) & 0xffff; CAP.sent++;
    } else CAP.skipped++;
  }

  // ------------------------------------------------------------------ relay: receiving
  function newRelayInput(peer) {
    peer.relayIn = ctx.createGain();
    peer.relayIn.connect(peer.an);
    peer.relayIn.connect(peer.gain);
  }
  /** P2P is back for this peer: drop what the relay already scheduled (never both at once). */
  function stopRelayPlayback(peer) {
    const rx = peer.rx;
    if (!rx || !peer.relayIn || !ctx) return;
    if (rx.next > ctx.currentTime) { try { peer.relayIn.disconnect(); } catch { /* gone */ } newRelayInput(peer); }
    rx.next = 0;
  }

  function newRx() {
    return { dec: null, decFails: 0, ext: -1, next: 0, delay: JB_START, calmAt: performance.now(), lastOut: 0,
      frames: 0, played: 0, ignored: 0, late: 0, underruns: 0, dup: 0, leadAvg: 0, leads: new Float32Array(128), leadN: 0,
      testPlay: TEST_TONE ? new Float64Array(1024).fill(-1) : null };
  }

  function ensureDecoder(peer) {
    const rx = peer.rx;
    if (rx.dec && rx.dec.state === 'configured') return rx.dec;
    if (rx.dec) { try { rx.dec.close(); } catch { /* closed */ } rx.dec = null; }
    if (rx.decFails > 5) return null;
    try {
      const dec = new AudioDecoder({
        output: (ad) => playRelay(peer, ad),
        error: (err) => { rx.decFails++; console.warn('[voice] relay decoder', err); },
      });
      dec.configure(DEC_CFG);
      rx.dec = dec;
      return dec;
    } catch (err) { rx.decFails++; console.warn('[voice] relay decoder', err); return null; }
  }

  /** A relayed frame (net 'voiceframe'): decode it unless this peer's P2P link is connected. */
  function onRelayFrame(f) {
    if (!S.enabled || !S.relayCap || NO_RELAY) return;
    const peer = peers.get(f.from);
    if (!peer || peer.closed) return;
    const rx = peer.rx || (peer.rx = newRx());
    rx.frames++;
    if (peer.state === 'connected') { rx.ignored++; return; }       // P2P carries this peer: never double audio
    if (!ensureCtx() || ctx.state !== 'running' || !ensureChain(peer)) { rx.ignored++; return; }
    let ext;
    if (rx.ext < 0) ext = f.seq;
    else {
      let d = (f.seq - (rx.ext & 0xffff)) & 0xffff;
      if (d >= 0x8000) d -= 0x10000;
      if (d <= 0) { if (d > -200) { rx.dup++; return; } d = 1; }  // far back: the sender restarted its counter
      ext = rx.ext + d;
    }
    rx.ext = ext;
    const dec = ensureDecoder(peer);
    if (!dec) { rx.ignored++; return; }
    if (dec.decodeQueueSize > 8) { rx.late++; return; }
    try { dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ext * FRAME_US, data: f.payload })); } catch (err) { rx.decFails++; }
  }

  /** Mono float samples of a decoded AudioData into dst (Float32Array of numberOfFrames). */
  function readMono(ad, dst) {
    try { ad.copyTo(dst, { planeIndex: 0, format: 'f32-planar' }); return; } catch { /* no conversion: by hand */ }
    const n = ad.numberOfFrames, ch = ad.numberOfChannels, fmt = ad.format;
    if (fmt === 'f32-planar') { ad.copyTo(dst, { planeIndex: 0 }); return; }
    if (fmt === 'f32') { const t = new Float32Array(n * ch); ad.copyTo(t, { planeIndex: 0 }); for (let i = 0; i < n; i++) dst[i] = t[i * ch]; return; }
    if (fmt === 's16' || fmt === 's16-planar') {
      const planar = fmt === 's16-planar', t = new Int16Array(planar ? n : n * ch);
      ad.copyTo(t, { planeIndex: 0 });
      for (let i = 0; i < n; i++) dst[i] = t[planar ? i : i * ch] / 32768;
      return;
    }
    dst.fill(0);
  }

  /** Decoder output -> one AudioBuffer scheduled on this peer's relay input (jitter buffer). */
  function playRelay(peer, ad) {
    try {
      const rx = peer.rx;
      if (peer.closed || !rx || !peer.relayIn || peer.state === 'connected' || !ctx || ctx.state !== 'running') return;
      const n = ad.numberOfFrames, rate = ad.sampleRate;
      if (!n || !rate) return;
      const buf = ctx.createBuffer(1, n, rate);
      readMono(ad, buf.getChannelData(0));
      const now = ctx.currentTime, pnow = performance.now();
      let t = rx.next;
      if (t < now + 0.003) {
        // the queue ran dry: a new talk spurt, or the network was late mid-spurt (then buffer more)
        if (rx.lastOut && pnow - rx.lastOut < 150) { rx.underruns++; rx.delay = Math.min(JB_MAX, rx.delay + JB_STEP); rx.calmAt = pnow; }
        t = now + rx.delay;
      } else if (t - now > rx.delay + JB_SLACK) {
        rx.late++;                              // far behind (a burst after a stall): skip, latency must not grow
        rx.lastOut = pnow;
        return;
      }
      if (pnow - rx.calmAt > JB_CALM_MS) { rx.delay = Math.max(JB_MIN, rx.delay - 0.01); rx.calmAt = pnow; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(peer.relayIn);
      src.start(t);
      rx.next = t + n / rate;
      rx.lastOut = pnow;
      rx.played++;
      const lead = t - now;
      rx.leadAvg += (lead - rx.leadAvg) * 0.05;
      rx.leads[rx.leadN++ & 127] = lead;
      if (rx.testPlay) {
        const outLat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
        rx.testPlay[Math.round(ad.timestamp / FRAME_US) & 0xffff & 1023] = performance.timeOrigin + pnow + (lead + outLat) * 1000;
      }
      if (!peer.hasAudio) { peer.hasAudio = true; changed(); }
    } finally { ad.close(); }
  }

  // ------------------------------------------------------------------ UI surface
  function setPeerMuted(id, m) {
    const p = peers.get(id);
    const name = nameOf(id).toLowerCase();
    const pf = prefs[name] || (prefs[name] = { m: false, v: 1 });
    pf.m = !!m; savePrefs();
    if (p) { p.muted = !!m; applyPeer(p); }
    changed();
  }
  function setPeerVolume(id, v) {
    v = Math.max(0, Math.min(2, +v || 0));
    const p = peers.get(id);
    const name = nameOf(id).toLowerCase();
    const pf = prefs[name] || (prefs[name] = { m: false, v: 1 });
    pf.v = v; savePrefs();
    if (p) { p.volume = v; applyPeer(p); }
    changed();
  }

  function configure(s) {
    if (!s) return;
    const prevNs = cfg.noiseSuppression, prevEc = cfg.echoCancellation;
    if (Number.isFinite(s.voiceVolume)) cfg.voiceVolume = Math.max(0, Math.min(1, s.voiceVolume));
    if (typeof s.micDefault === 'boolean') cfg.micDefault = s.micDefault;
    if (typeof s.pttKey === 'string') cfg.pttKey = s.pttKey;
    if (typeof s.proximity === 'boolean') cfg.proximity = s.proximity;
    if (typeof s.noiseSuppression === 'boolean') cfg.noiseSuppression = s.noiseSuppression;
    if (typeof s.echoCancellation === 'boolean') cfg.echoCancellation = s.echoCancellation;
    if (bus) setParam(bus.gain, busGain(), 0.03);
    if (S.track && (prevNs !== cfg.noiseSuppression || prevEc !== cfg.echoCancellation) && S.track.applyConstraints) {
      S.track.applyConstraints({ echoCancellation: cfg.echoCancellation, noiseSuppression: cfg.noiseSuppression, autoGainControl: true }).catch(() => {});
    }
    changed();
  }

  /** What the mic button shows: off | pending | on | ptt | denied | nomic | error. */
  function micView() {
    if (S.micState === 'denied' || S.micState === 'nomic' || S.micState === 'error') return S.micState;
    if (S.micState === 'pending' && (S.micWanted || S.ptt)) return 'pending';
    if (S.micWanted && S.micState === 'live') return 'on';
    if (S.ptt && S.micState === 'live') return 'ptt';
    return 'off';
  }

  const view = {
    get available() { return S.enabled; },
    get mic() { return micView(); },
    get transmitting() { return transmitting(); },
    get spk() { return S.spk; },
    get pttKey() { return TOUCH ? '' : cfg.pttKey; },
    get selfSpeaking() { return S.selfSpeaking; },
    get selfLevel() { return S.selfLevel; },
  };

  /** UI info for player id (null for non-peers). */
  function info(id) {
    if (id === S.selfId && S.enabled) return { self: true, speaking: S.selfSpeaking, mic: transmitting(), deaf: !S.spk, muted: false, volume: 1, state: 'self', allowed: true };
    const p = peers.get(id);
    if (!p) return null;
    // a peer carried by the relay looks connected (link says how)
    const link = linkOf(p);
    return { self: false, speaking: p.speaking, mic: p.mic, deaf: p.deaf, muted: p.muted, volume: p.volume, state: link ? 'connected' : p.state, link, allowed: p.allowed };
  }
  function isSpeaking(id) {
    if (id === S.selfId) return S.selfSpeaking;
    const p = peers.get(id);
    return !!(p && p.speaking);
  }

  function debug() {
    const out = { enabled: S.enabled, selfId: S.selfId, mic: micView(), micState: S.micState, transmitting: transmitting(), spk: S.spk,
      selfSpeaking: S.selfSpeaking, selfLevel: +S.selfLevel.toFixed(4), ctx: ctx ? ctx.state : null,
      relay: { on: relayOn(), cap: S.relayCap, known: S.relayKnown, server: !!(net.state.voice && net.state.voice.relay), mode: FORCE_RELAY ? 'relay' : NO_RELAY ? 'p2p' : 'auto',
        capturing: CAP.on, sent: CAP.sent, skipped: CAP.skipped, dropped: CAP.dropped, encErrors: CAP.encErrors, encMs: +CAP.encMs.toFixed(2), seq: CAP.seq, failed: CAP.failed },
      peers: [] };
    for (const p of peers.values()) {
      const rx = p.rx;
      let leadP95 = null;
      if (rx && rx.leadN) { const a = Array.from(rx.leads.subarray(0, Math.min(rx.leadN, 128))).sort((x, y) => x - y); leadP95 = +(a[Math.floor(a.length * 0.95)] * 1000).toFixed(1); }
      out.peers.push({ id: p.id, name: nameOf(p.id), state: p.state, link: linkOf(p), relay: p.relay, relayCap: p.relayCap,
        rx: rx ? { frames: rx.frames, played: rx.played, ignored: rx.ignored, late: rx.late, underruns: rx.underruns, dup: rx.dup, decFails: rx.decFails,
          delayMs: +(rx.delay * 1000).toFixed(1), leadAvgMs: +(rx.leadAvg * 1000).toFixed(1), leadP95Ms: leadP95 } : null,
        liveLevel: p.an ? +rms(p.an, p.buf).toFixed(4) : null, postLevel: p.postAn ? +rms(p.postAn, p.buf).toFixed(4) : null,
        initiator: p.initiator, allowed: p.allowed, hear: p.hear, muted: p.muted, volume: p.volume,
        sending: !!(p.sender && p.sender.track), gated: !!p.sendTrack, hasAudio: p.hasAudio, speaking: p.speaking, level: +p.level.toFixed(4),
        mic: p.mic, deaf: p.deaf, proxGain: +p.proxG.toFixed(3), spatial: p.spatial, pan: [+p.px.toFixed(2), +p.py.toFixed(2), +p.pz.toFixed(2)],
        gain: p.gain ? +p.gain.gain.value.toFixed(3) : null, restarts: p.restarts,
        el: p.el ? (p.el.paused ? 'paused' : 'playing') + '/' + p.el.readyState : null,
        tracks: p.stream ? p.stream.getAudioTracks().map((t) => t.readyState + (t.muted ? '/muted' : '') + (t.enabled ? '' : '/disabled')).join(',') : null });
    }
    return out;
  }

  /** Test hook (?voicetest=1): wall-clock ms per relay seq (& 1023) - when each frame was captured here, when each peer's was scheduled to play. */
  function testLog() {
    const play = {};
    for (const p of peers.values()) if (p.rx && p.rx.testPlay) play[p.id] = Array.from(p.rx.testPlay);
    return { sent: CAP.testSent ? Array.from(CAP.testSent) : null, play };
  }

  return {
    onWelcome, sync, onSignal, onVoiceState, onLeave, onClose, shutdown, frame, onRelayFrame,
    toggleMic, setPtt, toggleSpeaker, setPeerMuted, setPeerVolume, configure,
    view, info, isSpeaking, debug, testLog,
    peerConnection: (id) => { const p = peers.get(id); return p ? p.pc : null; },
    get version() { return version; },
    get speakVersion() { return speakVersion; },
    get enabled() { return S.enabled; },
  };
}
