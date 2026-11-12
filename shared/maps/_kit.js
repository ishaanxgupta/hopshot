// Small helpers shared by the map files (not a map itself). Pure, deterministic, box-only.
// Mirror modes for team maps: 'x' (x -> -x), 'z' (z -> -z), 'xz' (180 degree rotation).

export function yawToward(x, z, tx, tz) {
  // yaw 0 looks down -Z, positive yaw turns left: forward = (-sin yaw, -cos yaw).
  return Math.atan2(-(tx - x), -(tz - z));
}

function mp(p, mode) {
  const mx = mode === 'x' || mode === 'xz', mz = mode === 'z' || mode === 'xz';
  return [mx ? -p[0] : p[0], p[1], mz ? -p[2] : p[2]];
}

export function mirrorPos(p, mode) { return mp(p, mode); }

export function mirrorYaw(yaw, mode) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const mx = mode === 'x' || mode === 'xz', mz = mode === 'z' || mode === 'xz';
  return Math.atan2(-(mx ? -fx : fx), -(mz ? -fz : fz));
}

export function mirrorSpawn(s, mode) { return { pos: mp(s.pos, mode), yaw: mirrorYaw(s.yaw, mode) }; }

export function mirrorBox(b, mode) {
  const a = mp(b.min, mode), c = mp(b.max, mode);
  return {
    min: [Math.min(a[0], c[0]), b.min[1], Math.min(a[2], c[2])],
    max: [Math.max(a[0], c[0]), b.max[1], Math.max(a[2], c[2])],
    color: b.color,
  };
}

