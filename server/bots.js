// Server-side bots. They never touch the simulation directly: each tick a bot builds a cmd
// exactly like a client would and pushes it through room.pushBotCmd (sanitise + jitter buffer),
// so they move with stepPlayer and shoot with stepWeapon + the lag-comp hitscan.
//
// Navigation (server/nav.js): flow fields towards fixed goals (flag stands, hardpoints, roam
// points) are precomputed once per map, so following one costs a cell lookup per tick; the
// only search is a budgeted A* towards a dropped flag (rare, rate-limited per room).
//
// Behaviour per mode (re-decided every ~0.5 s, staggered):
//   ffa / tdm  roam between spread-out points; fight what they see.
//   ctf        carrier: run home (wait near the stand if our flag is away). Our flag dropped:
//              the nearest bots / defenders go and touch it. Our flag carried: chase the
//              carrier if seen, else head for the enemy stand to intercept. Attackers (about
//              2 in 3): go for the enemy flag (home or dropped); escort a friendly carrier home.
//              Defenders (every third bot): hold near the own stand.
//   hardpoint  go to the active zone and hold it (wander inside it); fight while moving.
// Only enemies are scanned / targeted (friendly fire is off anyway). Fighting never stops a
// bot from moving towards its goal: it aims at the target while strafing along the route.

import { BTN } from '../shared/constants.js';
import { encodeLoadout, displayStats } from '../shared/weapons.js';
import { eyeHeight, hitboxHeight, raycastWorld, MOVE } from '../shared/physics.js';
import { createCmd } from '../shared/protocol.js';
import { otherTeam } from '../shared/modes.js';
import { getNav } from './nav.js';
import { prewarmSpawns } from './spawns.js';

const NAMES = ['Pixel', 'Bolt', 'Nova', 'Echo', 'Rook', 'Flux', 'Zephyr', 'Quill', 'Moss', 'Tango',
  'Vex', 'Juno', 'Kit', 'Orbit', 'Sable', 'Dot', 'Wren', 'Cobalt', 'Fig', 'Lumen'];
const SCAN_EVERY = 6;          // ticks between visibility scans (staggered by id)
const DECIDE_EVERY = 30;       // ticks between goal decisions (staggered by id)
const VIEW_RANGE = 70;
const TURN_IDLE = 0.12;        // rad per tick
const TURN_COMBAT = 0.3;
// Difficulty (room.config.bots.level). 'hard' is the original tuning.
//   skill: scales reaction time and initial aim error (lower = slower, sloppier)
//   decay: how fast the initial aim error closes (closer to 1 = slower)
//   sway:  constant aim wobble (rad); turn: max aim turn per tick in combat
//   view:  sight range (m); burst: fraction of the time an auto gun keeps firing
const BOT_LEVEL = {
  easy:   { skill: 0.45, decay: 0.992, sway: 0.05,  turn: 0.14, view: 40, burst: 0.45 },
  normal: { skill: 0.7,  decay: 0.985, sway: 0.028, turn: 0.2,  view: 55, burst: 0.75 },
  hard:   { skill: 1,    decay: 0.97,  sway: 0.012, turn: TURN_COMBAT, view: VIEW_RANGE, burst: 1 },
};
function levelOf(room) {
  const l = room && room.config && room.config.bots && room.config.bots.level;
  return BOT_LEVEL[l] || BOT_LEVEL.hard;
}
const TWO_PI = Math.PI * 2;
const STEP = MOVE.stepHeight;
const PATH_BUDGET_PER_TICK = 1;   // A* searches per room per tick
const ROAM_POINTS = 10;

