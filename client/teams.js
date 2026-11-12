// Team colours and the viewer-relative friend / enemy rule, shared by the renderer and the DOM UI.
// Everything is drawn from the viewer's point of view: your team is always blue, the other red.
// With no team (free-for-all, or a viewer who has not been put on a team) team 'a' is blue.

export const FRIEND_HEX = 0x3b9dff;
export const ENEMY_HEX = 0xff5047;
export const FRIEND_CSS = '#3b9dff';
export const ENEMY_CSS = '#ff5047';
export const NEUTRAL_CSS = '#ffffff';
export const CONTEST_CSS = '#ffd23a';

/** 1 = friend, 2 = enemy, 0 = not a team situation. */
export function teamRel(team, myTeam) {
  if (team !== 'a' && team !== 'b') return 0;
  const mine = myTeam === 'a' || myTeam === 'b' ? myTeam : 'a';
  return team === mine ? 1 : 2;
}
export function relCss(rel) { return rel === 1 ? FRIEND_CSS : rel === 2 ? ENEMY_CSS : NEUTRAL_CSS; }
export function relHex(rel) { return rel === 1 ? FRIEND_HEX : rel === 2 ? ENEMY_HEX : 0xffffff; }
export function teamCss(team, myTeam) { return relCss(teamRel(team, myTeam)); }
export function otherTeamId(t) { return t === 'a' ? 'b' : t === 'b' ? 'a' : ''; }
