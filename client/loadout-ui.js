// Hopshot loadout editor (the menu's Loadout tab). Pure DOM, styled by client/style.css (.hs-lo*).
//
// The editor owns the working loadout: for each of the 3 class slots a gun (A or B) and an attachment
// mask (max 3 of 6). It also remembers a build per gun (so flipping A <-> B restores each gun's own
// attachments). Everything shown comes from shared/weapons.js (names, blurbs, pro/con text, the stat
// panel and its deltas against the bare gun), so the numbers can never disagree with the rules.
//
//   const ed = createLoadoutEditor(hostEl, { onChange({ code, builds }), onPlay() });
//   ed.setState({ code, builds })     load a saved loadout (any garbage is sanitised)
//   ed.setStatus({ pendingCode, activeCode, joined })   honest timing line
//   ed.setPlayLabel('PLAY' | 'RESUME')
//   ed.refresh()                      call when the tab becomes visible
//
// Persisted form (main.js keeps it in localStorage 'hopshot.loadout'): { code: int, builds: [6 masks] }.

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

const STAT_SHORT = {
  accuracy: (d) => `${d.raw.adsSpreadDeg}° aimed · ${d.raw.hipSpreadDeg}° hip`,
  handling: (d) => `${Math.round(d.raw.adsMs)} ms aim · ${Math.round(d.raw.swapMs)} swap`,
};

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

  host.classList.add('hs-lo');
  host.innerHTML = `
    <div class="hs-lo-head">
      <div class="hs-lo-bar">
        <div class="hs-lo-status" role="status"><i></i><span></span></div>
        <button type="button" class="hs-btn hs-lo-reset">Reset all</button>
        <button type="button" class="hs-lo-play">PLAY</button>
      </div>
      <div class="hs-lo-slots" role="tablist" aria-label="Weapon slot"></div>
    </div>
    <div class="hs-lo-cols">
      <div class="hs-lo-left">
        <div class="hs-lo-guns"></div>
        <div class="hs-lo-atthead">
          <span class="t">Attachments</span><b class="cnt" aria-live="polite"></b>
          <button type="button" class="hs-lo-link hs-lo-def">Default build</button>
          <button type="button" class="hs-lo-link hs-lo-clear">Clear</button>
        </div>
        <div class="hs-lo-msg" role="alert"></div>
        <div class="hs-lo-atts"></div>
      </div>
      <div class="hs-lo-right"><div class="hs-lo-stats"></div></div>
    </div>`;
  const $ = (s) => host.querySelector(s);
  const el = {
    status: $('.hs-lo-status'), statusText: $('.hs-lo-status span'), play: $('.hs-lo-play'), reset: $('.hs-lo-reset'),
    slots: $('.hs-lo-slots'), guns: $('.hs-lo-guns'), cnt: $('.hs-lo-atthead .cnt'), msg: $('.hs-lo-msg'),
    atts: $('.hs-lo-atts'), stats: $('.hs-lo-stats'), def: $('.hs-lo-def'), clear: $('.hs-lo-clear'),
  };

  function code() { return encodeLoadout({ slots }); }
  function changed() {
    for (const s of slots) builds[s.gun] = s.att;
    render();
    if (opts.onChange) opts.onChange({ code: code(), builds: builds.slice() });
  }
  function warn(text) {
    el.msg.textContent = text;
    el.msg.classList.add('on');
    el.cnt.classList.remove('shake'); void el.cnt.offsetWidth; el.cnt.classList.add('shake');
    clearTimeout(warnTimer);
    warnTimer = setTimeout(() => { el.msg.classList.remove('on'); el.cnt.classList.remove('shake'); }, 2400);
  }
  function clearWarn() { clearTimeout(warnTimer); el.msg.classList.remove('on'); el.msg.textContent = ''; el.cnt.classList.remove('shake'); }

  // ---- slot tabs
  for (let s = 0; s < SLOT_COUNT; s++) {
    const b = h('button', 'hs-lo-slot');
    b.type = 'button'; b.setAttribute('role', 'tab');
    b.append(h('em', '', String(s + 1)), h('span', 'c', SLOT_NAMES[s]), h('b', 'g'), h('small', 'a'));
    b.addEventListener('click', () => { sel = s; clearWarn(); render(); });
    el.slots.appendChild(b);
  }
  const slotBtns = Array.from(el.slots.children);

  // ---- gun cards
  const gunBtns = [0, 1].map((v) => {
    const b = h('button', 'hs-gun');
    b.type = 'button';
    b.append(h('b', 'n'), h('span', 'bl'), h('span', 'pro'), h('span', 'con'));
    b.addEventListener('click', () => pickGun(v));
    el.guns.appendChild(b);
    return b;
  });
  function pickGun(v) {
    const g = sel * 2 + v;
    if (slots[sel].gun === g) return;
    builds[slots[sel].gun] = slots[sel].att;
    slots[sel] = { gun: g, att: builds[g] };
    clearWarn();
    changed();
  }

  // ---- attachment chips
  const attBtns = ATTACHMENTS.map((a) => {
    const b = h('button', 'hs-att');
    b.type = 'button';
    const top = h('span', 'top');
    top.append(h('b', 'n', a.name), h('em', 'ar', a.area));
    b.append(h('i', 'ck'), top, h('span', 'pro'), h('span', 'con'));
    b.addEventListener('click', () => toggleAtt(a.id));
    el.atts.appendChild(b);
    return b;
  });
  function toggleAtt(id) {
    const cur = slots[sel].att;
    if (!canAddAttachment(cur, id)) {
      warn(`A gun can carry only ${MAX_ATTACHMENTS} attachments. Remove one to add ${ATTACHMENTS[id].name}.`);
      const b = attBtns[id]; b.classList.remove('refuse'); void b.offsetWidth; b.classList.add('refuse');
      return;
    }
    clearWarn();
    slots[sel] = { gun: slots[sel].gun, att: toggleAttachment(cur, id) };
    changed();
  }
  el.def.addEventListener('click', () => { slots[sel] = { gun: slots[sel].gun, att: DEFAULT_BUILDS[slots[sel].gun] }; clearWarn(); changed(); });
  el.clear.addEventListener('click', () => { slots[sel] = { gun: slots[sel].gun, att: 0 }; clearWarn(); changed(); });
  el.reset.addEventListener('click', () => {
    for (let g = 0; g < 6; g++) builds[g] = DEFAULT_BUILDS[g];
    slots = [0, 1, 2].map((s) => ({ gun: s * 2, att: DEFAULT_BUILDS[s * 2] }));
    clearWarn();
    changed();
  });
  el.play.addEventListener('click', () => { if (opts.onPlay) opts.onPlay(); });

  // ---- stat panel
  function renderStats() {
    const { gun, att } = slots[sel];
    const bare = displayStats(gun, 0), now = displayStats(gun, att);
    const g = GUNS[gun];
    el.stats.textContent = '';
    const head = h('div', 'hs-st-head');
    head.append(h('b', '', g.name), h('span', '', att ? `with ${popcount6(att)} attachment${popcount6(att) > 1 ? 's' : ''}` : 'bare gun'));
    el.stats.appendChild(head);
    for (const k of STAT_KEYS) {
      const from = bare.ratings[k], to = now.ratings[k], d = to - from;
      const row = h('div', 'hs-st');
      const bar = h('div', 'bar');
      const lo = Math.min(from, to);
      const base = h('i', 'b'); base.style.width = lo + '%';
      bar.appendChild(base);
      if (d !== 0) {
        const x = h('i', d > 0 ? 'x gain' : 'x cost');
        x.style.left = lo + '%'; x.style.width = Math.abs(d) + '%';
        bar.appendChild(x);
      }
      const val = STAT_SHORT[k] ? STAT_SHORT[k](now) : now.values[k];
      bar.appendChild(h('span', 'val', val));
      row.append(h('span', 'l', STAT_LABELS[k]), bar, h('span', 'd ' + (d > 0 ? 'up' : d < 0 ? 'dn' : ''), d === 0 ? '–' : (d > 0 ? '+' : '−') + Math.abs(d)));
      row.title = `${STAT_LABELS[k]}: ${bare.values[k]}${d ? ' → ' + now.values[k] : ''}`;
      el.stats.appendChild(row);
    }
    const hits = h('div', 'hs-st-note');
    hits.textContent = `Point blank: ${now.raw.shotsBody} body hit${now.raw.shotsBody > 1 ? 's' : ''}, ${now.raw.shotsHead} head hit${now.raw.shotsHead > 1 ? 's' : ''} to kill.`;
    const key = h('div', 'hs-st-key');
    key.append(h('i', 'gain'), document.createTextNode(' better than bare gun   '), h('i', 'cost'), document.createTextNode(' worse'));
    el.stats.append(hits, key);
  }

  function render() {
    for (let s = 0; s < SLOT_COUNT; s++) {
      const b = slotBtns[s], e = slots[s];
      b.classList.toggle('on', s === sel);
      b.setAttribute('aria-selected', s === sel ? 'true' : 'false');
      b.querySelector('.g').textContent = GUNS[e.gun].name;
      b.querySelector('.a').textContent = `${popcount6(e.att)}/${MAX_ATTACHMENTS}`;
    }
    const cur = slots[sel], cls = GUNS[cur.gun].cls;
    for (let v = 0; v < 2; v++) {
      const g = GUNS[sel * 2 + v], b = gunBtns[v];
      b.classList.toggle('on', cur.gun === g.id);
      b.setAttribute('aria-pressed', cur.gun === g.id ? 'true' : 'false');
      b.querySelector('.n').textContent = g.name;
      b.querySelector('.bl').textContent = g.blurb;
      b.querySelector('.pro').textContent = '+ ' + g.pro;
      b.querySelector('.con').textContent = '− ' + g.con;
    }
    const n = popcount6(cur.att), full = n >= MAX_ATTACHMENTS;
    el.cnt.textContent = full ? `${n}/${MAX_ATTACHMENTS} full` : `${n}/${MAX_ATTACHMENTS}`;
    el.cnt.classList.toggle('full', full);
    for (const a of ATTACHMENTS) {
      const b = attBtns[a.id], on = (cur.att >> a.id) & 1, t = attachmentText(a.id, cls);
      b.classList.toggle('on', !!on);
      b.classList.toggle('locked', !on && full);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.querySelector('.pro').textContent = '+ ' + t.pro;
      b.querySelector('.con').textContent = '− ' + t.con;
    }
    renderStats();
    renderStatus();
  }

  function renderStatus() {
    let kind, text;
    if (!status.joined) { kind = 'idle'; text = 'This loadout is used when you join'; }
    else if (status.pendingCode === status.activeCode) { kind = 'ok'; text = 'Equipped'; }
    else { kind = 'wait'; text = 'Applies on your next spawn'; }
    el.status.dataset.state = kind;
    el.statusText.textContent = text;
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
    refresh: render,
    get code() { return code(); },
    get builds() { return builds.slice(); },
  };
}
