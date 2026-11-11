// Map registry. MAPS is ordered, the default map first. Every map file exports `MAP`.
import { MAP as prism_yard } from './prism_yard.js';
import { MAP as cinder_loop } from './cinder_loop.js';
import { MAP as tidal_basin } from './tidal_basin.js';
import { MAP as dune_relay } from './dune_relay.js';
import { MAP as halo_spire } from './halo_spire.js';

export const MAPS = [prism_yard, cinder_loop, tidal_basin, dune_relay, halo_spire];
export const MAP_IDS = MAPS.map((m) => m.id);
export const DEFAULT_MAP_ID = 'prism_yard';
const BY_ID = new Map(MAPS.map((m) => [m.id, m]));
export function getMap(id) { return BY_ID.get(id) || BY_ID.get(DEFAULT_MAP_ID); }
