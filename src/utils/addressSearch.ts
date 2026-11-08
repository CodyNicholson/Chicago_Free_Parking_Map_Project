import { CurbProperties, NEIGHBORHOODS, Neighborhood } from '../types/parking';

export interface CurbFeature {
  type: 'Feature';
  id: number;
  properties: CurbProperties;
  geometry: {
    type: 'LineString';
    coordinates: [number, number][];
  };
}

export interface ParsedAddressQuery {
  raw: string;
  houseNumber: number | null;
  direction: 'N' | 'S' | 'E' | 'W' | null;
  streetCore: string;
}

const DIRECTION_MAP: Record<string, 'N' | 'S' | 'E' | 'W'> = {
  N: 'N',
  NORTH: 'N',
  S: 'S',
  SOUTH: 'S',
  E: 'E',
  EAST: 'E',
  W: 'W',
  WEST: 'W',
};

const STREET_SUFFIXES = new Set([
  'ST',
  'STREET',
  'AVE',
  'AVENUE',
  'BLVD',
  'BOULEVARD',
  'DR',
  'DRIVE',
  'RD',
  'ROAD',
  'PKWY',
  'PARKWAY',
  'PL',
  'PLACE',
  'CT',
  'COURT',
  'TER',
  'TERRACE',
  'WAY',
]);

/**
 * Parses a human-entered Chicago address or street search query
 * such as "2420 N Kedzie Blvd, Chicago, IL", "1060 W Addison", or "Damen Ave".
 */
