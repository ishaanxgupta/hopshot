// Hopshot loadout editor (the menu's Loadout tab). Visual first: a big turntable render of the real gun
// model (client/gunpreview.js, one shared WebGL renderer) with the part an attachment adds lit up, two
// image cards for the slot's guns, six attachment tiles with generated SVG icons and a one-line effect,
// slot pips (attachments header only), and compact stat bars. Long text lives behind the small "i" buttons (a tip over the
// preview). Pure DOM otherwise, styled by client/style.css (.hs-lo*).
//
// The editor owns the working loadout: for each of the 3 class slots a gun (A or B) and an attachment
// mask (max 3 of 6). It also remembers a build per gun (so flipping A <-> B restores each gun's own
// attachments). Everything shown comes from shared/weapons.js (names, texts, the stat ratings and their
// deltas against the bare gun), so the numbers can never disagree with the rules.
//
//   const ed = createLoadoutEditor(hostEl, { onChange({ code, builds }), onPlay() });
//   ed.setState({ code, builds })     load a saved loadout (any garbage is sanitised)
//   ed.setStatus({ pendingCode, activeCode, joined })   honest timing line
//   ed.setPlayLabel('PLAY' | 'RESUME')
//   ed.setTip(text)                   (v6, memory on) one short line tied to the player's history; '' hides it
//   ed.refresh()                      call when the tab becomes visible
//
// Persisted form (main.js keeps it in localStorage 'hopshot.loadout'): { code: int, builds: [6 masks] }.

import { createGunPreview } from './gunpreview.js';
import {
  GUNS, ATTACHMENTS, SLOT_NAMES, SLOT_COUNT, MAX_ATTACHMENTS, STAT_KEYS, STAT_LABELS,
  attachmentText, listToMask, toggleAttachment, canAddAttachment, popcount6,
  displayStats, encodeLoadout, decodeLoadout, sanitizeMask,
} from '../shared/weapons.js';

/** A sensible starting build per gun (two attachments that patch the gun's weak side). */
export const DEFAULT_BUILD_KEYS = [
  ['barrel', 'quick'],     // Maul: reach and a faster handle for the heavy rifle
  ['extmag', 'optic'],     // Vireo: more rounds, and an optic to give the light carbine reach
  ['quick', 'stock'],      // Kestrel: even quicker
  ['stock', 'quick'],      // Halberd: patch its sluggishness
  ['extmag', 'barrel'],    // Breaker: more shells, tighter pattern
  ['barrel', 'quick'],     // Squall: pattern and reload
];
export const DEFAULT_BUILDS = DEFAULT_BUILD_KEYS.map((l) => listToMask(l));

/** Saved/default loadout -> { code, builds } with everything valid. */
export function normalizeSaved(saved) {
  const builds = DEFAULT_BUILDS.slice();
  if (saved && Array.isArray(saved.builds)) for (let g = 0; g < 6; g++) if (Number.isInteger(saved.builds[g])) builds[g] = sanitizeMask(saved.builds[g]);
  let code;
  if (saved && Number.isInteger(saved.code)) code = encodeLoadout(decodeLoadout(saved.code));
  else code = encodeLoadout({ slots: [0, 1, 2].map((s) => ({ gun: s * 2, att: builds[s * 2] })) });
  const lo = decodeLoadout(code);
  for (let s = 0; s < SLOT_COUNT; s++) builds[lo.slots[s].gun] = lo.slots[s].att;
  return { code, builds };
}

// ---- short copy. One line per attachment (the full class-specific text sits behind the "i" button).
const ATT_LINE = [
  '+zoom, slower aim',        // optic
  '+50% ammo, slower reload', // extmag
  '+15% damage, slower fire', // heavy
  '+range, slower move',      // barrel
  '+speed, looser aim',       // stock
  '+fast reload, less ammo',  // quick
];
const GUN_ROLE = ['Heavy battle rifle', 'Fast light carbine', 'Light bolt sniper', 'One-shot heavy rifle', 'Pump shotgun', 'Full-auto shotgun'];
const ATT_AREA_SHORT = ['sight', 'magazine', 'ammo', 'barrel', 'stock', 'grip'];

