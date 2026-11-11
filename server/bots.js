// Simple server-side bots. They never touch the simulation directly: each tick a bot builds a
// cmd exactly like a client would and pushes it through room.pushBotCmd (sanitise + jitter
// buffer), so they move with stepPlayer and shoot with stepWeapon + the lag-comp hitscan.

import { BTN } from '../shared/constants.js';
import { MAP } from '../shared/map.js';
import { encodeLoadout, displayStats } from '../shared/weapons.js';
import { eyeHeight, hitboxHeight, raycastWorld } from '../shared/physics.js';
import { createCmd } from '../shared/protocol.js';

const NAMES = ['Pixel', 'Bolt', 'Nova', 'Echo', 'Rook', 'Flux', 'Zephyr', 'Quill', 'Moss', 'Tango',
  'Vex', 'Juno', 'Kit', 'Orbit', 'Sable', 'Dot', 'Wren', 'Cobalt', 'Fig', 'Lumen'];
const SCAN_EVERY = 6;          // ticks between visibility scans (staggered by id)
const VIEW_RANGE = 70;
const TURN_IDLE = 0.12;        // rad per tick
const TURN_COMBAT = 0.3;
const TWO_PI = Math.PI * 2;

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

  constructor(room, player) {
    this.room = room;
    this.p = player;
    this.cmd = createCmd();
    this.seq = 1;
    this.yaw = 0;
    this.pitch = 0;
    this.wx = 0; this.wz = 0;
    this.target = null;
    this.lostTicks = 0;
    this.reactAt = 0;
    this.errYaw = 0; this.errPitch = 0;
    this.strafe = 1; this.strafeUntil = 0;
    this.stuck = 0;
    this.slideTicks = 0;
    this.weapon = 0;
    this.skill = rnd(0.6, 1.0);
    this.firePulse = false;
  }

  /** Called by the room right before a respawn applies the pending loadout. */
  beforeSpawn() {
    if (Math.random() < 0.3) this.room.setLoadout(this.p, Bot.pickLoadout());
  }

  onSpawn(sp) {
    this.yaw = sp.yaw || 0;
    this.pitch = 0;
    this.target = null;
    this.stuck = 0;
    const r = Math.random();
    this.weapon = r < 0.55 ? 0 : r < 0.8 ? 1 : 2;
    this.pickWaypoint();
  }

  onDamaged(attacker) {
    if (!this.target && attacker && attacker !== this.p && attacker.alive) {
      this.acquire(attacker, this.room.tick);
    }
  }

  pickWaypoint() {
    const spawns = MAP.spawns;
    const st = this.p.state;
    for (let tries = 0; tries < 6; tries++) {
      const s = spawns[Math.floor(Math.random() * spawns.length)];
      const dx = s.pos[0] - st.x, dz = s.pos[2] - st.z;
      if (dx * dx + dz * dz > 25 || tries === 5) { this.wx = s.pos[0]; this.wz = s.pos[2]; return; }
    }
  }

  acquire(q, tick) {
    if (this.target === q) { this.lostTicks = 0; return; }
    this.target = q;
    this.lostTicks = 0;
    this.reactAt = tick + Math.round(rnd(15, 27) / this.skill);   // 250-450 ms (slower for weaker bots)
    const e = rnd(0.05, 0.12) / this.skill;
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
    if (d > VIEW_RANGE || d < 1e-3) return d < 1e-3;
    dx /= d; dy /= d; dz /= d;
    return raycastWorld(this.room.world, ex, ey, ez, dx, dy, dz, d, undefined) >= d - 0.3;
  }

  scan(tick) {
    const me = this.p;
    let best = null, bestD = Infinity;
    for (const q of this.room.players) {
      if (q === me || !q.alive) continue;
      const dx = q.state.x - me.state.x, dz = q.state.z - me.state.z;
      const d = dx * dx + dz * dz;
      if (d >= bestD || d > VIEW_RANGE * VIEW_RANGE) continue;
      // rough field of view (about 200 degrees) unless very close
      const ang = Math.abs(wrapAngle(Math.atan2(-dx, -dz) - this.yaw));
      if (ang > 1.75 && d > 36) continue;
      if (!this.canSee(q)) continue;
      best = q; bestD = d;
    }
    if (best) this.acquire(best, tick);
    else if (this.target) {
      if (!this.target.alive || this.room.byId.get(this.target.id) !== this.target || !this.canSee(this.target)) {
        this.lostTicks += SCAN_EVERY;
        if (this.lostTicks > 40 || !this.target.alive) this.target = null;
      }
    }
  }

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
    if (this.target && (!this.target.alive || this.target.removed)) this.target = null;

    // waypoint navigation
    let dx = this.wx - st.x, dz = this.wz - st.z;
    if (dx * dx + dz * dz < 6.25) { this.pickWaypoint(); dx = this.wx - st.x; dz = this.wz - st.z; }
    const moveYaw = Math.atan2(-dx, -dz);
    let buttons = 0;

    const t = this.target;
    if (t) {
      const ex = st.x, ey = st.y + eyeHeight(st), ez = st.z;
      const tx = t.state.x - ex, ty = t.state.y + hitboxHeight(t.state) * 0.72 - ey, tz = t.state.z - ez;
      const hd = Math.hypot(tx, tz);
      const wantYaw = Math.atan2(-tx, -tz) + this.errYaw + Math.sin(tick * 0.11 + p.id) * 0.012;
      const wantPitch = Math.atan2(ty, hd) + this.errPitch;
      this.errYaw *= 0.97; this.errPitch *= 0.97;
      this.yaw = approach(this.yaw, wantYaw, TURN_COMBAT);
      this.pitch += Math.max(-TURN_COMBAT, Math.min(TURN_COMBAT, wantPitch - this.pitch));
      const aimed = Math.abs(wrapAngle(wantYaw - this.yaw)) < 0.08;
      const slot = p.wstate.weapon;
      const w = p.kit.slots[slot];
      // shotguns only fire inside a useful distance; snipers wait until fully aimed
      const reach = slot === 2 ? Math.min(w.range, displayStats(w.gun, w.mask).raw.effectiveRange * 2.2) : w.range;
      const wantAds = slot === 1 || (slot === 0 && hd > 15);
      if (wantAds) buttons |= BTN.ADS;
      const ready = slot !== 1 || p.wstate.aim >= w.adsTicks;
      if (tick >= this.reactAt && aimed && hd < reach && ready) {
        if (w.auto) buttons |= BTN.FIRE;
        else { this.firePulse = !this.firePulse; if (this.firePulse) buttons |= BTN.FIRE; }
      }
      if (tick >= this.strafeUntil) { this.strafe = -this.strafe; this.strafeUntil = tick + Math.round(rnd(25, 70)); }
      buttons |= this.strafe > 0 ? BTN.LEFT : BTN.RIGHT;
      if (hd > 18) buttons |= BTN.FORWARD; else if (hd < 6) buttons |= BTN.BACK;
    } else {
      this.yaw = approach(this.yaw, moveYaw, TURN_IDLE);
      this.pitch *= 0.9;
      const a = wrapAngle(moveYaw - this.yaw);
      const c = Math.cos(a), s = Math.sin(a);
      if (c > 0.38) buttons |= BTN.FORWARD; else if (c < -0.38) buttons |= BTN.BACK;
      if (s > 0.38) buttons |= BTN.LEFT; else if (s < -0.38) buttons |= BTN.RIGHT;

      // movement flair: random hops and slide-hops
      const speed = Math.hypot(st.vx, st.vz);
      if (this.slideTicks > 0) {
        buttons |= BTN.CROUCH;
        if (--this.slideTicks === 0) buttons = (buttons & ~BTN.CROUCH) | BTN.JUMP;
      } else if (st.onGround && speed > 5.5 && Math.random() < 0.01) {
        this.slideTicks = 18;
        buttons |= BTN.CROUCH;
      } else if (st.onGround && Math.random() < 0.008) {
        buttons |= BTN.JUMP;
      }
    }

    // unstick
    const speed = Math.hypot(st.vx, st.vz);
    if ((buttons & (BTN.FORWARD | BTN.BACK | BTN.LEFT | BTN.RIGHT)) && speed < 1) {
      this.stuck++;
      if (this.stuck > 30 && st.onGround) buttons |= BTN.JUMP;
      if (this.stuck > 150) { this.pickWaypoint(); this.stuck = 0; }
    } else this.stuck = 0;

    if (this.pitch > 1.4) this.pitch = 1.4; else if (this.pitch < -1.4) this.pitch = -1.4;
    cmd.buttons = buttons;
    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    this.room.pushBotCmd(p, cmd);
  }
}