function wrapAngle(a) {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}
function approach(cur, target, maxStep) {
  const d = wrapAngle(target - cur);
  return wrapAngle(cur + (d > maxStep ? maxStep : d < -maxStep ? -maxStep : d));
}
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Sensible per-slot builds bots choose from (gun key + attachment keys). Every gun appears,
// with builds that suit how bots fight (rifles at range, shotguns close, snipers aimed).
const BOT_BUILDS = [
  [ // assault
    { gun: 'maul', att: [] }, { gun: 'maul', att: ['optic', 'barrel'] }, { gun: 'maul', att: ['extmag', 'heavy'] },
    { gun: 'maul', att: ['stock', 'quick', 'barrel'] },
    { gun: 'vireo', att: [] }, { gun: 'vireo', att: ['stock', 'quick'] }, { gun: 'vireo', att: ['optic', 'barrel', 'extmag'] },
    { gun: 'vireo', att: ['heavy', 'barrel'] },
  ],
  [ // sniper
    { gun: 'kestrel', att: [] }, { gun: 'kestrel', att: ['optic'] }, { gun: 'kestrel', att: ['stock', 'quick'] },
    { gun: 'halberd', att: [] }, { gun: 'halberd', att: ['extmag', 'quick'] }, { gun: 'halberd', att: ['optic', 'barrel'] },
  ],
  [ // shotgun
    { gun: 'breaker', att: [] }, { gun: 'breaker', att: ['barrel', 'heavy'] }, { gun: 'breaker', att: ['stock', 'quick'] },
    { gun: 'squall', att: [] }, { gun: 'squall', att: ['extmag', 'stock'] }, { gun: 'squall', att: ['barrel', 'heavy'] },
  ],
];

/** Fixed goals of a map: key -> [x, y, z]. */
function goalPos(map, key) {
  const [kind, arg] = key.split(':');
  if (kind === 'flag') return map.flags[arg];
  if (kind === 'hp') {
    const z = map.hardpoints[+arg];
    return [(z.min[0] + z.max[0]) / 2, z.min[1], (z.min[2] + z.max[2]) / 2];
  }
  if (kind === 'roam') return roamPoints(map)[+arg];
  return null;
}
const roamCache = new Map();
function roamPoints(map) {
  let r = roamCache.get(map.id);
  if (!r) {
    r = [];
    const s = map.spawns, step = Math.max(1, Math.floor(s.length / ROAM_POINTS));
    for (let i = 0; i < s.length && r.length < ROAM_POINTS; i += step) r.push(s[i].pos);
    for (const z of map.hardpoints || []) r.push([(z.min[0] + z.max[0]) / 2, z.min[1], (z.min[2] + z.max[2]) / 2]);
    roamCache.set(map.id, r);
  }
  return r;
}

export class Bot {
  /** A random sensible loadout code (one build per slot from BOT_BUILDS). */
  static pickLoadout() {
    return encodeLoadout({ slots: BOT_BUILDS.map((list) => { const b = pick(list); return { gun: b.gun, att: b.att }; }) });
  }

  static pickName(room) {
    const used = new Set(room.players.map((p) => p.name));
    const free = NAMES.filter((n) => !used.has(n));
    return free.length ? free[Math.floor(Math.random() * free.length)] : `Bot${Math.floor(Math.random() * 1000)}`;
  }

  /** Queue the flow fields this room's map + mode needs; Bot.warmStep computes one per tick. */
  static warm(room) {
    const map = room.map, mode = room.config.mode, keys = [];
    if (mode === 'ctf' && map.flags) keys.push('flag:a', 'flag:b');
    if (mode === 'hardpoint') for (let i = 0; i < (map.hardpoints || []).length; i++) keys.push(`hp:${i}`);
    if (mode === 'ffa' || mode === 'tdm') for (let i = 0; i < roamPoints(map).length; i++) keys.push(`roam:${i}`);
    room.botWarm = keys;
  }
  /**
   * Build every map's nav grid and every fixed-goal flow field ahead of time, one piece per
   * macrotask (so a starting server stays responsive). Returns a promise; sync = true does it
   * all at once (tests).
   */
  static prewarm(maps, sync = false) {
    const jobs = [];
    for (const map of maps) {
      jobs.push(() => getNav(map));
      const keys = [];
      if (map.flags) keys.push('flag:a', 'flag:b');
      for (let i = 0; i < (map.hardpoints || []).length; i++) keys.push(`hp:${i}`);
      for (let i = 0; i < roamPoints(map).length; i++) keys.push(`roam:${i}`);
      for (const k of keys) jobs.push(() => getNav(map).field(k, goalPos(map, k)));
      jobs.push(() => prewarmSpawns(map));
    }
    if (sync) { for (const j of jobs) j(); return Promise.resolve(); }
    return new Promise((resolve) => {
      const next = () => { const j = jobs.shift(); if (!j) { resolve(); return; } j(); setImmediate(next); };
      setImmediate(next);
    });
  }