// A builder with an optional mirror mode. kit.box() adds one box; kit.pair() adds the box and its
// mirror image (optionally in another colour, e.g. the other team's accent).
export function createKit(mirror = null) {
  const boxes = [];
  const kit = {
    boxes,
    box(x0, y0, z0, x1, y1, z1, color) {
      boxes.push({ min: [x0, y0, z0], max: [x1, y1, z1], color });
      return kit;
    },
    pair(x0, y0, z0, x1, y1, z1, color, colorB = color) {
      const b = { min: [x0, y0, z0], max: [x1, y1, z1], color };
      boxes.push(b);
      const m = mirrorBox(b, mirror);
      m.color = colorB;
      // a box that maps onto itself is only added once
      if (m.min.some((v, i) => Math.abs(v - b.min[i]) > 1e-9) || m.max.some((v, i) => Math.abs(v - b.max[i]) > 1e-9)) boxes.push(m);
      return kit;
    },
    // Add the box and its x-, z- and 180-degree images (deduplicated). colorB tints the images that
    // land on the other team's side of the kit's mirror axis.
    quad(x0, y0, z0, x1, y1, z1, color, colorB = color) {
      const b0 = { min: [x0, y0, z0], max: [x1, y1, z1], color };
      const seen = new Set();
      for (const mode of ['', 'x', 'z', 'xz']) {
        const m = mode === '' ? { min: b0.min.slice(), max: b0.max.slice() } : mirrorBox(b0, mode);
        const key = [...m.min, ...m.max].map((v) => Math.round(v * 1000)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const flipped = mirror === 'x' ? mode.includes('x') : mirror === 'z' ? mode.includes('z') : mode === 'xz';
        boxes.push({ min: m.min, max: m.max, color: flipped ? colorB : color });
      }
      return kit;
    },
    // (floor === null: the caller builds its own floor) Floor plus a closed 4-wall perimeter around the playable rectangle [x0,x1] x [z0,z1].
    arena(x0, x1, z0, z1, wallH, floor, wall) {
      if (floor !== null) kit.box(x0 - 1, -1, z0 - 1, x1 + 1, 0, z1 + 1, floor);
      kit.box(x0 - 1, 0, z0 - 1, x1 + 1, wallH, z0, wall);
      kit.box(x0 - 1, 0, z1, x1 + 1, wallH, z1 + 1, wall);
      kit.box(x0 - 1, 0, z0, x0, wallH, z1, wall);
      kit.box(x1, 0, z0, x1 + 1, wallH, z1, wall);
      return { min: [x0 - 1, -1, z0 - 1], max: [x1 + 1, 40, z1 + 1] };
    },
  };

  // ================================================================================================
  // Scene builders (phase 2b maps). Everything is axis-aligned. `boxes` collide, `deco` is drawn only.
  //   kit.sym(fn, swap)  run fn, then add the mirror image of everything it emitted (boxes and deco);
  //                      swap = { fromColor: toColor } re-tints the mirrored copy (team accents).
  //   kit.frame(x, z, rot, y) a local frame (rot 0/90/180/270 degrees, base height y):
  //                      f.b(lx0,ly0,lz0,lx1,ly1,lz1,color) solid, f.d(...) deco, in local metres.
  // ================================================================================================
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const put = (arr, x0, y0, z0, x1, y1, z1, color) => {
    const a = [r4(Math.min(x0, x1)), r4(Math.min(y0, y1)), r4(Math.min(z0, z1))], c = [r4(Math.max(x0, x1)), r4(Math.max(y0, y1)), r4(Math.max(z0, z1))];
    if (c[0] - a[0] < 1e-3 || c[1] - a[1] < 1e-3 || c[2] - a[2] < 1e-3) return;
    arr.push({ min: a, max: c, color });
  };
  const gkey = (b) => [...b.min, ...b.max].map((v) => Math.round(v * 100)).join(',');
  kit.deco = [];
  kit.bandC = null;   // set to a colour to draw horizontal plank / log bands on solid wall pieces
  const deco = kit.deco;
  kit.solid = (x0, y0, z0, x1, y1, z1, color) => { put(boxes, x0, y0, z0, x1, y1, z1, color); return kit; };
  kit.paint = (x0, y0, z0, x1, y1, z1, color) => { put(deco, x0, y0, z0, x1, y1, z1, color); return kit; };
  kit.sym = (fn, swap) => {
    const b0 = boxes.length, d0 = deco.length;
    fn();
    for (const [arr, s0] of [[boxes, b0], [deco, d0]]) {
      const orig = arr.slice(s0), keys = new Set(orig.map(gkey));
      for (const b of orig) {
        const m = mirrorBox(b, mirror);
        if (swap && swap[b.color] !== undefined) m.color = swap[b.color];
        m.min = m.min.map(r4); m.max = m.max.map(r4);
        if (keys.has(gkey(m))) continue;
        arr.push(m);
      }
    }
    return kit;
  };
  kit.frame = (x, z, rot = 0, y = 0) => {
    const T = (lx, lz) => (rot === 0 ? [x + lx, z + lz] : rot === 90 ? [x - lz, z + lx] : rot === 180 ? [x - lx, z - lz] : [x + lz, z - lx]);
    const mk = (arr) => (lx0, ly0, lz0, lx1, ly1, lz1, color) => {
      const a = T(lx0, lz0), c = T(lx1, lz1);
      put(arr, a[0], y + ly0, a[1], c[0], y + ly1, c[1], color);
    };
    return { x, z, rot, y, T, b: mk(boxes), d: mk(deco) };
  };

  // Wall along local axis 'x' (z = p) or 'z' (x = p) from c0 to c1, thickness th, heights y0..y1.
  // ops: [{ a, b, sill, head }] openings (sill/head are heights; a door has sill = y0). trim = deco frame colour.
  kit.wallRun = (f, axis, c0, c1, p, th, y0, y1, color, ops = [], trim = null) => {
    const E = (a0, h0, a1, h1) => {
      if (a1 - a0 > 1e-3 && h1 - h0 > 1e-3) {
        if (axis === 'x') f.b(a0, h0, p - th / 2, a1, h1, p + th / 2, color); else f.b(p - th / 2, h0, a0, p + th / 2, h1, a1, color);
        if (kit.bandC !== null && h1 - h0 > 0.8) for (let yy = h0 + 0.45; yy < h1 - 0.1; yy += 0.5) D(a0, yy - 0.04, a1, yy + 0.04, kit.bandC, 0.04);
      }
    };
    const D = (a0, h0, a1, h1, col, grow = 0.05) => { if (axis === 'x') f.d(a0, h0, p - th / 2 - grow, a1, h1, p + th / 2 + grow, col); else f.d(p - th / 2 - grow, h0, a0, p + th / 2 + grow, h1, a1, col); };
    const sorted = ops.slice().sort((a, b) => a.a - b.a);
    let cur = c0;
    for (const o of sorted) {
      const sill = o.sill === undefined ? y0 : o.sill, head = o.head === undefined ? y1 : o.head;
      E(cur, y0, o.a, y1);
      E(o.a, y0, o.b, sill);
      E(o.a, head, o.b, y1);
      if (trim) {
        D(o.a - 0.08, sill, o.a, head, trim); D(o.b, sill, o.b + 0.08, head, trim);
        if (head < y1 - 0.01) D(o.a - 0.08, head, o.b + 0.08, head + 0.1, trim);
        if (sill > y0 + 0.01) D(o.a - 0.08, sill - 0.08, o.b + 0.08, sill, trim, 0.1);
      }
      cur = o.b;
    }
    E(cur, y0, c1, y1);
  };

  // A horizontal slab [x0,x1]x[z0,z1] at heights y0..y1 with an optional rectangular hole.
  kit.slab = (f, x0, z0, x1, z1, y0, y1, color, hole = null) => {
    if (!hole) { f.b(x0, y0, z0, x1, y1, z1, color); return; }
    const h = { x0: Math.max(x0, hole.x0), z0: Math.max(z0, hole.z0), x1: Math.min(x1, hole.x1), z1: Math.min(z1, hole.z1) };
    if (h.x0 >= h.x1 - 1e-6 || h.z0 >= h.z1 - 1e-6) { f.b(x0, y0, z0, x1, y1, z1, color); return; }
    f.b(x0, y0, z0, x1, y1, h.z0, color);
    f.b(x0, y0, h.z1, x1, y1, z1, color);
    f.b(x0, y0, h.z0, h.x0, y1, h.z1, color);
    f.b(h.x1, y0, h.z0, x1, y1, h.z1, color);
  };

  // Straight stairs in frame f. (lx, lz) is the low end (edge of the first step), dir = 'x+','x-','z+','z-'
  // is the climbing direction, width across. Steps are `tread` deep and at most 0.3 m high; the last step is
  // exactly `rise` high. Returns { n, run, hole } where hole is the rectangle (local) the stairs leave open
  // in a floor above (every step but the last).
  kit.stairs = (f, lx, lz, dir, width, rise, color, o = {}) => {
    const tread = o.tread || 0.4, n = Math.max(1, Math.ceil(rise / (o.maxStep || 0.3) - 1e-6)), sh = rise / n, bot = o.bottom === undefined ? 0 : o.bottom;
    const sx = dir[0] === 'x' ? (dir[1] === '+' ? 1 : -1) : 0, sz = dir[0] === 'z' ? (dir[1] === '+' ? 1 : -1) : 0;
    for (let i = 0; i < n; i++) {
      const a = i * tread, c = (i + 1) * tread;
      if (sx) f.b(sx > 0 ? lx + a : lx - c, bot, lz - width / 2, sx > 0 ? lx + c : lx - a, (i + 1) * sh, lz + width / 2, color);
      else f.b(lx - width / 2, bot, sz > 0 ? lz + a : lz - c, lx + width / 2, (i + 1) * sh, sz > 0 ? lz + c : lz - a, color);
    }
    const run = n * tread, hr = (n - 1) * tread;
    const hole = sx ? { x0: sx > 0 ? lx : lx - hr, x1: sx > 0 ? lx + hr : lx, z0: lz - width / 2, z1: lz + width / 2 }
      : { x0: lx - width / 2, x1: lx + width / 2, z0: sz > 0 ? lz : lz - hr, z1: sz > 0 ? lz + hr : lz };
    return { n, run, hole };
  };

  kit.crate = (x, z, s, h, color, strap = 0x00000022, y = 0) => {
    kit.solid(x - s / 2, y, z - s / 2, x + s / 2, y + h, z + s / 2, color);
    const dark = shade(color, 0.72);
    kit.paint(x - s / 2 - 0.03, y + h * 0.42, z - s / 2 - 0.03, x + s / 2 + 0.03, y + h * 0.58, z + s / 2 + 0.03, dark);
    kit.paint(x - 0.07, y + h - 0.0, z - s / 2 - 0.03, x + 0.07, y + h + 0.02, z + s / 2 + 0.03, dark);
    return kit;
  };

  // Shipping container, long axis local z (rot 0 = along z). len x w x h. ends: 'both' open (run through),
  // 'a' (open at -z only), 'b' (open at +z only), 'none' closed (solid block, climb on top).
  kit.container = (x, z, rot, o = {}) => {
    const len = o.len || 6, w = o.w || 2.4, h = o.h || 2.6, y = o.y || 0, color = o.color || 0xc0562a, ends = o.ends || 'both', t = 0.14;
    const f = kit.frame(x, z, rot, y), hl = len / 2, hw = w / 2, dark = shade(color, 0.7), light = shade(color, 1.18);
    if (o.solid || ends === 'none') f.b(-hw, 0, -hl, hw, h, hl, color);
    else {
      f.b(-hw, h - t, -hl, hw, h, hl, color);                      // roof
      f.b(-hw, 0, -hl, -hw + t, h - t, hl, color);                 // side walls
      f.b(hw - t, 0, -hl, hw, h - t, hl, color);
      if (ends === 'a') f.b(-hw + t, 0, hl - t, hw - t, h - t, hl, color);
      if (ends === 'b') f.b(-hw + t, 0, -hl, hw - t, h - t, -hl + t, color);
      f.d(-hw + t, 0, -hl, hw - t, 0.04, hl, dark);                 // floor planks
    }
    // corrugation ribs and bands on both long faces, door gear on both ends
    for (let i = 0; i < 6; i++) {
      const zz = -hl + 0.5 + i * ((len - 1) / 5);
      f.d(-hw - 0.04, 0.2, zz - 0.06, -hw, h - 0.25, zz + 0.06, dark);
      f.d(hw, 0.2, zz - 0.06, hw + 0.04, h - 0.25, zz + 0.06, dark);
    }
    f.d(-hw - 0.05, h - 0.2, -hl, hw + 0.05, h, hl, light);
    f.d(-hw - 0.05, 0, -hl, hw + 0.05, 0.18, hl, dark);
    for (const e of [-1, 1]) {
      const zz = e * hl;
      const closed = o.solid || ends === 'none' || (ends === 'a' && e > 0) || (ends === 'b' && e < 0);
      if (closed) {
        f.d(-hw + 0.1, 0.15, zz - (e > 0 ? 0 : 0.04) + (e > 0 ? 0 : 0), hw - 0.1, h - 0.15, zz + (e > 0 ? 0.04 : 0), shade(color, 0.9));
        f.d(-0.04, 0.2, zz + (e > 0 ? 0 : -0.07), 0.04, h - 0.2, zz + (e > 0 ? 0.07 : 0), dark);
        f.d(-0.5, 1.0, zz + (e > 0 ? 0 : -0.1), 0.5, 1.1, zz + (e > 0 ? 0.1 : 0), 0x2a2a2a);
      }
    }
    if (o.stripe) f.d(-hw - 0.06, h * 0.45, -hl * 0.6, -hw, h * 0.7, hl * 0.6, o.stripe), f.d(hw, h * 0.45, -hl * 0.6, hw + 0.06, h * 0.7, hl * 0.6, o.stripe);
    return kit;
  };

  // Pine / leafy tree: solid trunk, deco canopy tiers.
  kit.tree = (x, z, o = {}) => {
    const h = o.h || 7, t = o.t || 0.5, trunk = o.trunk || 0x6b4a2f, leaf = o.leaf || 0x2f6b3a, kind = o.kind || 'pine';
    kit.solid(x - t / 2, 0, z - t / 2, x + t / 2, h, z + t / 2, trunk);
    kit.paint(x - t / 2 - 0.05, 0, z - t / 2 - 0.05, x + t / 2 + 0.05, 0.5, z + t / 2 + 0.05, shade(trunk, 0.75));
    if (kind === 'pine') {
      const tiers = [[2.1, 0.30, 0.50], [1.7, 0.50, 0.68], [1.25, 0.68, 0.82], [0.8, 0.82, 0.94], [0.4, 0.94, 1.06]];
      tiers.forEach(([r, a, b], i) => kit.paint(x - r, h * a, z - r, x + r, h * b, z + r, shade(leaf, 0.85 + i * 0.07)));
    } else {
      const r = o.r || 2.4;
      kit.paint(x - r, h - 1.2, z - r, x + r, h + 1.1, z + r, leaf);
      kit.paint(x - r * 0.65, h + 1.1, z - r * 0.65, x + r * 0.65, h + 1.9, z + r * 0.65, shade(leaf, 1.12));
      kit.paint(x - r - 0.5, h - 0.7, z - r * 0.5, x + r + 0.5, h + 0.4, z + r * 0.5, shade(leaf, 0.9));
    }
    return kit;
  };

  kit.rock = (x, z, w, d, h, color = 0x8a8f94) => {
    kit.solid(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, color);
    kit.paint(x - w / 2 + 0.2, h - 0.0, z - d / 2 + 0.2, x + w / 2 - 0.3, h + 0.2, z + d / 2 - 0.3, shade(color, 1.1));
    kit.paint(x - w / 2 - 0.05, 0, z - d / 2 + d * 0.3, x - w / 2, h * 0.5, z + d / 2 - d * 0.3, shade(color, 0.8));
    return kit;
  };

  // Car, long axis local x: body (0..0.95) and a cabin (to 1.5), wheels / glass / lights as deco.
  kit.car = (x, z, rot, o = {}) => {
    const color = o.color || 0xc23b3b, glass = 0x7fa6c4, y = o.y || 0, f = kit.frame(x, z, rot, y), L = o.len || 4.3, hl = L / 2, hw = 0.95;
    f.b(-hl, 0.2, -hw, hl, 0.95, hw, color);
    f.b(-hl * 0.42, 0.95, -hw + 0.12, hl * 0.35, 1.5, hw - 0.12, shade(color, 1.08));
    f.d(-hl * 0.42 - 0.02, 1.0, -hw + 0.1, hl * 0.35 + 0.02, 1.42, hw - 0.1, glass);
    f.d(-hl * 0.42 + 0.03, 1.46, -hw + 0.1, hl * 0.35 - 0.03, 1.53, hw - 0.1, shade(color, 0.85));
    for (const sx of [-0.62, 0.62]) for (const sz of [-1, 1]) f.d(sx * hl - 0.3, 0, sz * (hw - 0.08) - 0.1, sx * hl + 0.3, 0.45, sz * (hw - 0.08) + 0.1, 0x1e1e22);
    f.d(hl, 0.4, -hw + 0.1, hl + 0.04, 0.7, -hw + 0.4, 0xfff2b0); f.d(hl, 0.4, hw - 0.4, hl + 0.04, 0.7, hw - 0.1, 0xfff2b0);
    f.d(-hl - 0.04, 0.4, -hw + 0.1, -hl, 0.65, -hw + 0.4, 0xd02020); f.d(-hl - 0.04, 0.4, hw - 0.4, -hl, 0.65, hw - 0.1, 0xd02020);
    f.d(-hl, 0.95, -hw + 0.0, hl, 1.0, hw, shade(color, 0.8));
    return kit;
  };

  // Bus / tram body, long axis local z. Door gaps (width 1.6) on both long sides at the given z offsets,
  // closed ends, seats inside, roof walkable (climb with a crate). rot 0 = along z.
  kit.bus = (x, z, rot, o = {}) => {
    const len = o.len || 10, w = 2.6, h = o.h || 2.7, color = o.color || 0xe0a526, y = o.y || 0, f = kit.frame(x, z, rot, y), hl = len / 2, hw = w / 2, t = 0.16;
    const doors = o.doors || [-2.4, 2.4], dw = 1.6;
    const ops = doors.map((c) => ({ a: c - dw / 2, b: c + dw / 2 }));
    const wins = o.windows === false ? [] : (o.windows || [-3.9, -0.9, 0.9, 3.9]).filter((c) => !doors.some((d) => Math.abs(d - c) < 1.4)).map((c) => ({ a: c - 0.55, b: c + 0.55, sill: 1.1, head: 2.15 }));
    const sideOps = ops.concat(wins);
    kit.wallRun(f, 'z', -hl, hl, -hw + t / 2, t, 0.2, h - 0.2, color, sideOps, shade(color, 0.6));
    kit.wallRun(f, 'z', -hl, hl, hw - t / 2, t, 0.2, h - 0.2, color, sideOps, shade(color, 0.6));
    f.b(-hw, 0.2, -hl, hw, h - 0.2, -hl + t, color); f.b(-hw, 0.2, hl - t, hw, h - 0.2, hl, color);   // ends
    f.b(-hw, h - 0.2, -hl, hw, h, hl, shade(color, 1.12));                                              // roof
    f.b(-hw, 0, -hl, hw, 0.2, hl, shade(color, 0.6));                                                    // floor / skirt (0.2: a step)
    for (let i = 0; i < 4; i++) {                                                                        // seats
      const zz = (i - 1.5) * 1.5 - 0.4;
      if (doors.some((d) => Math.abs(d - zz) < 1.5)) continue;
      f.b(-hw + t, 0.2, zz - 0.3, -hw + t + 0.5, 0.75, zz + 0.3, 0x3c5a8a);
    }
    // glass strips (deco), wheels, lights, stripe, destination sign
    for (const s of [-1, 1]) {
      f.d(s * (hw + 0.01) - 0.01, 1.1, -hl + 0.3, s * (hw + 0.01) + 0.01, 2.15, hl - 0.3, 0x1c2a3a);
      f.d(s * (hw + 0.03) - 0.02, 0.55, -hl, s * (hw + 0.03) + 0.02, 0.9, hl, shade(color, 0.55));
    }
    for (const zz of [-hl + 1.8, hl - 1.8]) for (const s of [-1, 1]) f.d(s * (hw - 0.05) - 0.12, 0, zz - 0.5, s * (hw - 0.05) + 0.12, 0.7, zz + 0.5, 0x1b1b1f);
    f.d(-hw + 0.2, 1.3, -hl - 0.04, hw - 0.2, 2.2, -hl, 0x1c2a3a);
    f.d(-hw + 0.3, 2.3, -hl - 0.04, hw - 0.3, 2.55, -hl, 0xfff0c0);
    f.d(-hw + 0.2, 0.35, -hl - 0.05, -hw + 0.55, 0.6, -hl, 0xfff2b0); f.d(hw - 0.55, 0.35, -hl - 0.05, hw - 0.2, 0.6, -hl, 0xfff2b0);
    return kit;
  };

  // A walk-in building in a frame centred on (x, z). Local axes: n = -z side, s = +z side, w = -x, e = +x.
  //   w, d       outside size;  th wall thickness;  h1 / h2 interior heights of the ground / upper floor
  //   g, u       openings per side for the ground / upper floor: { n:[{a,b,sill,head}], s:[], w:[], e:[] }
  //              (a, b are local coordinates along that side; a door has no sill)
  //   floors     1 or 2;  upper = {x0,z0,x1,z1} region of the upper floor (default: everything)
  //   stairs     { x, z, dir, width }  low end of the stairs (auto hole in the upper floor)
  //   parts      interior partition walls [{ ax:'x'|'z', p, c0, c1, ops, level:0|1 }]
  //   balcony    { side:'n'|'s'|'w'|'e', a, b, depth }  slab + solid rail outside the upper floor
  //   roof       'flat' | 'gable' (deco ridge) | 'cabin' ;  chimney  { x, z }
  kit.building = (x, z, rot, s) => {
    const w = s.w, d = s.d, th = s.th || 0.3, h1 = s.h1 || 2.5, h2 = s.h2 || 2.5, slab = 0.2, y = s.y || 0;
    const f = kit.frame(x, z, rot, y), wall = s.wall || 0xd9c9a8, trim = s.trim === undefined ? 0xffffff : s.trim, floorC = s.floorC || 0x8d7a60, roofC = s.roofC || 0x8a3d34;
    const two = (s.floors || 1) === 2, Fy = h1 + slab, top = two ? Fy + h2 : h1, hw = w / 2, hd = d / 2;
    const G = s.g || {}, U = s.u || {};
    const sides = (ops, y0, y1, c) => {
      kit.wallRun(f, 'x', -hw, hw, -hd + th / 2, th, y0, y1, c, ops.n || [], trim);
      kit.wallRun(f, 'x', -hw, hw, hd - th / 2, th, y0, y1, c, ops.s || [], trim);
      kit.wallRun(f, 'z', -hd + th, hd - th, -hw + th / 2, th, y0, y1, c, ops.w || [], trim);
      kit.wallRun(f, 'z', -hd + th, hd - th, hw - th / 2, th, y0, y1, c, ops.e || [], trim);
    };
    sides(G, 0, h1, wall);
    // floor skirt / plinth stripe
    f.d(-hw - 0.04, 0, -hd - 0.04, hw + 0.04, 0.25, hd + 0.04, shade(wall, 0.7));
    f.d(-hw + th, 0, -hd + th, hw - th, 0.03, hd - th, floorC);
    let st = null;
    if (two) {
      if (s.stairs) {
        const sd = s.stairs;
        st = kit.stairs(f, sd.x, sd.z, sd.dir, sd.width || 1.4, Fy, s.stairC || shade(floorC, 0.8));
      }
      const u = s.upper || { x0: -hw, z0: -hd, x1: hw, z1: hd };
      kit.slab(f, u.x0, u.z0, u.x1, u.z1, h1, Fy, floorC, st ? st.hole : null);
      if (s.upper) {                       // a loft: low rail on the open edges, solid so it is cover too
        const r = s.rail || 1.0, rc = s.railC || shade(floorC, 0.7);
        for (const edge of s.railEdges || []) {
          if (edge === 'n') f.b(u.x0, Fy, u.z0 - 0.0, u.x1, Fy + r, u.z0 + 0.1, rc);
          if (edge === 's') f.b(u.x0, Fy, u.z1 - 0.1, u.x1, Fy + r, u.z1, rc);
          if (edge === 'w') f.b(u.x0, Fy, u.z0, u.x0 + 0.1, Fy + r, u.z1, rc);
          if (edge === 'e') f.b(u.x1 - 0.1, Fy, u.z0, u.x1, Fy + r, u.z1, rc);
        }
      }
      if (!s.upper) sides(U, Fy, top, s.wall2 || wall);
      else if (s.upperWalls) sides(U, h1, top, s.wall2 || wall);
    }
    for (const pt of s.parts || []) {
      const y0 = pt.level ? Fy : 0, y1 = pt.level ? top : h1;
      kit.wallRun(f, pt.ax, pt.c0, pt.c1, pt.p, pt.th || 0.2, y0, y1, pt.color || shade(wall, 1.05), pt.ops || [], pt.trim === undefined ? trim : pt.trim);
    }
    if (s.balcony) {
      // slab + a low solid kerb (0.25 m, steps over) with a see-through railing drawn on top, so bots and
      // players can hop off the edge without bumping into an invisible solid rail
      const b = s.balcony, dp = b.depth || 1.6, rc = shade(wall, 0.75), sd = b.side;
      const rect = sd === 'n' ? [b.a, -hd - dp, b.b, -hd] : sd === 's' ? [b.a, hd, b.b, hd + dp] : sd === 'w' ? [-hw - dp, b.a, -hw, b.b] : [hw, b.a, hw + dp, b.b];
      f.b(rect[0], h1, rect[1], rect[2], Fy, rect[3], floorC);
      const q = 0.1, r = 1.05;
      const edges = [];
      if (sd === 'n' || sd === 's') {
        const zo = sd === 'n' ? rect[1] : rect[3] - q;
        edges.push([rect[0], zo, rect[2], zo + q], [rect[0], rect[1], rect[0] + q, rect[3]], [rect[2] - q, rect[1], rect[2], rect[3]]);
      } else {
        const xo = sd === 'w' ? rect[0] : rect[2] - q;
        edges.push([xo, rect[1], xo + q, rect[3]], [rect[0], rect[1], rect[2], rect[1] + q], [rect[0], rect[3] - q, rect[2], rect[3]]);
      }
      for (const e of edges) {
        f.b(e[0], Fy, e[1], e[2], Fy + 0.25, e[3], rc);
        f.d(e[0], Fy + 0.25, e[1], e[2], Fy + 0.3, e[3], rc);
        f.d(e[0], Fy + r - 0.08, e[1], e[2], Fy + r, e[3], rc);
        const len = Math.max(e[2] - e[0], e[3] - e[1]);
        for (let k = 0; k <= Math.round(len / 0.7); k++) {
          const t = k / Math.max(1, Math.round(len / 0.7));
          const px = e[0] + (e[2] - e[0]) * t, pz = e[1] + (e[3] - e[1]) * t;
          f.d(px - 0.04, Fy + 0.3, pz - 0.04, px + 0.04, Fy + r - 0.08, pz + 0.04, rc);
        }
      }
      const post = (px, pz) => f.d(px - 0.1, 0, pz - 0.1, px + 0.1, h1, pz + 0.1, shade(wall, 0.9));
      post(rect[0] + 0.15, rect[1] + 0.15); post(rect[2] - 0.15, rect[1] + 0.15); post(rect[0] + 0.15, rect[3] - 0.15); post(rect[2] - 0.15, rect[3] - 0.15);
    }
    // painted-on windows (deco only, nothing to shoot through): s.fake = { n:[{a,b,sill,head}], s:[], w:[], e:[] } (heights absolute)
    if (s.fake) {
      const glass = s.glass || 0x7fa6c4;
      for (const side of ['n', 's', 'w', 'e']) for (const o of s.fake[side] || []) {
        const g0 = 0.05;
        const rect = (a0, h0, a1, h1, c) => {
          if (side === 'n') f.d(a0, h0, -hd - g0, a1, h1, -hd, c);
          else if (side === 's') f.d(a0, h0, hd, a1, h1, hd + g0, c);
          else if (side === 'w') f.d(-hw - g0, h0, a0, -hw, h1, a1, c);
          else f.d(hw, h0, a0, hw + g0, h1, a1, c);
        };
        rect(o.a, o.sill, o.b, o.head, glass);
        rect(o.a - 0.08, o.sill, o.a, o.head, trim); rect(o.b, o.sill, o.b + 0.08, o.head, trim);
        rect(o.a - 0.08, o.head, o.b + 0.08, o.head + 0.1, trim); rect(o.a - 0.08, o.sill - 0.08, o.b + 0.08, o.sill, trim);
        rect((o.a + o.b) / 2 - 0.03, o.sill, (o.a + o.b) / 2 + 0.03, o.head, trim);
      }
    }
    // roof slab with a small overhang, plus deco on top
    const ro = 0.25;
    f.b(-hw - ro, top, -hd - ro, hw + ro, top + 0.25, hd + ro, roofC);
    f.d(-hw - ro - 0.04, top - 0.12, -hd - ro - 0.04, hw + ro + 0.04, top, hd + ro + 0.04, shade(roofC, 0.75));
    if (s.roof === 'gable' || s.roof === 'cabin') {
      const base = top + 0.25, ax = w >= d;
      const steps = [[0.0, 0.0], [0.5, 0.45], [1.0, 0.8], [1.5, 1.05]];
      steps.forEach(([inset, hh], i) => {
        const hy0 = base + (i ? steps[i - 1][1] : 0), hy1 = base + hh;
        if (hy1 <= hy0) return;
        const cc = shade(roofC, 1 - i * 0.05);
        if (ax) f.d(-hw - ro + inset * 0.0, hy0, -hd - ro + (i + 1) * (d / 8), hw + ro, hy1, hd + ro - (i + 1) * (d / 8), cc);
        else f.d(-hw - ro + (i + 1) * (w / 8), hy0, -hd - ro, hw + ro - (i + 1) * (w / 8), hy1, hd + ro, cc);
      });
    } else {
      f.d(-hw - 0.1, top + 0.25, -hd - 0.1, hw + 0.1, top + 0.65, -hd + 0.05, shade(wall, 0.9));
      f.d(-hw - 0.1, top + 0.25, hd - 0.05, hw + 0.1, top + 0.65, hd + 0.1, shade(wall, 0.9));
      f.d(-hw - 0.1, top + 0.25, -hd, -hw + 0.05, top + 0.65, hd, shade(wall, 0.9));
      f.d(hw - 0.05, top + 0.25, -hd, hw + 0.1, top + 0.65, hd, shade(wall, 0.9));
    }
    if (s.chimney) f.d(s.chimney.x - 0.4, top, s.chimney.z - 0.4, s.chimney.x + 0.4, top + 1.9, s.chimney.z + 0.4, s.chimneyC || 0x8b5a46);
    if (s.sign) { const sg = s.sign; f.d(sg.a, sg.y, sg.side === 'n' ? -hd - 0.35 : hd, sg.b, sg.y + sg.h, sg.side === 'n' ? -hd : hd + 0.35, sg.color); }
    return { f, Fy, top };
  };

  // Low fence (jump over it) along a segment, solid 1.0 m rails with deco posts.
  kit.fence = (x0, z0, x1, z1, o = {}) => {
    const h = o.h || 1.0, c = o.color || 0xf1ead8, t = 0.12;
    kit.solid(Math.min(x0, x1) - t / 2, 0, Math.min(z0, z1) - t / 2, Math.max(x0, x1) + t / 2, h, Math.max(z0, z1) + t / 2, c);
    const n = Math.max(2, Math.round(Math.hypot(x1 - x0, z1 - z0) / 1.5));
    for (let i = 0; i <= n; i++) {
      const px = x0 + ((x1 - x0) * i) / n, pz = z0 + ((z1 - z0) * i) / n;
      kit.paint(px - 0.09, 0, pz - 0.09, px + 0.09, h + 0.12, pz + 0.09, shade(c, 0.85));
    }
    return kit;
  };

  // Train: cars joined end to end along local x (rot 0 = along x), centred on (x, z), width 3.2 across z. Each car has
  // two door gaps (1.6 m) per long side at +-doorAt from the car centre and an interior doorway at every joint, so
  // you can walk the whole length. Floor top is at y + 0 (frame base), roof 2.5 m above.
  //   o = { cars, len, floorY (frame y), color, stripe, doorAt, plates:[{ x0, x1 }] }
  kit.train = (x, z, rot, o = {}) => {
    const cars = o.cars || 3, len = o.len || 12.8, y = o.y || 0, color = o.color || 0xc9ced6, stripe = o.stripe || 0x2f6fb0, w = 3.2, t = 0.2, hw = w / 2, H = 2.5;
    const f = kit.frame(x, z, rot, y), dAt = o.doorAt || 3.2, total = cars * len, x0 = -total / 2, dark = shade(color, 0.45);
    f.b(x0, -0.4, -hw, x0 + total, 0, hw, shade(color, 0.6));                 // floor slab (top = frame y)
    f.b(x0, H, -hw, x0 + total, H + 0.2, hw, shade(color, 1.1));              // roof
    for (let c = 0; c < cars; c++) {
      const cc = x0 + len / 2 + c * len;
      const ops = [-dAt, dAt].map((d) => ({ a: cc + d - 0.8, b: cc + d + 0.8 }));
      kit.wallRun(f, 'x', cc - len / 2, cc + len / 2, -hw + t / 2, t, 0, H, color, ops, null);
      kit.wallRun(f, 'x', cc - len / 2, cc + len / 2, hw - t / 2, t, 0, H, color, ops, null);
      // painted side windows on the solid panels, door frames, livery stripe, roof pod, bogies
      for (const s2 of [-1, 1]) {
        const zo = s2 * hw, d0 = s2 > 0 ? 0 : -0.05, d1 = s2 > 0 ? 0.05 : 0;
        for (const [a, b] of [[cc - len / 2 + 0.3, cc - dAt - 1.05], [cc - dAt + 1.05, cc + dAt - 1.05], [cc + dAt + 1.05, cc + len / 2 - 0.3]]) {
          const n = Math.max(1, Math.round((b - a) / 1.9));
          for (let k = 0; k < n; k++) { const wa = a + ((b - a) * k) / n + 0.15, wb = a + ((b - a) * (k + 1)) / n - 0.15; f.d(wa, 1.0, zo + d0, wb, 2.0, zo + d1, 0x233044); }
        }
        for (const d of [-dAt, dAt]) { f.d(cc + d - 0.88, 0, zo + d0, cc + d - 0.8, H, zo + d1, 0xf0f2f5); f.d(cc + d + 0.8, 0, zo + d0, cc + d + 0.88, H, zo + d1, 0xf0f2f5); }
        f.d(cc - len / 2, 0.25, zo + d0, cc + len / 2, 0.6, zo + d1, stripe);
        f.d(cc - len / 2, 2.1, zo + d0, cc + len / 2, 2.2, zo + d1, stripe);
      }
      f.d(cc - 2.4, H + 0.2, -0.9, cc + 2.4, H + 0.6, 0.9, dark);
      for (const bx of [-4.6, 4.6]) { f.d(cc + bx - 0.9, -1.1, -hw + 0.2, cc + bx + 0.9, -0.4, -hw + 0.7, 0x1b1c20); f.d(cc + bx - 0.9, -1.1, hw - 0.7, cc + bx + 0.9, -0.4, hw - 0.2, 0x1b1c20); }
      // low bench along each long side, between the doors
      f.b(cc - dAt + 1.0, 0, -hw + t, cc + dAt - 1.0, 0.5, -hw + t + 0.45, 0x3a5a86);
      f.b(cc - dAt + 1.0, 0, hw - t - 0.45, cc + dAt - 1.0, 0.5, hw - t, 0x3a5a86);
      if (c < cars - 1) {                                                            // joint wall with a doorway
        const jx = cc + len / 2;
        f.b(jx - 0.1, 0, -hw + t, jx + 0.1, H, -0.8, color); f.b(jx - 0.1, 0, 0.8, jx + 0.1, H, hw - t, color);
      }
    }
    f.b(x0, 0, -hw + t, x0 + 0.2, H, hw - t, color); f.b(x0 + total - 0.2, 0, -hw + t, x0 + total, H, hw - t, color);        // closed ends
    f.d(x0 - 0.05, 0.9, -1.2, x0, 2.1, 1.2, 0x233044); f.d(x0 + total, 0.9, -1.2, x0 + total + 0.05, 2.1, 1.2, 0x233044);
    f.d(x0 - 0.05, 0.1, -hw, x0, 0.5, hw, 0xffe9a0); f.d(x0 + total, 0.1, -hw, x0 + total + 0.05, 0.5, hw, 0xff6a5a);
    return kit;
  };
  return kit;
}

// Scale an 0xRRGGBB colour's brightness (k < 1 darker, k > 1 lighter).
export function shade(c, k) {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k)), g = Math.min(255, Math.round(((c >> 8) & 255) * k)), b = Math.min(255, Math.round((c & 255) * k));
  return (r << 16) | (g << 8) | b;
}
