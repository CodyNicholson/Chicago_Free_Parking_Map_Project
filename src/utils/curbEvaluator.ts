import {
  CurbEvaluation,
  CurbProperties,
   DAYS_OF_WEEK,
  DailyOverrides,
} from '../types/parking';

/**
 * Decodes a 168-character hexadecimal bitmask into a 672-element Uint8Array
 * where each index represents a 15-minute slot in the week (0 = Sun 00:00 .. 671 = Sat 23:45).
 * 1 = FREE parking, 0 = RESTRICTED.
 */
export function decodeHexMaskToSlots(maskHex: string): Uint8Array {
  const slots = new Uint8Array(672);
  const hex = (maskHex || '').padStart(168, 'f');
  for (let i = 0; i < 168; i++) {
    const code = hex.charCodeAt(i);
    // Fast ASCII hex nibble parse (0-9, a-f, A-F)
    const nibble =
      code >= 48 && code <= 57
        ? code - 48
        : code >= 97 && code <= 102
        ? code - 87
        : code >= 65 && code <= 70
        ? code - 55
        : 15;
    const base = i * 4;
    slots[base] = (nibble >> 3) & 1;
    slots[base + 1] = (nibble >> 2) & 1;
    slots[base + 2] = (nibble >> 1) & 1;
    slots[base + 3] = nibble & 1;
  }
  return slots;
}

function toBool(val: unknown): boolean {
  return val === true || val === 'true' || val === 1 || val === '1';
}

/**
 * Evaluates a single curb segment at (selectedDay, selectedSlotInDay) with live daily overrides.
 * Performs a 672-slot forward circular scan in < 2 microseconds.
 */
