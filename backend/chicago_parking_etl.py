"""
chicago_parking_etl.py
Fetches Chicago street & parking restriction datasets via Socrata Open Data API (SODA),
compiles 672-bit weekly free-parking masks (15-min resolution), updates PostGIS,
and exports static vector tiles (PMTiles / GeoJSON) + daily overrides JSON for the web app.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    import requests
except ImportError:
    requests = None  # type: ignore

try:
    import psycopg
except ImportError:
    psycopg = None  # type: ignore

try:
     CHICAGO_TZ = ZoneInfo("America/Chicago")
except Exception:
    from datetime import timezone, timedelta
    CHICAGO_TZ = timezone(timedelta(hours=-6))  # type: ignore

SOCRATA_DOMAIN = "https://data.cityofchicago.org/resource"
APP_TOKEN = os.environ.get("CHICAGO_SODA_APP_TOKEN", "")

# Socrata Dataset Identifiers (6 core datasets)
DATASETS = {
    "centerlines": "6imu-meau",         # Street Center Lines
    "permit_zones": "u9xt-hiju",        # Parking Permit Zones
    "winter_ban": "fr3e-nxk2",          # Winter Overnight Parking Restrictions (3AM-7AM Dec 1 - Apr 1)
    "snow_routes": "f7f2-ggz5",         # 2-Inch Snow Ban Routes
    "sweeping_zones": "nk6s-cie5",      # Street Sweeping Zones (Polygons by Ward/Section)
    "sweeping_schedule": "u5ai-3efk",   # Street Sweeping Schedule
}

# 672 slots = 7 days (0=Sunday .. 6=Saturday) * 96 fifteen-minute slots per day
TOTAL_WEEKLY_SLOTS = 672
ALL_FREE_MASK = (1 << TOTAL_WEEKLY_SLOTS) - 1

DAY_NAME_MAP = {
    "SUN": 0,
    "MON": 1,
    "TUE": 2,
    "WED": 3,
    "THU": 4,
    "FRI": 5,
    "SAT": 6,
}


def fetch_socrata_dataset(
    dataset_id: str, select_clause: str = "*", where_clause: str | None = None
) -> list[dict[str, Any]]:
    """Paginates through a Chicago Socrata Open Data endpoint using $limit and $offset."""
    if requests is None:
        raise RuntimeError("The 'requests' library is required to fetch live Socrata datasets.")

    records: list[dict[str, Any]] = []
    limit = 50000
    offset = 0
    headers = {"X-App-Token": APP_TOKEN} if APP_TOKEN else {}

    while True:
        params: dict[str, Any] = {
            "$select": select_clause,
            "$limit": limit,
            "$offset": offset,
            "$order": ":id",
        }
        if where_clause:
            params["$where"] = where_clause

        resp = requests.get(
            f"{SOCRATA_DOMAIN}/{dataset_id}.json",
            params=params,
            headers=headers,
            timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        records.extend(batch)
        if len(batch) < limit:
            break
        offset += limit

    return records


def build_bitmask_from_restriction(
    active_days: list[int], start_hour: int, start_min: int, end_hour: int, end_min: int
) -> int:
    """
    Returns a 672-bit integer where 1 = FREE parking and 0 = RESTRICTED.
    Handles overnight spans (e.g., 6:00 PM to 6:00 AM next day) and 24-hour restrictions.
    """
    # Start with all 672 bits set to 1 (Free 24/7)
    mask = (1 << TOTAL_WEEKLY_SLOTS) - 1

    start_slot_in_day = (start_hour * 4) + (start_min // 15)
    end_slot_in_day = (end_hour * 4) + (end_min // 15)

    for day in active_days:
        if start_slot_in_day == 0 and end_slot_in_day == 96:
            # Full 24-hour restriction on this day
            for s in range(0, 96):
                bit_pos = (TOTAL_WEEKLY_SLOTS - 1) - (day * 96 + s)
                mask &= ~(1 << bit_pos)
        elif start_slot_in_day < end_slot_in_day:
            # Same-day window (e.g., 08:00 to 22:00)
            for s in range(start_slot_in_day, end_slot_in_day):
                bit_pos = (TOTAL_WEEKLY_SLOTS - 1) - (day * 96 + s)
                mask &= ~(1 << bit_pos)
        else:
            # Overnight window wrapping into next day (e.g., 18:00 to 06:00)
            for s in range(start_slot_in_day, 96):
                bit_pos = (TOTAL_WEEKLY_SLOTS - 1) - (day * 96 + s)
                mask &= ~(1 << bit_pos)
            next_day = (day + 1) % 7
            for s in range(0, end_slot_in_day):
                bit_pos = (TOTAL_WEEKLY_SLOTS - 1) - (next_day * 96 + s)
                mask &= ~(1 << bit_pos)

    return mask


def combine_restriction_masks(*masks: int) -> int:
    """Combines multiple 672-bit weekly masks via bitwise AND (restricted if any rule restricts)."""
    combined = ALL_FREE_MASK
    for m in masks:
        combined &= m
    return combined


def int_mask_to_bitstring(mask: int) -> str:
    """Formats a 672-bit integer as a PostgreSQL BIT(672) string literal."""
    return format(mask, f"0{TOTAL_WEEKLY_SLOTS}b")


def int_mask_to_hex(mask: int) -> str:
    """Formats a 672-bit integer as a compact 168-character hex string for Vector Tiles."""
    return format(mask, "0168x")


def parse_schedule_text_to_bitmask(schedule_text: str) -> int:
    """
    Parses human-readable Chicago parking sign schedule strings into a 672-bit mask.
    Examples supported:
      - "FREE 24/7" or "" -> all 1s
      - "ALL TIMES" or "24/7 PERMIT" -> all 0s
      - "MON-FRI 8:00 AM - 6:00 PM"
      - "DAILY 6:00 PM - 6:00 AM"
      - "MON-SAT 8:00 AM - 10:00 PM"
    """
    text = (schedule_text or "").strip().upper()
    if not text or text in ("FREE", "FREE 24/7", "UNRESTRICTED"):
        return ALL_FREE_MASK

    if text in ("ALL TIMES", "24/7", "24 HOURS", "TOW ZONE"):
        return 0

    # Determine active days
    active_days = list(range(7))
    if "MON-FRI" in text or "WEEKDAYS" in text:
        active_days = [1, 2, 3, 4, 5]
    elif "MON-SAT" in text:
        active_days = [1, 2, 3, 4, 5, 6]
    elif "SAT-SUN" in text or "WEEKENDS" in text:
        active_days = [0, 6]
    elif "DAILY" in text or "ALL DAYS" in text:
        active_days = [0, 1, 2, 3, 4, 5, 6]

    # Parse time range e.g. "8:00 AM - 6:00 PM" or "6PM-6AM"
    time_pattern = re.compile(
        r"(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(?:-|TO)\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)"
    )
    matches = time_pattern.findall(text)
    if not matches:
        return ALL_FREE_MASK

    combined_mask = ALL_FREE_MASK
    for sh_str, sm_str, s_ampm, eh_str, em_str, e_ampm in matches:
        sh = int(sh_str) % 12 + (12 if s_ampm == "PM" else 0)
        sm = int(sm_str) if sm_str else 0
        eh = int(eh_str) % 12 + (12 if e_ampm == "PM" else 0)
        em = int(em_str) if em_str else 0
        combined_mask &= build_bitmask_from_restriction(active_days, sh, sm, eh, em)

    return combined_mask


def export_daily_overrides_json(
    conn: Any | None, output_path: str, default_sections: list[str] | None = None
) -> dict[str, Any]:
    """
    Exports a lightweight (<15 KB) JSON file with today's active Street Sweeping ward sections
    and Winter/Snow Ban status so the CDN edge can update daily without rebuilding vector tiles.
    """
    now_chi = datetime.now(CHICAGO_TZ)
    today_str = now_chi.strftime("%Y-%m-%d")
    # Winter Overnight Ban applies Dec 1 through Apr 1 (03:00 - 07:00)
    is_winter_season = (
        (now_chi.month == 12)
        or (now_chi.month in (1, 2, 3))
        or (now_chi.month == 4 and now_chi.day == 1)
    )

    if conn is not None:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT ward_section
                FROM raw_sweeping_schedule
                WHERE sweep_date = %s
                """,
                (today_str,),
            )
            sweeping_sections = [row[0] for row in cur.fetchall()]
    else:
        sweeping_sections = default_sections or ["35-04", "01-02", "43-01"]

    payload = {
        "generatedAt": now_chi.isoformat(),
        "timezone": "America/Chicago",
        "isWinterBanSeason": is_winter_season,
        "winterBanHours": {"startSlot": 12, "endSlot": 28, "label": "3:00 AM – 7:00 AM"},
        "isTwoInchSnowBanActive": False,  # Toggled via City of Chicago OEMC webhook/alert
        "activeSweepingWardSectionsToday": sweeping_sections,
        "sweepingHours": {"startSlot": 36, "endSlot": 56, "label": "9:00 AM – 2:00 PM"},
    }

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))

    return payload


