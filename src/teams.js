// A league's current teams from the poller's /config/teams, indexed both
// ways: the NHL keys its tables by team code, HockeyTech by team id.

import { poller } from './poller.js';

export async function teamIndex(env, league) {
  const { teams } = await poller(env, `/config/teams?league=${league}`);
  const byId = new Map(teams.map(t => [String(t.id), t]));
  const byCode = new Map(teams.map(t => [t.code, t]));
  return {
    teams,
    // A team from a table key: the code for the NHL, the id otherwise.
    // Null for a key that isn't a current team (e.g. a relocated club).
    find(key) {
      if (key == null) return null;
      return (league === 'nhl' ? byCode.get(String(key)) : byId.get(String(key))) ?? null;
    },
  };
}

export const teamRef = t => ({ id: t.id, code: t.code, name: t.name ?? null });