  static warmStep(room) {
    const key = room.botWarm.shift();
    if (key) getNav(room.map).field(`${key}`, goalPos(room.map, key));
  }

  constructor(room, player) {
    this.room = room;
    this.p = player;
    this.cmd = createCmd();
    this.seq = 1;
    this.yaw = 0;
    this.pitch = 0;
    this.target = null;
    this.lostTicks = 0;
    this.reactAt = 0;
    this.errYaw = 0; this.errPitch = 0;
    this.strafe = 1; this.strafeUntil = 0;
    this.stuck = 0; this.unstickUntil = 0; this.unstickDir = 1;
    this.slideTicks = 0;
    this.weapon = 0;
    this.skill = rnd(0.6, 1.0);
    this.firePulse = false;
    // goal: { key } (flow field) | { pos, path, i } (A* / straight) ; hold = wander radius at goal
    this.goal = null;
    this.goalUntil = 0;
    this.hold = null;           // { x, z, r } wander area when the goal is reached
    this.holdPt = null; this.holdUntil = 0;
    this.lastProgress = 0; this.bestDist = Infinity;
    this.mx = 0; this.mz = 0; this.jump = false;   // steering output
  }

  get nav() { return getNav(this.room.map); }

  /** Called by the room right before a respawn applies the pending loadout. */
  beforeSpawn() {
    if (Math.random() < 0.3) this.room.setLoadout(this.p, Bot.pickLoadout());
  }

  onSpawn(sp) {
    this.yaw = sp.yaw || 0;
    this.pitch = 0;
    this.target = null;
    this.stuck = 0;
    this.goal = null; this.hold = null; this.holdPt = null;
    this.goalUntil = 0;
    const r = Math.random();
    this.weapon = r < 0.55 ? 0 : r < 0.8 ? 1 : 2;
  }

  isEnemy(q) {
    const me = this.p;
    return q !== me && q.alive && !q.removed && (!me.team || q.team !== me.team);
  }

  onDamaged(attacker) {
    if (!this.target && attacker && this.isEnemy(attacker)) this.acquire(attacker, this.room.tick);
  }

  acquire(q, tick) {
    if (this.target === q) { this.lostTicks = 0; return; }
    this.target = q;
    this.lostTicks = 0;
    const sk = this.skill * levelOf(this.room).skill;
    this.reactAt = tick + Math.round(rnd(15, 27) / sk);   // 250-450 ms on hard (slower for weaker bots)
    const e = rnd(0.05, 0.12) / sk;
    this.errYaw = Math.random() < 0.5 ? -e : e;
    this.errPitch = rnd(-0.5, 0.5) * e;
    const dx = q.state.x - this.p.state.x, dz = q.state.z - this.p.state.z;
    const d2 = dx * dx + dz * dz;
    if (this.weapon !== 2 && d2 < 64 && Math.random() < 0.35) this.weapon = 2;          // close: shotgun
    else if (this.weapon === 2 && d2 > 400 && Math.random() < 0.6) this.weapon = 0;      // far: rifle
  }

  canSee(q) {
    const st = this.p.state;
    const ex = st.x, ey = st.y + eyeHeight(st), ez = st.z;
    const tx = q.state.x, ty = q.state.y + hitboxHeight(q.state) * 0.7, tz = q.state.z;
    let dx = tx - ex, dy = ty - ey, dz = tz - ez;
    const d = Math.hypot(dx, dy, dz);
    if (d > levelOf(this.room).view || d < 1e-3) return d < 1e-3;
    dx /= d; dy /= d; dz /= d;
    return raycastWorld(this.room.world, ex, ey, ez, dx, dy, dz, d, undefined) >= d - 0.3;
  }

