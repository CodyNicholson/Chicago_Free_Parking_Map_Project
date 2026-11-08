import { describe, expect, it } from 'vitest';
import {
  decodeHexMaskToSlots,
  evaluateCurbAvailability,
  formatDuration,
  formatSlotTime,
} from './curbEvaluator';
import {
  CurbFeature,
  interpolateCurbCoordinate,
  parseChicagoAddressQuery,
  searchCurbFeatures,
} from './addressSearch';
import { CurbProperties, DailyOverrides } from '../types/parking';

const baseOverrides: DailyOverrides = {
  isWinterBanSeason: false,
  isTwoInchSnowBanActive: false,
  activeSweepingWardSectionsToday: [],
};

const sampleFreeCurb: CurbProperties = {
  curb_id: 1001,
  name: 'N KEDZIE BLVD',
  side: 'R',
  parity: 'E',
  addr: '2400-2498',
  p_zone: '',
  w_ban: false,
  s_route: false,
  w_sec: '35-04',
  mask_hex: 'f'.repeat(168),
};

describe('curbEvaluator (672-bit weekly bitmask decoder & window scanner)', () => {
  it('decodes a 168-char all-F hex mask into 672 free slots', () => {
    const slots = decodeHexMaskToSlots('f'.repeat(168));
    expect(slots.length).toBe(672);
    expect(slots.every((bit) => bit === 1)).toBe(true);
  });

  it('identifies 24/7 free parking when no restrictions or active overrides apply', () => {
    const res = evaluateCurbAvailability(sampleFreeCurb, 6, 55, baseOverrides);
    expect(res.isFreeNow).toBe(true);
    expect(res.isFree24_7).toBe(true);
    expect(res.statusTier).toBe('free_long');
    expect(res.freeUntilFormatted).toBe('24/7 (No posted time limit)');
  });

  it('applies Ward Street Sweeping override dynamically on the selected day (9 AM - 2 PM)', () => {
    const sweepingOverrides: DailyOverrides = {
      ...baseOverrides,
      activeSweepingWardSectionsToday: ['35-04'],
    };

    // At 8:00 AM (slot 32), curb is free for 1h 0m (until 9:00 AM sweeping starts)
    const beforeSweep = evaluateCurbAvailability(sampleFreeCurb, 2, 32, sweepingOverrides);
    expect(beforeSweep.isFreeNow).toBe(true);
    expect(beforeSweep.isFree24_7).toBe(false);
    expect(beforeSweep.remainingMinutes).toBe(60);
    expect(beforeSweep.statusTier).toBe('free_ending_soon');
    expect(beforeSweep.freeUntilFormatted).toBe('Until 9:00 AM');

    // At 10:00 AM (slot 40), curb is restricted by Ward 35-04 Street Sweeping until 2:00 PM
    const duringSweep = evaluateCurbAvailability(sampleFreeCurb, 2, 40, sweepingOverrides);
    expect(duringSweep.isFreeNow).toBe(false);
    expect(duringSweep.nextFreeAtFormatted).toBe('Free starting 2:00 PM');
    expect(duringSweep.restrictionReason).toContain('Ward 35-04 Street Sweeping');
  });

  it('applies Winter Overnight Ban (3:00 AM - 7:00 AM) when winter season is active', () => {
    const winterCurb: CurbProperties = {
      ...sampleFreeCurb,
      w_ban: true,
    };
    const winterOverrides: DailyOverrides = {
      ...baseOverrides,
      isWinterBanSeason: true,
    };

    // At 3:15 PM (slot 61) on Saturday, free for 11h 45m until 3:00 AM Sunday
    const eveningEval = evaluateCurbAvailability(winterCurb, 6, 61, winterOverrides);
    expect(eveningEval.isFreeNow).toBe(true);
    expect(eveningEval.remainingMinutes).toBe(11 * 60 + 45);
    expect(eveningEval.freeUntilFormatted).toBe('Until 3:00 AM (Sun)');
  });

  it('formats slot times and durations cleanly', () => {
    expect(formatSlotTime(0)).toBe('12:00 AM');
    expect(formatSlotTime(36)).toBe('9:00 AM');
    expect(formatSlotTime(55)).toBe('1:45 PM');
    expect(formatDuration(705, false)).toBe('11h 45m');
    expect(formatDuration(90, false)).toBe('1h 30m');
    expect(formatDuration(45, false)).toBe('45m left');
    expect(formatDuration(10080, true)).toBe('24/7 Free');
  });

  it('parses Chicago street addresses and matches block address ranges + Odd/Even parity', () => {
    const parsed = parseChicagoAddressQuery('2420 N Kedzie Blvd, Chicago, IL 60647');
    expect(parsed.houseNumber).toBe(2420);
    expect(parsed.direction).toBe('N');
    expect(parsed.streetCore).toBe('KEDZIE');

    const oddCurb: CurbFeature = {
      type: 'Feature',
      id: 101,
      properties: {
        ...sampleFreeCurb,
        curb_id: 101,
        name: 'N KEDZIE AVE',
        side: 'L',
        parity: 'O',
        addr: '2401-2799',
        addr_low: 2401,
        addr_high: 2799,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-87.7069, 41.9248],
          [-87.7069, 41.932],
        ],
      },
    };

    const evenCurb: CurbFeature = {
      type: 'Feature',
      id: 102,
      properties: {
        ...sampleFreeCurb,
        curb_id: 102,
        name: 'N KEDZIE AVE',
        side: 'R',
        parity: 'E',
        addr: '2400-2798',
        addr_low: 2400,
        addr_high: 2798,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-87.7067, 41.9248],
          [-87.7067, 41.932],
        ],
      },
    };

    const matchesEven = searchCurbFeatures('2420 N Kedzie Blvd', [oddCurb, evenCurb]);
    expect(matchesEven.length).toBe(2);
    expect(matchesEven[0].properties.curb_id).toBe(102); // Even side ranked #1 for 2420

    const matchesOdd = searchCurbFeatures('2421 N Kedzie', [oddCurb, evenCurb]);
    expect(matchesOdd[0].properties.curb_id).toBe(101); // Odd side ranked #1 for 2421

    const coord = interpolateCurbCoordinate(evenCurb, 2600);
    expect(coord[0]).toBeCloseTo(-87.7067, 4);
    expect(coord[1]).toBeGreaterThan(41.9248);
    expect(coord[1]).toBeLessThan(41.932);
  });
});
