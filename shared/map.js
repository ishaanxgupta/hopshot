// Back-compat entry: the default map. The registry lives in shared/maps/index.js.
import { getMap, DEFAULT_MAP_ID } from './maps/index.js';
export { MAPS, MAP_IDS, getMap, DEFAULT_MAP_ID } from './maps/index.js';
export const MAP = getMap(DEFAULT_MAP_ID);
