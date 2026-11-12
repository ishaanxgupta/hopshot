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

import { voiceAllowed } from '../shared/protocol.js';

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

  const S = {
    enabled: false, selfId: 0, ice: [],
    micWanted: false, ptt: false, pttUsed: false, autoTried: false,
    micState: 'off',          // off | pending | live | denied | nomic | error
    stream: null, track: null, micSrc: null, micAn: null, micBuf: null, micPromise: null, idleTimer: 0,
    spk: true,
    selfLevel: 0, selfSpeaking: false, selfSpeakUntil: 0,
    sentMic: false, sentDeaf: false, stateTimer: 0, stateSentAt: -1e9,
  };
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
    };
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
    for (const k of ['src', 'an', 'gain', 'prox', 'dry', 'wet', 'pan']) { if (peer[k]) { try { peer[k].disconnect(); } catch { /* gone */ } peer[k] = null; } }
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
      peer.restarts = 0; peer.noticed = false;
      if (prev === 'failed') onNotice('Voice reconnected to ' + nameOf(peer.id));
      tuneSender(peer);
    } else if (s === 'failed') {
      scheduleRestart(peer, true);
    } else if (s === 'disconnected') {
      // often recovers by itself (wifi blip); restart if it does not
      peer.discTimer = setTimeout(() => { if (!peer.closed && peer.state === 'disconnected') scheduleRestart(peer, false); }, 4000);
    }
    changed();
  }

  function scheduleRestart(peer, failed) {
    if (peer.closed) return;
    if (failed && !peer.noticed) { peer.noticed = true; onNotice("Voice can't reach " + nameOf(peer.id) + ' (network)'); }
    if (!peer.initiator || peer.restartTimer) return;       // the offerer drives restarts
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
    if (!ensureCtx()) return;
    if (!peer.gain) {
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
    }
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
      else { p.mic = !!e.mic; p.deaf = !!e.deaf; }
    }
    for (const p of Array.from(peers.values())) {
      const e = R.get(p.id);
      if (!e || e.bot) closePeer(p);
    }
    evaluate();
  }

  // ------------------------------------------------------------------ microphone
  function setMicState(s) { if (S.micState !== s) { S.micState = s; changed(); } }

  function acquireMic() {
    if (S.track && S.track.readyState === 'live') return Promise.resolve(true);
    if (S.micPromise) return S.micPromise;
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
    }).then((stream) => {
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
    }).catch((err) => {
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
    const mic = transmitting(), deaf = !S.spk;
    if (mic === S.sentMic && deaf === S.sentDeaf) return;
    if (S.stateTimer) return;
    const wait = Math.max(0, STATE_GAP_MS - (performance.now() - S.stateSentAt));
    S.stateTimer = setTimeout(() => {
      S.stateTimer = 0;
      const m = transmitting(), d = !S.spk;
      if (m === S.sentMic && d === S.sentDeaf) return;
      S.sentMic = m; S.sentDeaf = d; S.stateSentAt = performance.now();
      net.sendVoiceState(m, d);
    }, wait);
  }

  // ------------------------------------------------------------------ net lifecycle
  function onWelcome() {
    closeAll();
    const v = net.state.voice || {};
    S.selfId = net.state.id;
    S.enabled = !!v.enabled && supported();
    S.ice = Array.isArray(v.ice) ? v.ice : [];
    S.sentMic = false; S.sentDeaf = false;      // the server starts every new player at mic off, speaker on
    if (!S.enabled) { if (S.track) { S.micWanted = false; releaseMic(); } changed(); return; }
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
    p.mic = !!m.mic; p.deaf = !!m.deaf;
    applyPeer(p);
    changed();
  }

  function onLeave(id) { const p = peers.get(id); if (p) { closePeer(p); changed(); } }
  function onClose() { if (peers.size) { closeAll(); changed(); } }

  function shutdown() {
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
      if (t - peer.since > CONNECT_TIMEOUT_MS && !peer.noticed) {
        peer.noticed = true;
        onNotice("Voice can't reach " + nameOf(peer.id) + ' (network)');
        if (peer.state !== 'failed') scheduleRestart(peer, false);
      }
    }
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
    return { self: false, speaking: p.speaking, mic: p.mic, deaf: p.deaf, muted: p.muted, volume: p.volume, state: p.state, allowed: p.allowed };
  }
  function isSpeaking(id) {
    if (id === S.selfId) return S.selfSpeaking;
    const p = peers.get(id);
    return !!(p && p.speaking);
  }

  function debug() {
    const out = { enabled: S.enabled, selfId: S.selfId, mic: micView(), micState: S.micState, transmitting: transmitting(), spk: S.spk,
      selfSpeaking: S.selfSpeaking, selfLevel: +S.selfLevel.toFixed(4), ctx: ctx ? ctx.state : null, peers: [] };
    for (const p of peers.values()) {
      out.peers.push({ id: p.id, name: nameOf(p.id), state: p.state, initiator: p.initiator, allowed: p.allowed, hear: p.hear, muted: p.muted, volume: p.volume,
        sending: !!(p.sender && p.sender.track), gated: !!p.sendTrack, hasAudio: p.hasAudio, speaking: p.speaking, level: +p.level.toFixed(4),
        mic: p.mic, deaf: p.deaf, proxGain: +p.proxG.toFixed(3), spatial: p.spatial, pan: [+p.px.toFixed(2), +p.py.toFixed(2), +p.pz.toFixed(2)],
        gain: p.gain ? +p.gain.gain.value.toFixed(3) : null, restarts: p.restarts,
        el: p.el ? (p.el.paused ? 'paused' : 'playing') + '/' + p.el.readyState : null,
        tracks: p.stream ? p.stream.getAudioTracks().map((t) => t.readyState + (t.muted ? '/muted' : '') + (t.enabled ? '' : '/disabled')).join(',') : null });
    }
    return out;
  }

  return {
    onWelcome, sync, onSignal, onVoiceState, onLeave, onClose, shutdown, frame,
    toggleMic, setPtt, toggleSpeaker, setPeerMuted, setPeerVolume, configure,
    view, info, isSpeaking, debug,
    peerConnection: (id) => { const p = peers.get(id); return p ? p.pc : null; },
    get version() { return version; },
    get speakVersion() { return speakVersion; },
    get enabled() { return S.enabled; },
  };
}