def build_pmtiles_from_postgis(db_url: str, output_pmtiles: str) -> None:
    """
    Exports compiled curb segments from PostGIS to GeoJSONSeq and runs Tippecanoe
    to generate a single serverless PMTiles archive for the frontend map.
    """
    geojson_tmp = "/tmp/chicago_curbs.geojson"
    sql_query = """
        SELECT
            curb_id,
            full_street_name AS name,
            side_of_street AS side,
            odd_even AS parity,
            addr_low || '-' || addr_high AS addr,
            COALESCE(permit_zone, '') AS p_zone,
            winter_ban AS w_ban,
            snow_route AS s_route,
            COALESCE(ward_section, '') AS w_sec,
            encode(substring(weekly_free_mask::bytea from 1), 'hex') AS mask_hex,
            geom
        FROM curb_segments
    """
    # Use ogr2ogr to stream PostGIS directly into newline-delimited GeoJSON
    subprocess.run(
        [
            "ogr2ogr",
            "-f",
            "GeoJSONSeq",
            geojson_tmp,
            f"PG:{db_url}",
            "-sql",
            sql_query,
        ],
        check=True,
    )

    # Build PMTiles with Tippecanoe (zooms 11 to 18, keeping curb attributes intact)
    subprocess.run(
        [
            "tippecanoe",
            "-o",
            output_pmtiles,
            "-l",
            "chicago_curbs",
            "--minimum-zoom=11",
            "--maximum-zoom=18",
            "--read-parallel",
            "--drop-densest-as-needed",
            "--force",
            geojson_tmp,
        ],
        check=True,
    )


def offset_linestring_coords(
    coords: list[list[float]], side: str, offset_meters: float = 7.0
) -> list[list[float]]:
    """
    Offsets a WGS84 LineString laterally to the Left ('L') or Right ('R') by `offset_meters`,
    accounting for Chicago's latitude (~41.88° N) and trimming block ends slightly so intersections stay crisp.
    """
    if len(coords) < 2:
        return coords

    cos_lat = math.cos(math.radians(41.88))
    deg_per_meter_lat = 1.0 / 111111.0
    deg_per_meter_lng = 1.0 / (111111.0 * cos_lat)

    p0, p1 = coords[0], coords[-1]
    dx_m = (p1[0] - p0[0]) / deg_per_meter_lng
    dy_m = (p1[1] - p0[1]) / deg_per_meter_lat
    length_m = math.hypot(dx_m, dy_m)
    if length_m < 1e-3:
        return coords

    # Unit direction vector
    ux = dx_m / length_m
    uy = dy_m / length_m

    # Left normal is (-uy, ux); Right normal is (uy, -ux)
    sign = 1.0 if side == "L" else -1.0
    nx = -uy * sign
    ny = ux * sign

    # Trim 8% from each block end so perpendicular intersections don't overlap
    trim_ratio = 0.08
    out_coords: list[list[float]] = []
    for idx, (lng, lat) in enumerate(coords):
        if idx == 0 and len(coords) == 2:
            lng = p0[0] + (p1[0] - p0[0]) * trim_ratio
            lat = p0[1] + (p1[1] - p0[1]) * trim_ratio
        elif idx == len(coords) - 1 and len(coords) == 2:
            lng = p1[0] - (p1[0] - p0[0]) * trim_ratio
            lat = p1[1] - (p1[1] - p0[1]) * trim_ratio

        shifted_lng = round(lng + nx * offset_meters * deg_per_meter_lng, 6)
        shifted_lat = round(lat + ny * offset_meters * deg_per_meter_lat, 6)
        out_coords.append([shifted_lng, shifted_lat])

    return out_coords


