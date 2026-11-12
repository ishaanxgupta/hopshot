// Map registry. MAPS is ordered, the default map first. Every map file exports `MAP`.
import { MAP as prism_yard } from './prism_yard.js';
import { MAP as crate_cove } from './crate_cove.js';
import { MAP as hollow_pines } from './hollow_pines.js';
import { MAP as maple_street } from './maple_street.js';
import { MAP as skyline } from './skyline.js';
import { MAP as metro_line } from './metro_line.js';

export const MAPS = [prism_yard, crate_cove, hollow_pines, maple_street, skyline, metro_line];
export const MAP_IDS = MAPS.map((m) => m.id);
export const DEFAULT_MAP_ID = 'prism_yard';
const BY_ID = new Map(MAPS.map((m) => [m.id, m]));
export function getMap(id) { return BY_ID.get(id) || BY_ID.get(DEFAULT_MAP_ID); }
