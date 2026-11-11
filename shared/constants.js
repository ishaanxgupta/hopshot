// Shared constants. Pure ESM: imported by the Node server and the browser client.
// Owned by the orchestrator - agents must not change values here without reporting it.

export const TICK_RATE = 60;            // simulation ticks per second (client prediction + server)
export const DT = 1 / TICK_RATE;        // fixed timestep, seconds
export const SNAPSHOT_EVERY = 2;        // server sends a snapshot every N ticks (30 Hz)
export const MAX_PLAYERS = 20;          // per room, humans + bots
export const INTERP_DELAY_MS = 100;     // minimum remote-player interpolation delay (behind the newest snapshot)
export const INTERP_DELAY_MAX_MS = 250; // adaptive interpolation delay upper bound
export const MAX_REWIND_MS = 700;       // lag-compensation rewind cap (250 ms RTT + jitter + interp + buffer)
export const MAX_DILATION_PERMILLE = 30; // server-driven client time dilation bound (+-3%)
export const RESPAWN_MS = 2500;
export const ROUND_MS = 5 * 60 * 1000;
export const INTERMISSION_MS = 10 * 1000;
export const MAX_HEALTH = 100;
export const REGEN_DELAY_MS = 5000;     // no damage for this long -> regenerate
export const REGEN_PER_SEC = 20;

// Player collision volume: axis-aligned box. Position (x, y, z) is the centre of the feet.
export const PLAYER = {
  halfWidth: 0.35,
  height: 1.8,
  crouchHeight: 1.1,
  eyeHeight: 1.62,
  crouchEyeHeight: 0.95,
  headSize: 0.32,       // the top `headSize` metres of the current height count as a headshot
};

// Input button bitmask (cmd.buttons, fits in a uint16).
export const BTN = {
  FORWARD: 1,
  BACK: 2,
  LEFT: 4,
  RIGHT: 8,
  JUMP: 16,
  CROUCH: 32,
  FIRE: 64,
  ADS: 128,
  RELOAD: 256,
};
export const BTN_MASK = 511;

export const PITCH_LIMIT = Math.PI / 2 - 0.01;