export function parseChicagoAddressQuery(rawQuery: string): ParsedAddressQuery {
  // Strip city/state/zip suffix
  const cleaned = rawQuery
    .toUpperCase()
    .replace(/,\s*CHICAGO.*$/i, '')
    .replace(/\bCHICAGO\b/g, '')
    .replace(/\bIL\b|\bILLINOIS\b/g, '')
    .replace(/\b606\d{2}\b/g, '')
    .replace(/[.,#]/g, ' ')
    .trim();

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { raw: rawQuery, houseNumber: null, direction: null, streetCore: '' };
  }

  let idx = 0;
  let houseNumber: number | null = null;
  let direction: 'N' | 'S' | 'E' | 'W' | null = null;

  // 1. Optional leading house number (e.g., "2420" or "2401-2499")
  const firstNumMatch = tokens[idx].match(/^(\d+)(?:-\d+)?$/);
  if (firstNumMatch) {
    houseNumber = parseInt(firstNumMatch[1], 10);
    idx++;
  }

  // 2. Optional directional prefix (N, S, E, W)
  if (idx < tokens.length && DIRECTION_MAP[tokens[idx]]) {
    direction = DIRECTION_MAP[tokens[idx]];
    idx++;
  }

  // 3. Remaining tokens form the street name; strip trailing street type suffix if present
  const remaining = tokens.slice(idx);
  if (remaining.length > 1 && STREET_SUFFIXES.has(remaining[remaining.length - 1])) {
    remaining.pop();
  }

  return {
    raw: rawQuery,
    houseNumber,
    direction,
    streetCore: remaining.join(' '),
  };
}

function getCurbAddrBounds(props: CurbProperties): [number, number] {
  if (typeof props.addr_low === 'number' && typeof props.addr_high === 'number') {
    return [props.addr_low, props.addr_high];
  }
  const parts = String(props.addr || '').split('-');
  if (parts.length === 2) {
    const low = parseInt(parts[0], 10);
    const high = parseInt(parts[1], 10);
    if (!Number.isNaN(low) && !Number.isNaN(high)) {
      return [Math.min(low, high), Math.max(low, high)];
    }
  }
  return [0, 0];
}

function extractCurbStreetCore(fullStreetName: string): {
  dir: string | null;
  core: string;
} {
  const tokens = fullStreetName.toUpperCase().trim().split(/\s+/);
  let dir: string | null = null;
  if (tokens.length > 1 && DIRECTION_MAP[tokens[0]]) {
    dir = DIRECTION_MAP[tokens[0]];
    tokens.shift();
  }
  if (tokens.length > 1 && STREET_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return { dir, core: tokens.join(' ') };
}

/**
 * Ranks and returns matching Chicago curb segments for any street, address number,
 * neighborhood, or permit zone query.
 */
export function searchCurbFeatures(
  query: string,
  features: CurbFeature[],
  limit: number = 8
): CurbFeature[] {
  const trimmed = query.trim();
  if (trimmed.length < 2 || features.length === 0) return [];

  const parsed = parseChicagoAddressQuery(trimmed);
  const qUpper = trimmed.toUpperCase();

  const scored: { feat: CurbFeature; score: number }[] = [];

  for (let i = 0; i < features.length; i++) {
    const feat = features[i];
    const props = feat.properties;
    const { dir: curbDir, core: curbCore } = extractCurbStreetCore(props.name);
    const [low, high] = getCurbAddrBounds(props);

    let score = -1;

    if (parsed.houseNumber !== null && parsed.streetCore.length > 0) {
      // Address number + street name search (e.g., "2420 N Kedzie" or "1060 W Addison")
      const coreMatches =
        curbCore === parsed.streetCore ||
        curbCore.includes(parsed.streetCore) ||
        props.name.toUpperCase().includes(parsed.streetCore);

      if (!coreMatches) continue;
      if (parsed.direction && curbDir && parsed.direction !== curbDir) continue;

      const targetParity = parsed.houseNumber % 2 === 0 ? 'E' : 'O';
      const parityBonus = props.parity === targetParity ? 250 : 0;
      const exactCoreBonus = curbCore === parsed.streetCore ? 200 : 0;
      const dirBonus = parsed.direction && curbDir === parsed.direction ? 150 : 0;

      if (parsed.houseNumber >= low && parsed.houseNumber <= high) {
        // House number falls directly inside this block's address range!
        score = 2000 + parityBonus + exactCoreBonus + dirBonus;
      } else {
        // Score by closeness to this block's address range on the same street
        const dist =
          parsed.houseNumber < low
            ? low - parsed.houseNumber
            : parsed.houseNumber - high;
        if (dist <= 1200) {
          score = Math.max(10, 1200 - dist) + parityBonus + exactCoreBonus + dirBonus;
        }
      }
    } else if (parsed.houseNumber !== null && parsed.streetCore.length === 0) {
      // Pure number search (e.g. "2400")
      if (parsed.houseNumber >= low && parsed.houseNumber <= high) {
        const targetParity = parsed.houseNumber % 2 === 0 ? 'E' : 'O';
        score = 500 + (props.parity === targetParity ? 100 : 0);
      }
    } else {
      // Street name, neighborhood, or permit zone search (e.g. "Kedzie", "Wicker Park", "Zone 154")
      const searchCore = parsed.streetCore || qUpper;
      if (curbCore === searchCore) {
        score = 1000 + (parsed.direction && curbDir === parsed.direction ? 200 : 0);
      } else if (curbCore.startsWith(searchCore)) {
        score = 800 + (parsed.direction && curbDir === parsed.direction ? 150 : 0);
      } else if (props.name.toUpperCase().includes(qUpper)) {
        score = 600;
      } else if (props.neighborhood && props.neighborhood.toUpperCase().includes(qUpper)) {
        score = 400;
      } else if (props.p_zone && (`ZONE ${props.p_zone}` === qUpper || props.p_zone === qUpper)) {
        score = 500;
      }
    }

    if (score > 0) {
      scored.push({ feat, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => item.feat);
}

/**
 * Checks if the query matches a known Chicago neighborhood name.
 */
export function matchNeighborhoodByName(query: string): Neighborhood | null {
  const q = query.trim().toUpperCase();
  if (q.length < 3) return null;
  return (
    NEIGHBORHOODS.find(
      (n) => n.name.toUpperCase() === q || n.name.toUpperCase().includes(q)
    ) ?? null
  );
}

/**
 * Computes the interpolated [lng, lat] along a curb segment for a specific house number.
 */
export function interpolateCurbCoordinate(
  feat: CurbFeature,
  houseNumber: number | null
): [number, number] {
  const coords = feat.geometry.coordinates;
  if (coords.length === 0) return [-87.6298, 41.8819];
  if (coords.length === 1) return coords[0];

  const p0 = coords[0];
  const p1 = coords[coords.length - 1];

  if (houseNumber !== null) {
    const [low, high] = getCurbAddrBounds(feat.properties);
    if (high > low && houseNumber >= low && houseNumber <= high) {
      const ratio = Math.max(0.05, Math.min(0.95, (houseNumber - low) / (high - low)));
      return [
        p0[0] + (p1[0] - p0[0]) * ratio,
        p0[1] + (p1[1] - p0[1]) * ratio,
      ];
    }
  }

  return [(p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5];
}

/**
 * Finds the nearest curb segment to a given [lng, lat] point in Chicago.
 */
export function findNearestCurbToLngLat(
  lng: number,
  lat: number,
  features: CurbFeature[]
): CurbFeature | null {
  let bestFeat: CurbFeature | null = null;
  let bestDistSq = Infinity;

  for (let i = 0; i < features.length; i++) {
    const feat = features[i];
    const coords = feat.geometry.coordinates;
    for (let j = 0; j < coords.length; j++) {
      const dx = coords[j][0] - lng;
      const dy = coords[j][1] - lat;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestFeat = feat;
      }
    }
  }

  return bestFeat;
}