  scan(tick) {
    const me = this.p;
    let best = null, bestD = Infinity;
    for (const q of this.room.players) {
      if (!this.isEnemy(q)) continue;
      const dx = q.state.x - me.state.x, dz = q.state.z - me.state.z;
      let d = dx * dx + dz * dz;
      if (q.carrying) d *= 0.25;                         // flag carriers first
      if (d >= bestD || d > levelOf(this.room).view ** 2) continue;
      // rough field of view (about 200 degrees) unless very close
      const ang = Math.abs(wrapAngle(Math.atan2(-dx, -dz) - this.yaw));
      if (ang > 1.75 && d > 36) continue;
      if (!this.canSee(q)) continue;
      best = q; bestD = d;
    }
    if (best) this.acquire(best, tick);
    else if (this.target) {
      if (!this.isEnemy(this.target) || this.room.byId.get(this.target.id) !== this.target || !this.canSee(this.target)) {
        this.lostTicks += SCAN_EVERY;
        if (this.lostTicks > 40 || !this.target.alive) this.target = null;
      }
    }
  }

  // ------------------------------------------------------------------ goals

  /** Index of this bot among its team's bots (stable: by id) -> role. */
  role() {
    let k = 0;
    for (const q of this.room.players) if (q.bot && q.team === this.p.team && q.id < this.p.id) k++;
    return k % 3 === 2 ? 'defend' : 'attack';
  }

  setField(key, hold) {
    if (!this.goal || this.goal.key !== key) { this.goal = { key }; this.bestDist = Infinity; this.lastProgress = this.room.tick; }
    this.hold = hold || null;
  }
  setPos(x, y, z, hold) {
    const g = this.goal;
    if (g && g.pos && Math.hypot(g.pos[0] - x, g.pos[2] - z) < 1.5) { this.hold = hold || null; return; }
    this.goal = { pos: [x, y, z], path: null, i: 0, wantPath: true };
    this.bestDist = Infinity; this.lastProgress = this.room.tick;
    this.hold = hold || null;
  }

  decide(tick) {
    const room = this.room, me = this.p, st = me.state, mode = room.config.mode;
    if (mode === 'ctf' && room.flags && me.team) return this.decideCtf(tick);
    if (mode === 'hardpoint' && room.hp) {
      const z = room.map.hardpoints[room.hp.index];
      const cx = (z.min[0] + z.max[0]) / 2, cz = (z.min[2] + z.max[2]) / 2;
      this.setField(`hp:${room.hp.index}`, { x: cx, z: cz, rx: (z.max[0] - z.min[0]) / 2 - 0.6, rz: (z.max[2] - z.min[2]) / 2 - 0.6, y: z.min[1] });
      return;
    }
    // roam
    const pts = roamPoints(room.map);
    const g = this.goal;
    let reached = false;
    if (g && g.key) { const p = goalPos(room.map, g.key); reached = Math.hypot(p[0] - st.x, p[2] - st.z) < 3; }
    if (!g || !g.key || reached || tick >= this.goalUntil) {
      let k = Math.floor(Math.random() * pts.length);
      for (let t = 0; t < 4; t++) {
        const p = pts[k];
        if (Math.hypot(p[0] - st.x, p[2] - st.z) > 10) break;
        k = (k + 1) % pts.length;
      }
      this.setField(`roam:${k}`, null);
      this.goalUntil = tick + 60 * 25;
    }
  }

