import { describe, expect, it } from 'vitest';
import { DATASETS, flatten, toCsv } from '../scripts/bulk-export.js';

describe('bulk export', () => {
  it('flattens nested objects into dotted columns, keeps arrays as JSON', () => {
    expect(flatten({ team: { id: 12, code: 'CAR' }, rating: 1577.5, reasons: [{ code: 'x' }] }))
      .toEqual({ 'team.id': 12, 'team.code': 'CAR', rating: 1577.5, reasons: '[{"code":"x"}]' });
  });

  it('CSV: union of columns, nulls empty, quoting for commas and quotes', () => {
    const csv = toCsv([
      { team: { code: 'CAR', name: 'Carolina Hurricanes' }, p: 0.98, note: null },
      { team: { code: 'MTL', name: 'Montréal "Habs", Canadiens' }, p: 0.5, extra: 1 },
    ]);
    expect(csv).toBe(
      'team.code,team.name,p,note,extra\n' +
      'CAR,Carolina Hurricanes,0.98,,\n' +
      'MTL,"Montréal ""Habs"", Canadiens",0.5,,1\n',
    );
  });

  it('a null nested object does not add a bare column', () => {
    const csv = toCsv([{ player: 1, team: { code: 'CAR' } }, { player: 2, team: null }]);
    expect(csv).toBe('player,team.code\n1,CAR\n2,\n');
  });

  it('covers every league-wide table, each with a unique file name', () => {
    const names = DATASETS.map(d => d[0]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['nhl-elo', 'ahl-playoff-odds', 'echl-power-rankings', 'nhl-war', 'nhl-rapm']));
  });
});
