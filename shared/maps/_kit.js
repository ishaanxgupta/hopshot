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
  return kit;
}
