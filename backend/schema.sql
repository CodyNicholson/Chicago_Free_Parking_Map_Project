-- =============================================================================
-- ChiCurb: Chicago Free Parking Map — PostGIS 3.5 Spatial Schema
-- Coordinate Reference Systems:
--   EPSG:3435 (NAD83 / Illinois East ftUS) for accurate lateral curb offsetting
--   EPSG:4326 (WGS 84) for GeoJSONSeq / Tippecanoe PMTiles export
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. Raw Street Centerlines (from Socrata 6imu-meau)
CREATE TABLE IF NOT EXISTS raw_street_centerlines (
    trans_id BIGINT PRIMARY KEY,
    pre_dir VARCHAR(4),
    street_nam VARCHAR(64) NOT NULL,
    street_typ VARCHAR(16),
    suf_dir VARCHAR(4),
    full_street_name VARCHAR(128) NOT NULL,
    l_f_add INTEGER,
    l_t_add INTEGER,
    r_f_add INTEGER,
    r_t_add INTEGER,
    class VARCHAR(8),
    geom_4326 GEOMETRY(MultiLineString, 4326) NOT NULL,
    geom_3435 GEOMETRY(LineString, 3435)
);

CREATE INDEX IF NOT EXISTS idx_raw_centerlines_geom_3435
    ON raw_street_centerlines USING GIST (geom_3435);
CREATE INDEX IF NOT EXISTS idx_raw_centerlines_street_name
    ON raw_street_centerlines (street_nam, pre_dir);

-- 2. Raw Residential Parking Permit Zones (from Socrata u9xt-hiju)
CREATE TABLE IF NOT EXISTS raw_permit_zones (
    row_id TEXT PRIMARY KEY,
    status VARCHAR(16),
    zone VARCHAR(16) NOT NULL,
    odd_even VARCHAR(2) NOT NULL, -- 'O', 'E', or 'B'
    address_range_low INTEGER NOT NULL,
    address_range_high INTEGER NOT NULL,
    street_direction VARCHAR(4),
    street_name VARCHAR(64) NOT NULL,
    street_type VARCHAR(16),
    schedule_text TEXT
);

CREATE INDEX IF NOT EXISTS idx_raw_permit_lookup
    ON raw_permit_zones (street_direction, street_name, odd_even, address_range_low, address_range_high);

-- 3. Raw Street Sweeping Schedule (from Socrata u5ai-3efk)
CREATE TABLE IF NOT EXISTS raw_sweeping_schedule (
    id SERIAL PRIMARY KEY,
    ward VARCHAR(4) NOT NULL,
    section VARCHAR(8) NOT NULL,
    ward_section VARCHAR(16) GENERATED ALWAYS AS (LPAD(ward, 2, '0') || '-' || LPAD(section, 2, '0')) STORED,
    sweep_date DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sweeping_schedule_date
    ON raw_sweeping_schedule (sweep_date, ward_section);

-- 4. Raw Street Sweeping Polygons (from Socrata nk6s-cie5)
CREATE TABLE IF NOT EXISTS raw_sweeping_zones (
    ward_section VARCHAR(16) PRIMARY KEY,
    ward VARCHAR(4) NOT NULL,
    section VARCHAR(8) NOT NULL,
    geom_4326 GEOMETRY(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_sweeping_zones_geom
    ON raw_sweeping_zones USING GIST (geom_4326);

-- 5. Compiled Curb Segments (Left & Right Physically Offset Curbs)
-- Each street block is split into Left ('L') and Right ('R') curb segments
-- offset by 18 feet (~5.5m) in EPSG:3435 using ST_OffsetCurve.
CREATE TABLE IF NOT EXISTS curb_segments (
    curb_id BIGSERIAL PRIMARY KEY,
    trans_id BIGINT REFERENCES raw_street_centerlines(trans_id) ON DELETE CASCADE,
    full_street_name VARCHAR(128) NOT NULL,
    side_of_street CHAR(1) NOT NULL CHECK (side_of_street IN ('L', 'R')),
    odd_even CHAR(1) NOT NULL CHECK (odd_even IN ('O', 'E')),
    addr_low INTEGER NOT NULL,
    addr_high INTEGER NOT NULL,
    permit_zone VARCHAR(16),
    winter_ban BOOLEAN NOT NULL DEFAULT FALSE,
    snow_route BOOLEAN NOT NULL DEFAULT FALSE,
    ward_section VARCHAR(16),
    restriction_label VARCHAR(128),
    -- 672 bits = 7 days (Sun..Sat) * 96 fifteen-minute intervals per day (1 = Free, 0 = Restricted)
    weekly_free_mask BIT(672) NOT NULL,
    mask_hex CHAR(168) NOT NULL,
    geom_3435 GEOMETRY(LineString, 3435),
    geom GEOMETRY(LineString, 4326) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_curb_segments_geom
    ON curb_segments USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_curb_segments_ward_section
    ON curb_segments (ward_section);

-- 6. Helper function to split centerlines into Left & Right offset curbs in EPSG:3435
CREATE OR REPLACE FUNCTION generate_curb_offset_geom(
    centerline_4326 GEOMETRY,
    side CHAR(1),
    offset_feet DOUBLE PRECISION DEFAULT 18.0
) RETURNS GEOMETRY AS $$
DECLARE
    line_3435 GEOMETRY;
    signed_offset DOUBLE PRECISION;
    offset_3435 GEOMETRY;
BEGIN
    line_3435 := ST_Transform(ST_LineMerge(centerline_4326), 3435);
    -- Positive offset in ST_OffsetCurve shifts to the left of the line direction;
    -- Negative offset shifts to the right.
    signed_offset := CASE WHEN side = 'L' THEN offset_feet ELSE -offset_feet END;
    offset_3435 := ST_OffsetCurve(line_3435, signed_offset, 'quad_segs=4 join=round');
    RETURN ST_Transform(offset_3435, 4326);
END;
$$ LANGUAGE plpgsql IMMUTABLE;