  decideCtf(tick) {
    const room = this.room, me = this.p, st = me.state, F = room.flags;
    const own = F[me.team], enemy = F[otherTeam(me.team)];
    const ownStand = room.map.flags[me.team];
    const dist = (f) => Math.hypot(f.x - st.x, f.z - st.z);
    const role = this.role();
    // 1. carrying: home (wait near the stand while our flag is away)
    if (me.carrying) { this.setField(`flag:${me.team}`, own.state === 'home' ? null : { x: ownStand[0], z: ownStand[2], rx: 4, rz: 4, y: ownStand[1] }); return; }
    // 2. our flag is on the ground: return it if we are close or defending
    if (own.state === 'dropped' && (dist(own) < 30 || role === 'defend' || this.closestTeamBotTo(own))) { this.setPos(own.x, own.y, own.z, null); return; }
    // 3. our flag is being carried: chase the carrier if seen / near, else cut him off at his stand
    if (own.state === 'carried') {
      const c = room.byId.get(own.carrier);
      if (c && (this.target === c || Math.hypot(c.state.x - st.x, c.state.z - st.z) < 15) && role === 'attack') { this.setPos(c.state.x, c.state.y, c.state.z, null); return; }
      if (role === 'defend' || !enemy || enemy.state !== 'home') { this.setField(`flag:${otherTeam(me.team)}`, null); return; }
    }
    if (role === 'defend') { this.setField(`flag:${me.team}`, { x: ownStand[0], z: ownStand[2], rx: 6, rz: 6, y: ownStand[1] }); return; }
    // 4. attack: the enemy flag (home or dropped); escort a friendly carrier
    if (enemy.state === 'home') { this.setField(`flag:${enemy.team}`, null); return; }
    if (enemy.state === 'dropped') { this.setPos(enemy.x, enemy.y, enemy.z, null); return; }
    this.setField(`flag:${me.team}`, { x: ownStand[0], z: ownStand[2], rx: 7, rz: 7, y: ownStand[1] });   // escort home
  }

  /** True if this bot is the closest bot of its team to flag f. */
  closestTeamBotTo(f) {
    let best = null, bd = Infinity;
    for (const q of this.room.players) {
      if (!q.bot || !q.alive || q.team !== this.p.team) continue;
      const d = Math.hypot(q.state.x - f.x, q.state.z - f.z);
      if (d < bd) { bd = d; best = q; }
    }
    return best === this.p;
  }

  // ------------------------------------------------------------------ steering

  /** Sets this.mx/mz (unit world direction, 0 = stand) and this.jump from the current goal. */
  steer(tick) {
    const st = this.p.state, nav = this.nav, room = this.room;
    this.mx = 0; this.mz = 0; this.jump = false;
    const g = this.goal;
    if (!g) return;
    let gx, gy, gz;
    if (g.key) { const p = goalPos(room.map, g.key); gx = p[0]; gy = p[1]; gz = p[2]; } else { gx = g.pos[0]; gy = g.pos[1]; gz = g.pos[2]; }
    const dGoal = Math.hypot(gx - st.x, gz - st.z);
    // progress bookkeeping (stuck -> re-plan)
    if (dGoal < this.bestDist - 0.5) { this.bestDist = dGoal; this.lastProgress = tick; }
    // at the goal: hold (wander inside the area) or stand
    const h = this.hold;
    if (h && Math.abs(st.x - h.x) < h.rx + 0.5 && Math.abs(st.z - h.z) < h.rz + 0.5 && Math.abs(st.y - h.y) < 2) {
      if (!this.holdPt || tick >= this.holdUntil || Math.hypot(this.holdPt[0] - st.x, this.holdPt[1] - st.z) < 0.7) {
        this.holdPt = [h.x + rnd(-h.rx, h.rx), h.z + rnd(-h.rz, h.rz)];
        this.holdUntil = tick + Math.round(rnd(40, 110));
      }
      this.toward(this.holdPt[0], this.holdPt[1]);
      this.bestDist = 0; this.lastProgress = tick;
      return;
    }
    if (!h && dGoal < 0.8 && Math.abs(gy - st.y) < 1.5) { this.lastProgress = tick; return; }
    const n = nav.nodeAt(st.x, st.y, st.z);
    if (g.key) {
      const f = nav.field(g.key, [gx, gy, gz]);
      if (n < 0 || f.next[n] < 0) { this.toward(gx, gz); this.jumpIf(gy); return; }
      this.followField(n, f);
      return;
    }
    // positional goal: A* (budgeted per room), straight line until a path exists
    if (g.wantPath && n >= 0 && (room.pathTick !== tick || room.pathsThisTick < PATH_BUDGET_PER_TICK)) {
      if (room.pathTick !== tick) { room.pathTick = tick; room.pathsThisTick = 0; }
      room.pathsThisTick++;
      g.wantPath = false;
      const b = nav.nodeAt(gx, gy + 0.3, gz, 3);
      g.path = b >= 0 ? nav.path(n, b, 8000) : null;
      g.i = 0;
    }
    if (g.path) {
      const P = g.path, X = nav.x, Y = nav.y, Z = nav.z;
      while (g.i < P.length - 1 && Math.hypot(X[P[g.i]] - st.x, Z[P[g.i]] - st.z) < 0.6 && Math.abs(Y[P[g.i]] - st.y) < 0.8) g.i++;
      // if we left the path, find the closest remaining node ahead (cheap: scan a few)
      let k = g.i;
      const y0 = Y[P[k]];
      for (let s = 1; s <= 3 && k + 1 < P.length; s++) { if (Math.abs(Y[P[k + 1]] - y0) > 0.05) break; k++; }
      this.toward(X[P[k]], Z[P[k]]);
      const nxt = P[g.i];
      if (Y[nxt] - st.y > STEP - 0.02 && Math.hypot(X[nxt] - st.x, Z[nxt] - st.z) < 1.4) this.jump = true;
      return;
    }
    this.toward(gx, gz); this.jumpIf(gy);
  }