def get_lake_michigan_shore_lng(lat: float) -> float:
    """
    Piecewise linear approximation of Chicago's Lake Michigan shoreline longitude
    for a given latitude (from 41.70° N South Shore to 42.025° N Rogers Park).
    Prevents East-West and North-South streets from extending into Lake Michigan.
    """
    shore_points = [
        (41.700, -87.525),
        (41.751, -87.547),  # 79th St / Rainbow Beach
        (41.794, -87.576),  # 55th St / Promontory Point (Hyde Park)
        (41.831, -87.598),  # 31st St Harbor
        (41.853, -87.608),  # McCormick Place / 18th St
        (41.867, -87.614),  # Museum Campus / Roosevelt
        (41.882, -87.614),  # Madison St / Monroe Harbor
        (41.892, -87.612),  # Navy Pier / Grand Ave
        (41.911, -87.624),  # North Ave Beach
        (41.926, -87.631),  # Fullerton Beach
        (41.940, -87.636),  # Belmont Harbor
        (41.963, -87.638),  # Montrose Beach
        (41.980, -87.652),  # Foster Beach / Edgewater
        (42.005, -87.657),  # Loyola / Rogers Park
        (42.025, -87.665),  # Howard St / Evanston border
    ]
    if lat <= shore_points[0][0]:
        return shore_points[0][1]
    if lat >= shore_points[-1][0]:
        return shore_points[-1][1]
    for i in range(len(shore_points) - 1):
        lat0, lng0 = shore_points[i]
        lat1, lng1 = shore_points[i + 1]
        if lat0 <= lat <= lat1:
            t = (lat - lat0) / (lat1 - lat0)
            return lng0 + t * (lng1 - lng0) - 0.0015
    return -87.620


def classify_chicago_neighborhood(ew_val: int, ns_val: int) -> tuple[str, str]:
    """
    Maps Chicago grid coordinates (ew_val: negative=West, positive=East; ns_val: positive=North, negative=South)
    to a Chicago neighborhood name and representative Ward-Section ID.
    """
    if ns_val >= 6400:
        return ("Rogers Park", "49-01") if ew_val > -2400 else ("West Ridge", "50-02")
    if ns_val >= 5200:
        if ew_val > -1600:
            return ("Edgewater / Andersonville", "48-01")
        if ew_val > -3200:
            return ("Lincoln Square", "40-02")
        return ("Albany Park / Jefferson Park", "39-01")
    if ns_val >= 4000:
        if ew_val > -1400:
            return ("Uptown", "46-01")
        if ew_val > -2600:
            return ("Ravenswood / North Center", "47-02")
        return ("Irving Park / Portage Park", "45-01")
    if ns_val >= 2800:
        if ew_val > -1800:
            return ("Lakeview / Wrigleyville", "44-01")
        if ew_val > -2800:
            return ("Roscoe Village / Avondale", "32-02")
        return ("Avondale / Belmont Cragin", "35-02")
    if ns_val >= 1600:
        if ew_val > -1600:
            return ("Lincoln Park", "43-01")
        if ew_val > -2600:
            return ("Bucktown", "32-01")
        return ("Logan Square", "35-04")
    if ns_val >= 400:
        if ew_val > -800:
            return ("River North / Old Town", "42-02")
        if ew_val > -2600:
            return ("Wicker Park / West Town", "01-02")
        return ("Humboldt Park / Garfield Park", "26-01")
    if ns_val >= -1200:
        if ew_val > -500:
            return ("The Loop / Downtown", "42-01")
        if ew_val > -1800:
            return ("West Loop / Fulton Market", "27-03")
        return ("Near West / Medical District", "28-01")
    if ns_val >= -2600:
        if ew_val > -600:
            return ("South Loop / Chinatown", "03-01")
        if ew_val > -2400:
            return ("Pilsen", "25-01")
        return ("Little Village / Lawndale", "22-01")
    if ns_val >= -4700:
        if ew_val > -800:
            return ("Bronzeville", "04-01")
        if ew_val > -2400:
            return ("Bridgeport / McKinley Park", "11-01")
        return ("Brighton Park / Archer Heights", "12-01")
    if ns_val >= -6300:
        if ew_val > 400:
            return ("Hyde Park / Kenwood", "05-02")
        if ew_val > -1600:
            return ("Washington Park / Englewood", "20-01")
        return ("Gage Park / Midway", "14-01")
    return ("South Shore / Woodlawn", "07-01") if ew_val >= 0 else ("Chatham / Auburn Gresham", "06-01")


