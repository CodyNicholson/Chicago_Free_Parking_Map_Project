# ChiCurb — Chicago Free Parking Map

A high-performance, city-wide Chicago free parking application designed around **zero-network client-side schedule evaluation**.

Instead of querying a database every time a user pans the map or drags the time slider, the backend ETL compiles every curb's recurring weekly rules into a compact **672-bit schedule mask** (7 days $\times$ 96 fifteen-minute slots/day, encoded as a 168-character hexadecimal string `mask_hex`) and packs it directly into **PMTiles / Vector Tiles (or GeoJSON)**. The browser decodes that bitmask in microseconds (`Uint8Array(672)`), overlays daily dynamic flags (`overrides_today.json`), and performs a forward circular scan to compute exact remaining free parking duration and update MapLibre GL feature states at 60 FPS.

---

## Project Structure

```text
Chicago_Free_Parking_Map_Project/
├── backend/
│   ├── schema.sql                # PostgreSQL 17 + PostGIS 3.5 schema (EPSG:3435 curb offsetting + BIT(672))
│   ├── chicago_parking_etl.py    # Socrata Open Data scraper, 672-bit compiler, PMTiles & GeoJSON exporter
│   ├── test_etl.py               # Python unit test suite for 672-bit compilation & schedule parsing
│   └── requirements.txt          # Python backend dependencies
├── public/
│   └── data/
│       ├── chicago_curbs.geojson # Compiled Left/Right Chicago curb segments with 168-char hex masks
│       └── overrides_today.json  # Daily edge override feed (Ward Sweeping, Winter Ban, 2" Snow Ban)
├── src/
│   ├── types/
│   │   └── parking.ts            # TypeScript interfaces & Chicago neighborhood presets
│   ├── utils/
│   │   ├── curbEvaluator.ts      # 672-bit hex decoder & contiguous free-window forward scanner
│   │   └── curbEvaluator.test.ts # Vitest unit tests for client bitmask evaluation
│   ├── components/
│   │   └── ChicagoParkingApp.tsx # Responsive Desktop + Mobile React 19 + Tailwind + MapLibre GL app
│   ├── ChicagoParkingApp.tsx     # Re-export entry point
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Quick Start

### 1. Run Backend ETL & Unit Tests (Python)
```bash
# Run Python unit tests for the 672-bit bitmask compiler
python -m unittest backend/test_etl.py

# Regenerate local GeoJSON & daily overrides bundle
python backend/chicago_parking_etl.py --export-local public/data
```

### 2. Install Frontend Dependencies & Start Dev Server
```bash
npm install
npm test
npm run dev
```

### 3. Production PostGIS + Tippecanoe PMTiles Pipeline
```bash
# 1. Initialize PostGIS 3.5 schema
psql "$DATABASE_URL" -f backend/schema.sql

# 2. Export PMTiles archive + daily edge overrides
python backend/chicago_parking_etl.py \
  --db-url "$DATABASE_URL" \
  --output-pmtiles public/tiles/chicago_curbs.pmtiles \
  --output-overrides public/data/overrides_today.json
```