  followField(n, f) {
    const nav = this.nav, X = nav.x, Y = nav.y, Z = nav.z, st = this.p.state;
    const first = f.next[n];
    let m = first;
    for (let s = 0; s < 3; s++) {
      const q = f.next[m];
      if (q < 0 || Math.abs(Y[q] - Y[n]) > 0.05 || Math.abs(Y[m] - Y[n]) > 0.05) break;
      m = q;
    }
    this.toward(X[m], Z[m]);
    if (Y[first] - st.y > STEP - 0.02 && Math.hypot(X[first] - st.x, Z[first] - st.z) < 1.4) this.jump = true;
  }

  jumpIf(gy) { if (gy - this.p.state.y > STEP + 0.1) this.jump = Math.random() < 0.1; }

  toward(x, z) {
    const st = this.p.state;
    const dx = x - st.x, dz = z - st.z, d = Math.hypot(dx, dz);
    if (d < 1e-3) { this.mx = 0; this.mz = 0; return; }
    this.mx = dx / d; this.mz = dz / d;
  }

  // ------------------------------------------------------------------ per tick

  think(tick) {
    const p = this.p;
    const cmd = this.cmd;
    cmd.seq = this.seq++;
    cmd.weapon = this.weapon;
    if (!p.alive) {
      cmd.buttons = 0; cmd.yaw = this.yaw; cmd.pitch = this.pitch;
      this.room.pushBotCmd(p, cmd);
      return;
    }
    const st = p.state;
    if ((tick + p.id) % SCAN_EVERY === 0) this.scan(tick);
    if (this.target && !this.isEnemy(this.target)) this.target = null;
    if (!this.goal || (tick + p.id * 7) % DECIDE_EVERY === 0) this.decide(tick);

    // stuck: no progress towards the goal for a while -> sidestep + jump, then re-plan
    const speed = Math.hypot(st.vx, st.vz);
    if (tick - this.lastProgress > 150) {
      this.lastProgress = tick; this.bestDist = Infinity;
      this.unstickUntil = tick + 30; this.unstickDir = Math.random() < 0.5 ? -1 : 1;
      if (this.goal && this.goal.pos) this.goal.wantPath = true;
      else if (this.goal && this.goal.key && this.goal.key.startsWith('roam')) this.goal = null;
    }
    this.steer(tick);
    let mx = this.mx, mz = this.mz;
    if (tick < this.unstickUntil) { const t = mx; mx = -mz * this.unstickDir + mx * 0.3; mz = t * this.unstickDir + mz * 0.3; if (st.onGround) this.jump = true; }

    let buttons = 0;
    const t = this.target;
    const moveYaw = Math.atan2(-mx, -mz);
    let fighting = false;
    if (t) {
      fighting = true;
      const ex = st.x, ey = st.y + eyeHeight(st), ez = st.z;
      const tx = t.state.x - ex, ty = t.state.y + hitboxHeight(t.state) * 0.72 - ey, tz = t.state.z - ez;
      const hd = Math.hypot(tx, tz);
      const L = levelOf(this.room);
      const wantYaw = Math.atan2(-tx, -tz) + this.errYaw + Math.sin(tick * 0.11 + p.id) * L.sway;
      const wantPitch = Math.atan2(ty, hd) + this.errPitch + Math.sin(tick * 0.07 + p.id * 3) * L.sway * 0.5;
      this.errYaw *= L.decay; this.errPitch *= L.decay;
      this.yaw = approach(this.yaw, wantYaw, L.turn);
      this.pitch += Math.max(-L.turn, Math.min(L.turn, wantPitch - this.pitch));
      const aimed = Math.abs(wrapAngle(wantYaw - this.yaw)) < 0.08;
      const slot = p.wstate.weapon;
      const w = p.kit.slots[slot];
      // shotguns only fire inside a useful distance; snipers wait until fully aimed
      const reach = slot === 2 ? Math.min(w.range, displayStats(w.gun, w.mask).raw.effectiveRange * 2.2) : w.range;
      const wantAds = slot === 1 || (slot === 0 && hd > 15);
      if (wantAds && !p.carrying) buttons |= BTN.ADS;
      const ready = slot !== 1 || p.wstate.aim >= w.adsTicks;
      if (tick >= this.reactAt && aimed && hd < reach && ready) {
        if (w.auto) { if (L.burst >= 1 || ((tick + p.id * 13) % 48) < 48 * L.burst) buttons |= BTN.FIRE; }
        else { this.firePulse = !this.firePulse; if (this.firePulse) buttons |= BTN.FIRE; }
      }
      if (tick >= this.strafeUntil) { this.strafe = -this.strafe; this.strafeUntil = tick + Math.round(rnd(25, 70)); }
      if (mx === 0 && mz === 0) {
        // nowhere to go (holding): classic duel movement
        buttons |= this.strafe > 0 ? BTN.LEFT : BTN.RIGHT;
        if (hd > 18) buttons |= BTN.FORWARD; else if (hd < 6) buttons |= BTN.BACK;
      }
    } else {
      if (mx !== 0 || mz !== 0) this.yaw = approach(this.yaw, moveYaw, TURN_IDLE);
      this.pitch *= 0.9;
    }
    if (mx !== 0 || mz !== 0) {
      // move along the route relative to where we look (aiming does not stop movement)
      const a = wrapAngle(moveYaw - this.yaw);
      let c = Math.cos(a), s = Math.sin(a);
      if (fighting && !p.carrying) { s += this.strafe * 0.45; }          // weave a little while fighting
      if (c > 0.38) buttons |= BTN.FORWARD; else if (c < -0.38) buttons |= BTN.BACK;
      if (s > 0.38) buttons |= BTN.LEFT; else if (s < -0.38) buttons |= BTN.RIGHT;
    }
    if (this.jump && st.onGround) buttons |= BTN.JUMP;

    // movement flair on open ground: occasional slide-hops (not while climbing)
    if (!fighting && !this.jump && (mx !== 0 || mz !== 0)) {
      if (this.slideTicks > 0) {
        buttons |= BTN.CROUCH;
        if (--this.slideTicks === 0) buttons = (buttons & ~BTN.CROUCH) | BTN.JUMP;
      } else if (st.onGround && speed > 5.5 && Math.random() < 0.006) {
        this.slideTicks = 18;
        buttons |= BTN.CROUCH;
      }
    } else this.slideTicks = 0;

    if (this.pitch > 1.4) this.pitch = 1.4; else if (this.pitch < -1.4) this.pitch = -1.4;
    cmd.buttons = buttons;
    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    this.room.pushBotCmd(p, cmd);
  }
}