def generate_chicago_curb_dataset() -> dict[str, Any]:
    """
    Compiles a city-wide set of Chicago Left/Right street curb segments covering all major
    and neighborhood streets across the entire City of Chicago (7600 N to 7900 S, Lakefront to 5600 W),
    complete with 672-bit hex schedule masks, address parities, permit zones, winter bans, and sweeping sections.
    """
    # Pre-compile common Chicago restriction masks:
    mask_free_24_7 = ALL_FREE_MASK
    mask_permit_evening = build_bitmask_from_restriction([0, 1, 2, 3, 4, 5, 6], 18, 0, 6, 0)
    mask_permit_24_7 = 0
    mask_weekday_daytime = build_bitmask_from_restriction([1, 2, 3, 4, 5], 8, 0, 18, 0)
    mask_meter_8am_10pm = build_bitmask_from_restriction([1, 2, 3, 4, 5, 6], 8, 0, 22, 0)
    mask_meter_9am_8pm = build_bitmask_from_restriction([1, 2, 3, 4, 5, 6], 9, 0, 20, 0)
    mask_meter_daily = build_bitmask_from_restriction([0, 1, 2, 3, 4, 5, 6], 8, 0, 22, 0)
    mask_rush_hour = combine_restriction_masks(
        build_bitmask_from_restriction([1, 2, 3, 4, 5], 7, 0, 9, 0),
        build_bitmask_from_restriction([1, 2, 3, 4, 5], 16, 0, 18, 0),
    )

    # Baseline origin: State St (0 E/W) & Madison St (0 N/S)
    BASE_LAT = 41.88194
    BASE_LNG = -87.62778
    DEG_LAT_PER_100 = 0.014492 / 8.0   # 800 address units = 1 mile N/S
    DEG_LNG_PER_100 = 0.019390 / 8.0   # 800 address units = 1 mile E/W

    def ns_to_lat(ns_addr: float) -> float:
        return round(BASE_LAT + (ns_addr / 100.0) * DEG_LAT_PER_100, 6)

    def ew_to_lng(ew_addr: float) -> float:
        return round(BASE_LNG + (ew_addr / 100.0) * DEG_LNG_PER_100, 6)

    # City-wide East-West streets: (ns_coord, base_name, suffix, rule_type)
    # Positive ns_coord = North of Madison; Negative ns_coord = South of Madison
    ew_streets_citywide: list[tuple[int, str, str, str]] = [
        (7600, "HOWARD", "ST", "commercial_9_8"),
        (7400, "FARGO", "AVE", "res_free_both"),
        (7200, "TOUHY", "AVE", "res_split_permit_49"),
        (7000, "LUNT", "AVE", "res_free_both"),
        (6800, "PRATT", "BLVD", "boulevard_free_sweeping"),
        (6600, "ALBION", "AVE", "res_split_permit_49"),
        (6400, "DEVON", "AVE", "commercial_8_10"),
        (6200, "GRANVILLE", "AVE", "res_free_both"),
        (6000, "PETERSON", "AVE", "rush_hour"),
        (5800, "ARDMORE", "AVE", "res_free_both"),
        (5600, "BRYN MAWR", "AVE", "commercial_9_8"),
        (5400, "BALMORAL", "AVE", "res_split_permit_48"),
        (5200, "FOSTER", "AVE", "rush_hour"),
        (5000, "ARGYLE", "ST", "commercial_9_8"),
        (4800, "LAWRENCE", "AVE", "commercial_8_10"),
        (4700, "LELAND", "AVE", "res_free_both"),
        (4600, "WILSON", "AVE", "res_split_permit_46"),
        (4500, "SUNNYSIDE", "AVE", "res_free_both"),
        (4400, "MONTROSE", "AVE", "commercial_9_8"),
        (4300, "CULLOM", "AVE", "res_split_permit_47"),
        (4200, "BERTEAU", "AVE", "res_free_both"),
        (4100, "BELLE PLAINE", "AVE", "res_free_both"),
        (4000, "IRVING PARK", "RD", "commercial_8_10"),
        (3900, "BYRON", "ST", "res_split_permit_383"),
        (3800, "GRACE", "ST", "res_split_permit_383"),
        (3700, "WAVELAND", "AVE", "res_evening_permit_383"),
        (3600, "ADDISON", "ST", "res_evening_permit_383"),
        (3500, "CORNELIA", "AVE", "res_split_permit_383"),
        (3400, "ROSCOE", "ST", "res_split_permit_383"),
        (3300, "SCHOOL", "ST", "res_free_both"),
        (3200, "BELMONT", "AVE", "commercial_8_10"),
        (3100, "BARRY", "AVE", "res_split_permit_383"),
        (3000, "WELLINGTON", "AVE", "res_split_permit_143"),
        (2900, "OAKDALE", "AVE", "res_free_both"),
        (2800, "DIVERSEY", "PKWY", "commercial_8_10"),
        (2700, "SCHUBERT", "AVE", "res_split_permit_95"),
        (2600, "WRIGHTWOOD", "AVE", "res_free_both"),
        (2500, "DEMING", "PL", "res_split_permit_143"),
        (2400, "FULLERTON", "AVE", "commercial_9_8"),
        (2300, "BELDEN", "AVE", "res_split_permit_100"),
        (2200, "WEBSTER", "AVE", "res_free_both"),
        (2100, "DICKENS", "AVE", "res_split_permit_143"),
        (2000, "ARMITAGE", "AVE", "commercial_9_8"),
        (1900, "CORTLAND", "ST", "res_free_both"),
        (1800, "WILLOW", "ST", "res_split_permit_143"),
        (1700, "WABANSIA", "AVE", "res_free_both"),
        (1600, "NORTH", "AVE", "commercial_8_10"),
        (1500, "LE MOYNE", "ST", "res_split_permit_154"),
        (1400, "SCHILLER", "ST", "res_free_both"),
        (1300, "EVERGREEN", "AVE", "res_split_permit_154"),
        (1200, "DIVISION", "ST", "commercial_8_10"),
        (1100, "THOMAS", "ST", "res_free_both"),
        (1000, "AUGUSTA", "BLVD", "boulevard_free_sweeping"),
        (900, "WALTON", "ST", "res_split_permit_102"),
        (800, "CHICAGO", "AVE", "commercial_8_10"),
        (700, "HURON", "ST", "res_free_both"),
        (600, "OHIO", "ST", "rush_hour"),
        (500, "GRAND", "AVE", "commercial_9_8"),
        (400, "KINZIE", "ST", "res_free_both"),
        (300, "FULTON MARKET", "", "commercial_daily"),
        (200, "LAKE", "ST", "commercial_9_8"),
        (100, "RANDOLPH", "ST", "commercial_daily"),
        (50, "WASHINGTON", "BLVD", "rush_hour"),
        (0, "MADISON", "ST", "commercial_8_10"),
        (-100, "MONROE", "ST", "commercial_9_8"),
        (-200, "ADAMS", "ST", "commercial_8_10"),
        (-300, "JACKSON", "BLVD", "rush_hour"),
        (-400, "VAN BUREN", "ST", "commercial_9_8"),
        (-500, "CONGRESS", "PKWY", "rush_hour"),
        (-600, "HARRISON", "ST", "commercial_9_8"),
        (-800, "POLK", "ST", "res_split_permit_5"),
        (-1000, "TAYLOR", "ST", "commercial_9_8"),
        (-1200, "ROOSEVELT", "RD", "commercial_8_10"),
        (-1400, "14TH", "ST", "res_free_both"),
        (-1600, "16TH", "ST", "res_free_both"),
        (-1800, "18TH", "ST", "commercial_9_8"),
        (-1900, "19TH", "ST", "res_free_both"),
        (-2100, "21ST", "ST", "res_split_permit_25"),
        (-2200, "CERMAK", "RD", "commercial_8_10"),
        (-2400, "24TH", "ST", "res_free_both"),
        (-2600, "26TH", "ST", "commercial_8_10"),
        (-2900, "29TH", "ST", "res_free_both"),
        (-3100, "31ST", "ST", "commercial_9_8"),
        (-3300, "33RD", "ST", "res_free_both"),
        (-3500, "35TH", "ST", "commercial_9_8"),
        (-3700, "37TH", "ST", "res_free_both"),
        (-3900, "PERSHING", "RD", "rush_hour"),
        (-4300, "43RD", "ST", "res_free_both"),
        (-4700, "47TH", "ST", "commercial_9_8"),
        (-5100, "HYDE PARK", "BLVD", "boulevard_free_sweeping"),
        (-5300, "53RD", "ST", "commercial_8_10"),
        (-5500, "55TH", "ST", "commercial_9_8"),
        (-5700, "57TH", "ST", "res_split_permit_5"),
        (-5900, "59TH", "ST", "res_free_both"),
        (-6100, "61ST", "ST", "res_free_both"),
        (-6300, "63RD", "ST", "commercial_8_10"),
        (-6700, "67TH", "ST", "res_free_both"),
        (-7100, "71ST", "ST", "commercial_9_8"),
        (-7500, "75TH", "ST", "res_free_both"),
        (-7900, "79TH", "ST", "commercial_8_10"),
        (-8300, "83RD", "ST", "res_free_both"),
        (-8700, "87TH", "ST", "commercial_9_8"),
        (-9500, "95TH", "ST", "commercial_8_10"),
    ]

    # City-wide North-South streets: (ew_coord, base_name, suffix, rule_type, min_ns, max_ns)
    # Negative ew_coord = West of State; Positive ew_coord = East of State
    ns_streets_citywide: list[tuple[int, str, str, str, int, int]] = [
        (1600, "STONY ISLAND", "AVE", "rush_hour", -9500, -5600),
        (1500, "LAKE PARK", "AVE", "commercial_9_8", -5700, -4700),
        (1400, "DORCHESTER", "AVE", "res_free_both", -8700, -4700),
        (1300, "KIMBARK", "AVE", "res_free_both", -7900, -4700),
        (1200, "WOODLAWN", "AVE", "res_split_permit_5", -8700, -4700),
        (1100, "UNIVERSITY", "AVE", "res_free_both", -7900, -4700),
        (1000, "ELLIS", "AVE", "weekday_commuter", -8700, -3500),
        (900, "DREXEL", "BLVD", "boulevard_free_sweeping", -8700, -3900),
        (800, "COTTAGE GROVE", "AVE", "commercial_9_8", -9500, -2200),
        (600, "CHAMPLAIN", "AVE", "res_free_both", -7900, -4300),
        (400, "KING", "DR", "boulevard_free_sweeping", -9500, -2200),
        (200, "INDIANA", "AVE", "res_free_both", -8700, -1200),
        (100, "MICHIGAN", "AVE", "commercial_daily", -9500, 1000),
        (50, "WABASH", "AVE", "commercial_8_10", -6300, 800),
        (0, "STATE", "ST", "commercial_8_10", -9500, 1200),
        (-50, "DEARBORN", "ST", "commercial_9_8", -5500, 1600),
        (-100, "CLARK", "ST", "commercial_8_10", -2200, 7600),
        (-150, "LASALLE", "DR", "rush_hour", -3500, 1600),
        (-200, "WELLS", "ST", "commercial_8_10", -5500, 1800),
        (-200, "WENTWORTH", "AVE", "commercial_9_8", -7900, -1800),
        (-300, "ORLEANS", "ST", "res_split_permit_143", 300, 2000),
        (-350, "WACKER", "DR", "commercial_daily", -400, 300),
        (-400, "SEDGWICK", "ST", "res_split_permit_143", 600, 2400),
        (-500, "CANAL", "ST", "commercial_9_8", -3500, 400),
        (-600, "LARRABEE", "ST", "res_free_both", 600, 2400),
        (-600, "WALLACE", "ST", "res_free_both", -6300, -2400),
        (-700, "ORCHARD", "ST", "res_split_permit_143", 1600, 2800),
        (-800, "HALSTED", "ST", "commercial_8_10", -9500, 4800),
        (-900, "PEORIA", "ST", "res_free_both", -5500, 800),
        (-900, "FREMONT", "ST", "res_split_permit_143", 1600, 4000),
        (-1000, "MORGAN", "ST", "commercial_9_8", -7900, 800),
        (-1000, "SHEFFIELD", "AVE", "commercial_9_8", 1600, 4000),
        (-1100, "SEMINARY", "AVE", "res_split_permit_143", 2000, 4000),
        (-1200, "RACINE", "AVE", "res_free_both", -8700, 4800),
        (-1300, "THROOP", "ST", "res_free_both", -6300, 1800),
        (-1400, "LOOMIS", "ST", "res_free_both", -7900, 800),
        (-1400, "SOUTHPORT", "AVE", "commercial_9_8", 2000, 4400),
        (-1500, "GREENVIEW", "AVE", "res_split_permit_383", 1200, 7600),
        (-1600, "ASHLAND", "AVE", "rush_hour", -9500, 7600),
        (-1700, "PAULINA", "ST", "res_free_both", -7900, 7600),
        (-1800, "WOOD", "ST", "res_split_permit_102", -7100, 2400),
        (-1800, "RAVENSWOOD", "AVE", "res_free_both", 3200, 6400),
        (-1900, "WOLCOTT", "AVE", "res_free_both", -7100, 5600),
        (-2000, "DAMEN", "AVE", "commercial_8_10", -8700, 7600),
        (-2100, "HOYNE", "AVE", "res_evening_permit_154", -6300, 6400),
        (-2200, "LEAVITT", "ST", "res_split_permit_154", -6300, 6400),
        (-2300, "OAKLEY", "BLVD", "res_free_both", -6300, 6400),
        (-2400, "WESTERN", "AVE", "rush_hour", -9500, 7600),
        (-2500, "CAMPBELL", "AVE", "res_free_both", -6300, 6400),
        (-2600, "ROCKWELL", "ST", "res_free_both", -6300, 6400),
        (-2700, "WASHTENAW", "AVE", "res_split_permit_100", -5500, 6400),
        (-2800, "CALIFORNIA", "AVE", "commercial_9_8", -7100, 7200),
        (-2900, "FRANCISCO", "AVE", "res_free_both", -5500, 6800),
        (-3000, "SACRAMENTO", "BLVD", "boulevard_free_sweeping", -6300, 6800),
        (-3100, "ALBANY", "AVE", "res_free_both", -5500, 6400),
        (-3200, "KEDZIE", "AVE", "commercial_8_10", -8700, 7200),
        (-3300, "SPAULDING", "AVE", "res_split_permit_100", -5500, 6000),
        (-3400, "KIMBALL", "AVE", "commercial_9_8", 1600, 6400),
        (-3400, "HOMAN", "AVE", "res_free_both", -3100, 1600),
        (-3500, "ST LOUIS", "AVE", "res_free_both", -5500, 6000),
        (-3600, "CENTRAL PARK", "AVE", "res_free_both", -6300, 6000),
        (-3800, "HAMLIN", "AVE", "res_split_permit_100", -5500, 5600),
        (-4000, "PULASKI", "RD", "commercial_8_10", -8700, 6400),
        (-4200, "KEELER", "AVE", "res_free_both", -5500, 5600),
        (-4400, "KOSTNER", "AVE", "res_free_both", -6300, 5600),
        (-4800, "CICERO", "AVE", "rush_hour", -8700, 6400),
        (-5200, "LARAMIE", "AVE", "res_free_both", -1200, 5200),
        (-5600, "CENTRAL", "AVE", "commercial_9_8", -1200, 5600),
    ]

    blocks_spec: list[dict[str, Any]] = []

    # 1. Build East-West street blocks across Chicago
    ew_breaks = [-5600, -4800, -4000, -3400, -3200, -2800, -2400, -2000, -1600, -1200, -800, -400, 0, 400, 800, 1200, 1600]
    for ns_val, base_name, suffix, rule_type in ew_streets_citywide:
        lat = ns_to_lat(ns_val)
        shore_lng = get_lake_michigan_shore_lng(lat)
        west_limit = -5600 if ns_val >= -4700 else -4000

        for i in range(len(ew_breaks) - 1):
            ew0 = ew_breaks[i]
            ew1 = ew_breaks[i + 1]
            if ew0 < west_limit:
                continue
            lng0 = ew_to_lng(ew0)
            lng1 = ew_to_lng(ew1)
            if lng0 >= shore_lng:
                continue
            if lng1 > shore_lng:
                lng1 = round(shore_lng, 6)
            if abs(lng1 - lng0) < 0.0012:
                continue

            mid_ew = (ew0 + ew1) // 2
            dir_prefix = "E" if mid_ew >= 0 else "W"
            full_name = f"{dir_prefix} {base_name}" + (f" {suffix}" if suffix else "")
            addr_low_num = min(abs(ew0), abs(ew1))
            addr_high_num = max(abs(ew0), abs(ew1))
            neigh, ward_sec = classify_chicago_neighborhood(mid_ew, ns_val)

            blocks_spec.append(
                {
                    "neighborhood": neigh,
                    "name": full_name,
                    "coords": [[lng0, lat], [lng1, lat]],
                    "addr_low": addr_low_num,
                    "addr_high": max(addr_low_num + 98, addr_high_num - 2),
                    "rule_type": rule_type,
                    "w_sec": ward_sec,
                }
            )

    # 2. Build North-South street blocks across Chicago
    ns_breaks = [
        -7900, -7100, -6300, -5500, -4700, -3900, -3100, -2200, -1200, -600,
        0, 400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4400, 4800, 5200, 5600, 6400, 7200, 7600
    ]
    for ew_val, base_name, suffix, rule_type, min_ns, max_ns in ns_streets_citywide:
        lng = ew_to_lng(ew_val)
        for i in range(len(ns_breaks) - 1):
            ns0 = ns_breaks[i]
            ns1 = ns_breaks[i + 1]
            if ns0 < min_ns or ns1 > max_ns:
                continue
            lat0 = ns_to_lat(ns0)
            lat1 = ns_to_lat(ns1)
            # Ensure block is west of Lake Michigan shoreline
            if lng > get_lake_michigan_shore_lng((lat0 + lat1) * 0.5):
                continue

            mid_ns = (ns0 + ns1) // 2
            dir_prefix = "N" if mid_ns >= 0 else "S"
            full_name = f"{dir_prefix} {base_name}" + (f" {suffix}" if suffix else "")
            addr_low_num = min(abs(ns0), abs(ns1))
            addr_high_num = max(abs(ns0), abs(ns1))
            neigh, ward_sec = classify_chicago_neighborhood(ew_val, mid_ns)

            blocks_spec.append(
                {
                    "neighborhood": neigh,
                    "name": full_name,
                    "coords": [[lng, lat0], [lng, lat1]],
                    "addr_low": addr_low_num,
                    "addr_high": max(addr_low_num + 98, addr_high_num - 2),
                    "rule_type": rule_type,
                    "w_sec": ward_sec,
                }
            )

    # 3. Add Major Chicago Diagonal Corridors (Milwaukee, Lincoln, Clybourn, Elston, Ogden, Archer, Blue Island, Broadway)
    diagonals = [
        ("N MILWAUKEE AVE", "commercial_8_10", [
            (-500, 400, 400, 800), (-800, 800, 800, 1200), (-1200, 1200, 1200, 1600),
            (-1600, 1600, 1600, 2000), (-2000, 2000, 2000, 2400), (-2400, 2400, 2400, 2800),
            (-2900, 2800, 2800, 3200), (-3400, 3200, 3200, 4000), (-4000, 4000, 4000, 4800),
        ]),
        ("N LINCOLN AVE", "commercial_9_8", [
            (-300, 1800, 1800, 2400), (-800, 2400, 2400, 3200), (-1600, 3200, 3200, 4000),
            (-2000, 4000, 4000, 4800), (-2400, 4800, 4800, 5600),
        ]),
        ("N CLYBOURN AVE", "commercial_9_8", [
            (-400, 1200, 1200, 2000), (-1200, 2000, 2000, 2800), (-2000, 2800, 2800, 3200),
        ]),
        ("N BROADWAY", "commercial_8_10", [
            (-600, 2800, 2800, 3600), (-800, 3600, 3600, 4400), (-1000, 4400, 4400, 5200),
            (-1200, 5200, 5200, 6400),
        ]),
        ("W OGDEN AVE", "rush_hour", [
            (-1400, 100, 1400, 2000), (-2200, -600, 2000, 2800), (-3200, -1600, 2800, 3800),
        ]),
        ("S ARCHER AVE", "commercial_9_8", [
            (-200, -1800, 1800, 2400), (-1200, -2400, 2400, 3100), (-2400, -3500, 3100, 3900),
            (-3600, -4300, 3900, 4700),
        ]),
        ("S BLUE ISLAND AVE", "commercial_9_8", [
            (-1000, -1200, 1200, 1800), (-1600, -1800, 1800, 2400),
        ]),
    ]
    for diag_name, diag_rule, segs in diagonals:
        for idx, (ew_start, ns_start, addr_l, addr_h) in enumerate(segs):
            ew_end = segs[idx + 1][0] if idx + 1 < len(segs) else ew_start - 600
            ns_end = segs[idx + 1][1] if idx + 1 < len(segs) else ns_start + (600 if ns_start >= 0 else -600)
            neigh, ward_sec = classify_chicago_neighborhood(ew_start, ns_start)
            blocks_spec.append(
                {
                    "neighborhood": neigh,
                    "name": diag_name,
                    "coords": [[ew_to_lng(ew_start), ns_to_lat(ns_start)], [ew_to_lng(ew_end), ns_to_lat(ns_end)]],
                    "addr_low": addr_l,
                    "addr_high": addr_h - 2,
                    "rule_type": diag_rule,
                    "w_sec": ward_sec,
                }
            )

    features: list[dict[str, Any]] = []
    curb_id = 1000

    for block in blocks_spec:
        rule = block["rule_type"]
        addr_low = block["addr_low"]
        addr_high = block["addr_high"]

        # Create Left ('L' / Odd) and Right ('R' / Even) physical curb segments
        for side, parity, addr_range in [
            ("L", "O", f"{addr_low + 1}-{addr_high + 1}"),
            ("R", "E", f"{addr_low}-{addr_high}"),
        ]:
            curb_id += 1
            offset_coords = offset_linestring_coords(block["coords"], side, offset_meters=6.5)

            p_zone = ""
            w_ban = False
            s_route = False
            w_sec = block["w_sec"]
            mask = mask_free_24_7

            if rule == "res_free_both":
                mask = mask_free_24_7
                w_sec = block["w_sec"] if side == "L" else ""
            elif rule.startswith("res_split_permit_"):
                zone_num = rule.split("_")[-1]
                if side == "L":
                    p_zone = zone_num
                    mask = mask_permit_evening
                else:
                    p_zone = ""
                    mask = mask_free_24_7
            elif rule.startswith("res_evening_permit_"):
                zone_num = rule.split("_")[-1]
                p_zone = zone_num
                mask = mask_permit_evening if side == "L" else mask_permit_24_7
            elif rule == "commercial_8_10":
                w_ban = True
                s_route = True
                mask = mask_meter_8am_10pm
            elif rule == "commercial_9_8":
                s_route = True
                mask = mask_meter_9am_8pm if side == "L" else mask_free_24_7
            elif rule == "commercial_daily":
                mask = mask_meter_daily if side == "L" else mask_meter_9am_8pm
            elif rule == "rush_hour":
                w_ban = True
                s_route = True
                mask = mask_rush_hour if side == "L" else mask_free_24_7
            elif rule == "weekday_commuter":
                if side == "L":
                    mask = mask_weekday_daytime
                    p_zone = "27"
                else:
                    mask = mask_free_24_7
            elif rule == "boulevard_free_sweeping":
                mask = mask_free_24_7
                w_sec = block["w_sec"]

            mask_hex_str = int_mask_to_hex(mask)
            # Compact schedule key for O(1) GPU WebGL match expression styling
            sched_key = f"{rule}:{side}:{w_sec}:{1 if w_ban else 0}:{1 if s_route else 0}"

            features.append(
                {
                    "type": "Feature",
                    "id": curb_id,
                    "properties": {
                        "curb_id": curb_id,
                        "name": block["name"],
                        "neighborhood": block["neighborhood"],
                        "side": side,
                        "parity": parity,
                        "addr": addr_range,
                        "addr_low": addr_low + (1 if parity == "O" else 0),
                        "addr_high": addr_high + (1 if parity == "O" else 0),
                        "p_zone": p_zone,
                        "w_ban": w_ban,
                        "s_route": s_route,
                        "w_sec": w_sec,
                        "sched_key": sched_key,
                        "mask_hex": mask_hex_str,
                    },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": offset_coords,
                    },
                }
            )

    return {
        "type": "FeatureCollection",
        "metadata": {
            "generatedAt": datetime.now(CHICAGO_TZ).isoformat(),
            "totalCurbSegments": len(features),
            "slotResolutionMinutes": 15,
            "totalWeeklySlots": TOTAL_WEEKLY_SLOTS,
        },
        "features": features,
    }


