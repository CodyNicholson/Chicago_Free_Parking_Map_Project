export interface CurbProperties {
  curb_id: number;
  name: string;         // e.g., "N KEDZIE AVE"
  neighborhood?: string;
  side: 'L' | 'R';      // Left or Right curb
  parity: 'O' | 'E';    // Odd or Even addresses
  addr: string;         // e.g., "2401-2499"
  addr_low?: number;
  addr_high?: number;
  p_zone: string;       // Permit zone number or ""
  w_ban: boolean;       // Winter Overnight Ban (3AM-7AM Dec 1 - Apr 1)
  s_route: boolean;     // 2-Inch Snow Route
  w_sec: string;        // Ward + Sweeping Section ID (e.g., "35-04")
  sched_key?: string;   // Compact schedule bucket key for fast GPU WebGL styling
  mask_hex: string;     // 168-character hex encoding 672 x 15-min weekly slots
}

export interface DailyOverrides {
  generatedAt?: string;
  timezone?: string;
  isWinterBanSeason: boolean;
  isTwoInchSnowBanActive: boolean;
  activeSweepingWardSectionsToday: string[];
}

export interface CurbEvaluation {
  isFreeNow: boolean;
  isFree24_7: boolean;
  remainingMinutes: number;
  freeUntilFormatted: string;
  nextFreeAtFormatted: string;
  restrictionReason: string;
  hourlyTimeline: boolean[]; // 24 hours from start of selected day
  statusTier: 'free_long' | 'free_ending_soon' | 'restricted';
}

export interface Neighborhood {
  name: string;
  lng: number;
  lat: number;
  zoom: number;
  wardHint: string;
}

export const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const NEIGHBORHOODS: Neighborhood[] = [
  { name: 'All Chicago', lng: -87.6650, lat: 41.8820, zoom: 11.6, wardHint: '' },
  { name: 'The Loop', lng: -87.6298, lat: 41.8819, zoom: 14.8, wardHint: '42-01' },
  { name: 'West Loop', lng: -87.6536, lat: 41.8842, zoom: 14.8, wardHint: '27-03' },
  { name: 'Lincoln Park', lng: -87.6488, lat: 41.9214, zoom: 14.6, wardHint: '43-01' },
  { name: 'Lakeview', lng: -87.6553, lat: 41.9435, zoom: 14.5, wardHint: '44-01' },
  { name: 'Wicker Park', lng: -87.6769, lat: 41.9088, zoom: 14.8, wardHint: '01-02' },
  { name: 'Logan Square', lng: -87.7068, lat: 41.9288, zoom: 14.6, wardHint: '35-04' },
  { name: 'Pilsen', lng: -87.6656, lat: 41.8568, zoom: 14.6, wardHint: '25-01' },
  { name: 'Hyde Park', lng: -87.5941, lat: 41.7943, zoom: 14.6, wardHint: '05-02' },
  { name: 'Edgewater', lng: -87.6685, lat: 41.9836, zoom: 14.4, wardHint: '48-01' },
];