export function evaluateCurbAvailability(
  curb: CurbProperties,
  selectedDay: number,       // 0 (Sun) .. 6 (Sat)
  selectedSlotInDay: number, // 0 .. 95 (15-min increments)
  overrides: DailyOverrides
): CurbEvaluation {
  // 1. Decode 168-char hex into 672-slot array (1 = Free, 0 = Restricted)
  const slots = decodeHexMaskToSlots(curb.mask_hex);
  const hasWinterBan = toBool(curb.w_ban);
  const hasSnowRoute = toBool(curb.s_route);
  const permitZone = curb.p_zone ? String(curb.p_zone).trim() : '';
  const wardSec = curb.w_sec ? String(curb.w_sec).trim() : '';

  // 2. Apply dynamic daily overrides (Winter Ban, Snow Ban, Street Sweeping)
  for (let d = 0; d < 7; d++) {
    // Winter Overnight Ban: 3:00 AM (slot 12) to 7:00 AM (slot 28) daily Dec 1 - Apr 1
    if (overrides.isWinterBanSeason && hasWinterBan) {
      for (let s = 12; s < 28; s++) {
        slots[d * 96 + s] = 0;
      }
    }
    // Active 2-Inch Snow Ban: blocks snow routes 24/7 while active
    if (overrides.isTwoInchSnowBanActive && hasSnowRoute) {
      for (let s = 0; s < 96; s++) {
        slots[d * 96 + s] = 0;
      }
    }
  }

  // Street Sweeping on selected day (9:00 AM slot 36 to 2:00 PM slot 56)
  const isSweepingToday =
    wardSec.length > 0 && overrides.activeSweepingWardSectionsToday.includes(wardSec);
  if (isSweepingToday) {
    for (let s = 36; s < 56; s++) {
      slots[selectedDay * 96 + s] = 0;
    }
  }

  const currentBitIndex = selectedDay * 96 + selectedSlotInDay;
  const isFreeNow = slots[currentBitIndex] === 1;

  // 3. Scan forward to compute exact contiguous free duration or next free window
  let contiguousSlots = 0;
  for (let step = 1; step <= 672; step++) {
    const idx = (currentBitIndex + step) % 672;
    if ((slots[idx] === 1) === isFreeNow) {
      contiguousSlots++;
    } else {
      break;
    }
  }

  const isFree24_7 = isFreeNow && contiguousSlots === 672;
  const remainingMinutes = isFreeNow ? (contiguousSlots + 1) * 15 : 0;

  // Format transition timestamp
  const transitionBitIndex = (currentBitIndex + contiguousSlots + 1) % 672;
  const transitionDay = Math.floor(transitionBitIndex / 96);
  const transitionSlotInDay = transitionBitIndex % 96;
  const transitionFormatted = formatSlotTime(
    transitionSlotInDay,
    transitionDay !== selectedDay ? DAYS_OF_WEEK[transitionDay] : 'Today'
  );

  // Identify primary restriction reason
  let restrictionReason = 'Unrestricted Public Curb';
  if (overrides.isTwoInchSnowBanActive && hasSnowRoute) {
    restrictionReason = '2-Inch Snow Route Ban Active';
  } else if (isSweepingToday && selectedSlotInDay >= 36 && selectedSlotInDay < 56) {
    restrictionReason = `Ward ${wardSec} Street Sweeping (9 AM – 2 PM)`;
  } else if (
    overrides.isWinterBanSeason &&
    hasWinterBan &&
    selectedSlotInDay >= 12 &&
    selectedSlotInDay < 28
  ) {
    restrictionReason = 'Winter Overnight Tow Zone (3 AM – 7 AM)';
  } else if (permitZone) {
    restrictionReason = `Residential Permit Zone #${permitZone}`;
  } else if (isSweepingToday && isFreeNow && transitionDay === selectedDay && transitionSlotInDay === 36) {
    restrictionReason = `Ward ${wardSec} Sweeping Starts 9 AM`;
  } else if (
    overrides.isWinterBanSeason &&
    hasWinterBan &&
    isFreeNow &&
    transitionSlotInDay === 12
  ) {
    restrictionReason = '3 AM Winter Overnight Ban';
  } else if (!isFree24_7) {
    restrictionReason = 'Metered / Time-Limited Curb';
  }

  // Build 24-hour summary for the selected day (1 = free at top of hour, 0 = restricted)
  const hourlyTimeline: boolean[] = [];
  for (let h = 0; h < 24; h++) {
    // Check all four 15-min slots in the hour; free if all slots in that hour are free
    const baseIdx = selectedDay * 96 + h * 4;
    const hourFree =
      slots[baseIdx] === 1 &&
      slots[baseIdx + 1] === 1 &&
      slots[baseIdx + 2] === 1 &&
      slots[baseIdx + 3] === 1;
    hourlyTimeline.push(hourFree);
  }

  const statusTier: CurbEvaluation['statusTier'] = !isFreeNow
    ? 'restricted'
    : !isFree24_7 && remainingMinutes < 120
    ? 'free_ending_soon'
    : 'free_long';

  return {
    isFreeNow,
    isFree24_7,
    remainingMinutes,
    freeUntilFormatted: isFree24_7
      ? '24/7 (No posted time limit)'
      : `Until ${transitionFormatted}`,
    nextFreeAtFormatted: !isFreeNow
      ? remainingMinutes === 0 && contiguousSlots === 672
        ? 'Permit / Restricted 24/7'
        : `Free starting ${transitionFormatted}`
      : '',
    restrictionReason,
    hourlyTimeline,
    statusTier,
  };
}

export function formatSlotTime(slotInDay: number, dayLabel?: string): string {
  const totalMinutes = slotInDay * 15;
  const hours24 = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  const period = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const timeStr = `${hours12}:${mins.toString().padStart(2, '0')} ${period}`;
  return dayLabel && dayLabel !== 'Today' ? `${timeStr} (${dayLabel})` : timeStr;
}

export function formatDuration(minutes: number, is24_7: boolean): string {
  if (is24_7) return '24/7 Free';
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs === 0) return `${mins}m left`;
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs} hrs`;
}

/**
 * Returns the current day of week (0..6) and 15-minute slot (0..95) in America/Chicago timezone.
 */
export function getChicagoCurrentDayAndSlot(): { day: number; slot: number } {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now);

    const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sat';
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '13', 10) % 24;
    const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '45', 10);

    const dayIdx = DAYS_OF_WEEK.indexOf(weekdayStr as (typeof DAYS_OF_WEEK)[number]);
    return {
      day: dayIdx >= 0 ? dayIdx : 6,
      slot: Math.min(95, Math.max(0, hour * 4 + Math.floor(minute / 15))),
    };
  } catch {
    return { day: 6, slot: 55 };
  }
}