def sync_socrata_to_postgis(conn: Any) -> int:
    """
    Pulls Chicago Socrata Open Data datasets (centerlines, permit zones, sweeping zones/schedules),
    loads them into PostGIS staging tables, splits street blocks into Left ('L') and Right ('R')
    curb segments in EPSG:3435, resolves Odd/Even address parities, and compiles 672-bit weekly masks.
    Returns the total number of compiled curb segments inserted.
    """
    centerlines = fetch_socrata_dataset(
        DATASETS["centerlines"],
        select_clause="trans_id,pre_dir,street_nam,street_typ,suf_dir,l_f_add,l_t_add,r_f_add,r_t_add,class,the_geom",
    )
    permit_zones = fetch_socrata_dataset(
        DATASETS["permit_zones"],
        where_clause="status='ACTIVE'",
    )
    sweeping_schedules = fetch_socrata_dataset(DATASETS["sweeping_schedule"])

    with conn.cursor() as cur:
        # 1. Load raw street centerlines
        for row in centerlines:
            geom_json = json.dumps(row.get("the_geom")) if row.get("the_geom") else None
            if not geom_json:
                continue
            parts = [row.get("pre_dir"), row.get("street_nam"), row.get("street_typ"), row.get("suf_dir")]
            full_name = " ".join(p.strip() for p in parts if p and p.strip())
            cur.execute(
                """
                INSERT INTO raw_street_centerlines (
                    trans_id, pre_dir, street_nam, street_typ, suf_dir, full_street_name,
                    l_f_add, l_t_add, r_f_add, r_t_add, class, geom_4326, geom_3435
                ) VALUES (
                    %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326),
                    ST_Transform(ST_LineMerge(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)), 3435)
                )
                ON CONFLICT (trans_id) DO UPDATE SET
                    full_street_name = EXCLUDED.full_street_name,
                    geom_4326 = EXCLUDED.geom_4326,
                    geom_3435 = EXCLUDED.geom_3435
                """,
                (
                    int(row["trans_id"]),
                    row.get("pre_dir"),
                    row.get("street_nam", ""),
                    row.get("street_typ"),
                    row.get("suf_dir"),
                    full_name,
                    int(row.get("l_f_add") or 0),
                    int(row.get("l_t_add") or 0),
                    int(row.get("r_f_add") or 0),
                    int(row.get("r_t_add") or 0),
                    row.get("class"),
                    geom_json,
                    geom_json,
                ),
            )

        # 2. Load raw permit zones
        for pz in permit_zones:
            row_id = str(pz.get("row_id") or f"{pz.get('zone')}-{pz.get('address_range_low')}")
            cur.execute(
                """
                INSERT INTO raw_permit_zones (
                    row_id, status, zone, odd_even, address_range_low, address_range_high,
                    street_direction, street_name, street_type, schedule_text
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (row_id) DO UPDATE SET
                    zone = EXCLUDED.zone,
                    schedule_text = EXCLUDED.schedule_text
                """,
                (
                    row_id,
                    pz.get("status", "ACTIVE"),
                    str(pz.get("zone", "")),
                    str(pz.get("odd_even", "B"))[:1],
                    int(pz.get("address_range_low") or 0),
                    int(pz.get("address_range_high") or 0),
                    pz.get("street_direction"),
                    pz.get("street_name", ""),
                    pz.get("street_type"),
                    pz.get("schedule_text", "DAILY 6:00 PM - 6:00 AM"),
                ),
            )

        # 3. Load sweeping schedules
        for sw in sweeping_schedules:
            ward = str(sw.get("ward", "")).strip()
            section = str(sw.get("section", "")).strip()
            sweep_date = str(sw.get("sweep_date", ""))[:10]
            if ward and section and sweep_date:
                cur.execute(
                    """
                    INSERT INTO raw_sweeping_schedule (ward, section, sweep_date)
                    VALUES (%s, %s, %s)
                    """,
                    (ward, section, sweep_date),
                )

        # 4. Split centerlines into Left ('L') and Right ('R') curbs and match permit zones
        cur.execute("TRUNCATE TABLE curb_segments RESTART IDENTITY")
        cur.execute(
            """
            SELECT
                c.trans_id, c.full_street_name, c.pre_dir, c.street_nam,
                c.l_f_add, c.l_t_add, c.r_f_add, c.r_t_add
            FROM raw_street_centerlines c
            WHERE (c.l_f_add > 0 OR c.r_f_add > 0)
            """
        )
        blocks = cur.fetchall()
        inserted_count = 0

        for (
            trans_id,
            full_street_name,
            pre_dir,
            street_nam,
            l_f_add,
            l_t_add,
            r_f_add,
            r_t_add,
        ) in blocks:
            for side, f_add, t_add in [("L", l_f_add, l_t_add), ("R", r_f_add, r_t_add)]:
                if not f_add or not t_add:
                    continue
                addr_low = min(f_add, t_add)
                addr_high = max(f_add, t_add)
                parity = "O" if (addr_low % 2 == 1) else "E"

                cur.execute(
                    """
                    SELECT zone, schedule_text
                    FROM raw_permit_zones
                    WHERE street_name = %s
                      AND (street_direction = %s OR street_direction IS NULL)
                      AND (odd_even = %s OR odd_even = 'B')
                      AND address_range_low <= %s
                      AND address_range_high >= %s
                    LIMIT 1
                    """,
                    (street_nam, pre_dir, parity, addr_high, addr_low),
                )
                pz_match = cur.fetchone()
                if pz_match:
                    p_zone = pz_match[0]
                    mask = parse_schedule_text_to_bitmask(
                        pz_match[1] or "DAILY 6:00 PM - 6:00 AM"
                    )
                else:
                    p_zone = None
                    mask = ALL_FREE_MASK

                bit_str = int_mask_to_bitstring(mask)
                hex_str = int_mask_to_hex(mask)

                cur.execute(
                    """
                    INSERT INTO curb_segments (
                        trans_id, full_street_name, side_of_street, odd_even,
                        addr_low, addr_high, permit_zone, weekly_free_mask, mask_hex, geom
                    )
                    SELECT
                        %s, %s, %s, %s, %s, %s, %s,
                        %s::bit(672), %s,
                        generate_curb_offset_geom(geom_4326, %s, 18.0)
                    FROM raw_street_centerlines
                    WHERE trans_id = %s
                    """,
                    (
                        trans_id,
                        full_street_name,
                        side,
                        parity,
                        addr_low,
                        addr_high,
                        p_zone,
                        bit_str,
                        hex_str,
                        side,
                        trans_id,
                    ),
                )
                inserted_count += 1

    conn.commit()
    return inserted_count