const SVG = (inner) => `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ATT_ICON = [
  SVG('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>'),               // optic: reticle
  SVG('<path d="M8 3.5h7.5v12.5l-2.8 4.5H8z"/><path d="M8 8h7.5M8 12h7.5"/><path d="M18.5 6v5M16 8.5h5" stroke-width="1.5"/>'),                                  // extended mag
  SVG('<path d="M8.5 21V10.5c0-3 1.6-5.3 3.5-7.5 1.9 2.2 3.5 4.5 3.5 7.5V21z"/><path d="M8.5 16h7"/><path d="M12 11.5v2.5"/>'),                                  // heavy round
  SVG('<rect x="2.5" y="10" width="13" height="4.2" rx="1"/><path d="M15.5 8.8h4.2v6.6h-4.2"/><path d="M21.5 8v8"/><path d="M6 10V8M10 10V8"/>'),                  // long barrel
  SVG('<path d="M3 8.5l4.5-2.5H21v12H7.5L3 15.5z"/><path d="M10.5 9.5h7v5h-7z"/>'),                                                                                 // skeleton stock
  SVG('<path d="M13.5 2.5L5 13.5h6l-1 8 9-12h-6z"/>'),                                                                                                              // quick hands: bolt
];
const INFO_I = '<svg viewBox="0 0 16 16" width="100%" height="100%" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="4.9" r="1" fill="currentColor"/><path d="M8 7.3v4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createLoadoutEditor(host, opts = {}) {
  let slots = [0, 1, 2].map((s) => ({ gun: s * 2, att: DEFAULT_BUILDS[s * 2] }));
  const builds = DEFAULT_BUILDS.slice();
  let sel = 0;
  let status = { pendingCode: -1, activeCode: -2, joined: false };
  let warnTimer = 0;
  let hover = -1, picked = -1;          // attachment shown on the preview: hovered/focused one, else the last one tapped
  let tip = null;                       // { kind: 'att'|'gun', id } while the detail tip is open

  host.classList.add('hs-lo');
  host.innerHTML = `
    <div class="hs-lo-head">
      <div class="hs-lo-slots" role="tablist" aria-label="Weapon slot"></div>
      <div class="hs-lo-bar">
        <div class="hs-lo-status" role="status" title=""><i></i><span class="long"></span><span class="short"></span></div>
        <button type="button" class="hs-btn hs-lo-reset" title="Back to the default guns and builds">Reset</button>
        <button type="button" class="hs-lo-play">PLAY</button>
      </div>
    </div>
    <div class="hs-lo-body">
      <div class="hs-lo-stage">
        <div class="hs-lo-view">
          <canvas class="hs-lo-cv" aria-label="Gun preview"></canvas>
          <div class="hs-lo-nowgun"><b></b><span></span></div>
          <div class="hs-lo-hl" aria-live="polite"><i></i><b></b><span></span></div>
          <div class="hs-lo-tip" role="dialog"><div class="tt"><b></b><button type="button" class="x" aria-label="Close">&times;</button></div><p class="d"></p><p class="pro"></p><p class="con"></p><p class="kill"></p></div>
        </div>
        <div class="hs-lo-stats" aria-label="Gun ratings"></div>
      </div>
      <div class="hs-lo-opts">
        <p class="hs-lo-hint" hidden><i aria-hidden="true"></i><span></span></p>
        <div class="hs-lo-guns"></div>
        <div class="hs-lo-atthead">
          <span class="t">Attachments</span>
          <span class="hs-pips" role="img"></span>
          <button type="button" class="hs-lo-link hs-lo-def" title="Use the suggested attachments for this gun">Default</button>
          <button type="button" class="hs-lo-link hs-lo-clear">Clear</button>
        </div>
        <div class="hs-lo-msg" role="alert"></div>
        <div class="hs-lo-atts"></div>
      </div>
    </div>`;
  const $ = (s) => host.querySelector(s);
  const el = {
    status: $('.hs-lo-status'), statusLong: $('.hs-lo-status .long'), statusShort: $('.hs-lo-status .short'),
    play: $('.hs-lo-play'), reset: $('.hs-lo-reset'),
    slots: $('.hs-lo-slots'), guns: $('.hs-lo-guns'), pips: $('.hs-pips'), msg: $('.hs-lo-msg'),
    atts: $('.hs-lo-atts'), stats: $('.hs-lo-stats'), def: $('.hs-lo-def'), clear: $('.hs-lo-clear'),
    hint: $('.hs-lo-hint'), hintT: $('.hs-lo-hint span'),
    view: $('.hs-lo-view'), cv: $('.hs-lo-cv'), nowGun: $('.hs-lo-nowgun'), hl: $('.hs-lo-hl'), tip: $('.hs-lo-tip'),
  };

  // ---- the one shared 3D preview (lazy: no WebGL context until the tab is first shown)
  let pv = null;
  function getPreview() {
    if (!pv) {
      pv = createGunPreview(el.cv);
      if (!pv.ok) el.view.classList.add('nogl');
    }
    return pv;
  }
  const snaps = new Map();
  function snapUrl(gun, mask) {
    const p = getPreview();
    if (!p.ok) return '';
    const k = gun * 64 + mask;
    let u = snaps.get(k);
    if (u === undefined) {
      u = p.snapshot(gun, mask, 360, 180);
      if (snaps.size > 70) snaps.clear();
      snaps.set(k, u);
    }
    return u;
  }
  // run the animation only while the Loadout tab is actually on screen
  let onScreen = false;
  function syncRun() {
    if (!pv) return;
    if (onScreen && document.visibilityState !== 'hidden') pv.start(); else pv.stop();
  }
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((es) => {
      onScreen = es[es.length - 1].isIntersecting;
      if (onScreen) render();          // first show (or re-show): build the preview + card images now
      syncRun();
    }).observe(el.view);
  } else onScreen = true;
  document.addEventListener('visibilitychange', syncRun);

  function code() { return encodeLoadout({ slots }); }
  function changed() {
    for (const s of slots) builds[s.gun] = s.att;
    render();
    if (opts.onChange) opts.onChange({ code: code(), builds: builds.slice() });
  }
  function warn(text) {
    el.msg.textContent = text;
    el.msg.classList.add('on');
    el.pips.classList.remove('shake'); void el.pips.offsetWidth; el.pips.classList.add('shake');
    clearTimeout(warnTimer);
    warnTimer = setTimeout(() => { el.msg.classList.remove('on'); el.pips.classList.remove('shake'); }, 2400);
  }
  function clearWarn() { clearTimeout(warnTimer); el.msg.classList.remove('on'); el.msg.textContent = ''; el.pips.classList.remove('shake'); }

  // ---- slot tabs
  for (let s = 0; s < SLOT_COUNT; s++) {
    const b = h('button', 'hs-lo-slot');
    b.type = 'button'; b.setAttribute('role', 'tab');
    b.append(h('em', '', String(s + 1)), h('span', 'c', SLOT_NAMES[s]), h('b', 'g'));
    b.addEventListener('click', () => { sel = s; picked = -1; hover = -1; closeTip(); clearWarn(); render(); });
    el.slots.appendChild(b);
  }
  const slotBtns = Array.from(el.slots.children);

  // ---- gun cards: render + name + 3-word role
  const gunCards = [0, 1].map((v) => {
    const wrap = h('div', 'hs-gun');
    const b = h('button', 'main');
    b.type = 'button';
    const img = h('img'); img.alt = ''; img.draggable = false;
    const txt = h('span', 'txt');
    txt.append(h('b', 'n'), h('span', 'role'));
    b.append(h('span', 'pic'), txt);
    b.firstChild.appendChild(img);
    b.addEventListener('click', () => pickGun(v));
    const inf = h('button', 'inf'); inf.type = 'button'; inf.innerHTML = INFO_I; inf.setAttribute('aria-label', 'Gun details');
    inf.addEventListener('click', (e) => { e.stopPropagation(); toggleTip('gun', sel * 2 + v); });
    wrap.append(b, inf);
    el.guns.appendChild(wrap);
    return { wrap, b, img, n: b.querySelector('.n'), role: b.querySelector('.role') };
  });
  function pickGun(v) {
    const g = sel * 2 + v;
    if (slots[sel].gun === g) return;
    builds[slots[sel].gun] = slots[sel].att;
    slots[sel] = { gun: g, att: builds[g] };
    picked = -1; hover = -1; closeTip();
    clearWarn();
    changed();
  }

  // ---- attachment tiles: icon + name + one line; hover / focus / tap lights the part on the preview
  const attTiles = ATTACHMENTS.map((a) => {
    const wrap = h('div', 'hs-att');
    const b = h('button', 'main');
    b.type = 'button';
    const ico = h('span', 'ico'); ico.innerHTML = ATT_ICON[a.id];
    b.append(ico, h('b', 'n', a.name), h('span', 'ln', ATT_LINE[a.id]), h('i', 'ck'));
    b.addEventListener('click', () => toggleAtt(a.id));
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hover = a.id; renderView(); } });
    b.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && hover === a.id) { hover = -1; renderView(); } });
    b.addEventListener('focus', () => { hover = a.id; renderView(); });
    b.addEventListener('blur', () => { if (hover === a.id) { hover = -1; renderView(); } });
    const inf = h('button', 'inf'); inf.type = 'button'; inf.innerHTML = INFO_I; inf.setAttribute('aria-label', a.name + ' details');
    inf.addEventListener('click', (e) => { e.stopPropagation(); toggleTip('att', a.id); });
    wrap.append(b, inf);
    el.atts.appendChild(wrap);
    return { wrap, b };
  });
  function toggleAtt(id) {
    const cur = slots[sel].att;
    if (!canAddAttachment(cur, id)) {
      warn(`Three attachments max - remove one to fit ${ATTACHMENTS[id].name}.`);
      const w = attTiles[id].wrap; w.classList.remove('refuse'); void w.offsetWidth; w.classList.add('refuse');
      picked = id;
      renderView();
      return;
    }
    clearWarn();
    const next = toggleAttachment(cur, id);
    slots[sel] = { gun: slots[sel].gun, att: next };
    picked = (next >> id) & 1 ? id : -1;
    changed();
  }
  el.def.addEventListener('click', () => { slots[sel] = { gun: slots[sel].gun, att: DEFAULT_BUILDS[slots[sel].gun] }; picked = -1; clearWarn(); changed(); });
  el.clear.addEventListener('click', () => { slots[sel] = { gun: slots[sel].gun, att: 0 }; picked = -1; clearWarn(); changed(); });
  el.reset.addEventListener('click', () => {
    for (let g = 0; g < 6; g++) builds[g] = DEFAULT_BUILDS[g];
    slots = [0, 1, 2].map((s) => ({ gun: s * 2, att: DEFAULT_BUILDS[s * 2] }));
    picked = -1; hover = -1; closeTip();
    clearWarn();
    changed();
  });
  el.play.addEventListener('click', () => { if (opts.onPlay) opts.onPlay(); });

  // ---- detail tip (the long text), shown over the preview on request
  const tipEl = { box: el.tip, title: el.tip.querySelector('.tt b'), d: el.tip.querySelector('.d'), pro: el.tip.querySelector('.pro'), con: el.tip.querySelector('.con'), kill: el.tip.querySelector('.kill') };
  el.tip.querySelector('.x').addEventListener('click', closeTip);
  el.tip.addEventListener('click', closeTip);
  function toggleTip(kind, id) {
    if (tip && tip.kind === kind && tip.id === id) { closeTip(); return; }
    tip = { kind, id };
    renderTip();
  }
  function closeTip() { tip = null; renderTip(); }
  function renderTip() {
    el.tip.classList.toggle('on', !!tip);
    if (!tip) return;
    if (tip.kind === 'att') {
      const cls = GUNS[slots[sel].gun].cls, t = attachmentText(tip.id, cls);
      tipEl.title.textContent = `${t.name} · ${t.area}`;
      tipEl.d.textContent = t.desc; tipEl.pro.textContent = '+ ' + t.pro; tipEl.con.textContent = '− ' + t.con; tipEl.kill.textContent = '';
    } else {
      const g = GUNS[tip.id], d = displayStats(tip.id, builds[tip.id] || 0);
      tipEl.title.textContent = `${g.name} · ${GUN_ROLE[g.id]}`;
      tipEl.d.textContent = g.desc; tipEl.pro.textContent = '+ ' + g.pro; tipEl.con.textContent = '− ' + g.con;
      tipEl.kill.textContent = `Point blank: ${d.raw.shotsBody} body hit${d.raw.shotsBody > 1 ? 's' : ''} or ${d.raw.shotsHead} to the head to kill.`;
    }
  }

  // ---- compact stat bars (8 ratings, gain / cost colouring against the bare gun)
  const statRows = STAT_KEYS.map((k) => {
    const row = h('div', 'hs-st');
    const bar = h('div', 'bar');
    const base = h('i', 'b'), x = h('i', 'x');
    bar.append(base, x);
    const l = h('span', 'l', STAT_LABELS[k]), d = h('span', 'd');
    row.append(l, bar, d);
    el.stats.appendChild(row);
    return { k, row, base, x, d };
  });
  function renderStats() {
    const { gun, att } = slots[sel];
    const bare = displayStats(gun, 0), now = displayStats(gun, att);
    for (const r of statRows) {
      const from = bare.ratings[r.k], to = now.ratings[r.k], d = to - from, lo = Math.min(from, to);
      r.base.style.width = lo + '%';
      r.x.className = 'x ' + (d > 0 ? 'gain' : d < 0 ? 'cost' : 'none');
      r.x.style.left = lo + '%'; r.x.style.width = Math.abs(d) + '%';
      r.d.className = 'd ' + (d > 0 ? 'up' : d < 0 ? 'dn' : '');
      r.d.textContent = d === 0 ? '' : (d > 0 ? '+' : '−') + Math.abs(d);
      r.row.title = `${STAT_LABELS[r.k]}: ${bare.values[r.k]}${d ? ' → ' + now.values[r.k] : ''}`;
    }
  }

  // ---- the 3D view + its labels
  function renderView() {
    const cur = slots[sel], g = GUNS[cur.gun];
    const hl = hover >= 0 ? hover : picked;
    if (onScreen) {
      const p = getPreview();
      if (p.ok) { p.setModel(cur.gun, cur.att, hl); syncRun(); }
    }
    el.nowGun.firstChild.textContent = g.name;
    el.nowGun.lastChild.textContent = GUN_ROLE[g.id];
    const has = hl >= 0;
    el.hl.classList.toggle('on', has);
    if (has) {
      const fitted = (cur.att >> hl) & 1;
      el.hl.classList.toggle('fitted', !!fitted);
      el.hl.querySelector('b').textContent = ATTACHMENTS[hl].name;
      el.hl.querySelector('span').textContent = fitted ? 'fitted · ' + ATT_AREA_SHORT[hl] : 'preview · ' + ATT_AREA_SHORT[hl];
      const info = pv && pv.ok ? pv.partInfo(cur.gun, cur.att, hl) : { parts: 1 };
      el.hl.classList.toggle('nomodel', info.parts === 0);
    }
  }

  function render() {
    for (let s = 0; s < SLOT_COUNT; s++) {
      const b = slotBtns[s], e = slots[s];
      b.classList.toggle('on', s === sel);
      b.setAttribute('aria-selected', s === sel ? 'true' : 'false');
      b.querySelector('.g').textContent = GUNS[e.gun].name;
    }
    const cur = slots[sel], cls = GUNS[cur.gun].cls;
    for (let v = 0; v < 2; v++) {
      const g = GUNS[sel * 2 + v], c = gunCards[v], on = cur.gun === g.id;
      c.wrap.classList.toggle('on', on);
      c.b.setAttribute('aria-pressed', on ? 'true' : 'false');
      c.n.textContent = g.name;
      c.role.textContent = GUN_ROLE[g.id];
      if (onScreen) {
        const url = snapUrl(g.id, g.id === cur.gun ? cur.att : builds[g.id]);
        if (url && c.img.dataset.u !== url) { c.img.dataset.u = url; c.img.src = url; }
        c.img.style.visibility = url ? '' : 'hidden';
      }
    }
    const n = popcount6(cur.att), full = n >= MAX_ATTACHMENTS;
    el.pips.textContent = '';
    for (let i = 0; i < MAX_ATTACHMENTS; i++) el.pips.appendChild(h('i', i < n ? 'on' : ''));
    el.pips.setAttribute('aria-label', `${n} of ${MAX_ATTACHMENTS} attachment slots used`);
    el.pips.classList.toggle('full', full);
    for (const a of ATTACHMENTS) {
      const t = attTiles[a.id], on = (cur.att >> a.id) & 1;
      t.wrap.classList.toggle('on', !!on);
      t.wrap.classList.toggle('locked', !on && full);
      t.b.setAttribute('aria-pressed', on ? 'true' : 'false');
      t.b.title = attachmentText(a.id, cls).pro + ' / ' + attachmentText(a.id, cls).con;
    }
    renderStats();
    renderView();
    if (tip) renderTip();
    renderStatus();
  }

  function renderStatus() {
    let kind, text, short;
    if (!status.joined) { kind = 'idle'; text = 'This loadout is used when you join'; short = 'Used on join'; }
    else if (status.pendingCode === status.activeCode) { kind = 'ok'; text = 'Equipped'; short = 'Equipped'; }
    else { kind = 'wait'; text = 'Applies on your next spawn'; short = 'Next spawn'; }
    el.status.dataset.state = kind;
    el.statusLong.textContent = text;
    el.statusShort.textContent = short;
    el.status.title = text;
  }

  return {
    setState(saved) {
      const n = normalizeSaved(saved);
      for (let g = 0; g < 6; g++) builds[g] = n.builds[g];
      const lo = decodeLoadout(n.code);
      slots = lo.slots.map((s) => ({ gun: s.gun, att: s.att }));
      render();
    },
    setStatus(s) { status = { ...status, ...s }; renderStatus(); },
    setPlayLabel(t) { el.play.textContent = t; },
    setTip(text) {
      const t = typeof text === 'string' ? text : '';
      if (el.hintT.textContent !== t) el.hintT.textContent = t;
      el.hint.hidden = !t;
    },
    refresh() { render(); },
    get code() { return code(); },
    get builds() { return builds.slice(); },
    get preview() { return pv; },
  };
}