def export_local_chicago_curbs_bundle(output_dir: str) -> tuple[str, str]:
    """Generates both chicago_curbs.geojson and overrides_today.json in output_dir."""
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    geojson_file = str(out_path / "chicago_curbs.geojson")
    overrides_file = str(out_path / "overrides_today.json")

    dataset = generate_chicago_curb_dataset()
    with open(geojson_file, "w", encoding="utf-8") as f:
        json.dump(dataset, f, separators=(",", ":"))

    export_daily_overrides_json(
        conn=None,
        output_path=overrides_file,
        default_sections=["35-04", "01-02"],
    )

    return geojson_file, overrides_file


def main() -> None:
    parser = argparse.ArgumentParser(description="ChiCurb Chicago Free Parking ETL & Bitmask Compiler")
    parser.add_argument(
        "--export-local",
        type=str,
        default="",
        help="Output directory for local GeoJSON + overrides_today.json bundle (e.g., public/data)",
    )
    parser.add_argument(
        "--db-url",
        type=str,
        default=os.environ.get("DATABASE_URL", ""),
        help="PostgreSQL/PostGIS connection URL",
    )
    parser.add_argument(
        "--output-pmtiles",
        type=str,
        default="",
        help="Output path for PMTiles archive via ogr2ogr + tippecanoe",
    )
    parser.add_argument(
        "--output-overrides",
        type=str,
        default="",
        help="Output path for overrides_today.json",
    )
    args = parser.parse_args()

    if args.export_local:
        geojson_path, overrides_path = export_local_chicago_curbs_bundle(args.export_local)
        print(f"Exported compiled curb segments to: {geojson_path}")
        print(f"Exported daily overrides feed to:   {overrides_path}")

    if args.output_overrides and not args.export_local:
        conn = psycopg.connect(args.db_url) if (args.db_url and psycopg) else None
        export_daily_overrides_json(conn, args.output_overrides)
        if conn:
            conn.close()
        print(f"Exported daily overrides to: {args.output_overrides}")

    if args.output_pmtiles and args.db_url:
        build_pmtiles_from_postgis(args.db_url, args.output_pmtiles)
        print(f"Built PMTiles archive at: {args.output_pmtiles}")


if __name__ == "__main__":
    main()
