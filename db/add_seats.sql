-- ═══════════════════════════════════════════════════════════════════════
-- SAGAMORE FLOOR PLAN MANAGER — Seats Migration
-- Run AFTER migrations.sql has already been applied.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. TABLE_SEATS
--    One row per guest seat. Serves as the source-of-truth for the
--    printed service pass and auto-calculates table entrée counts.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS table_seats (
  seat_id          TEXT PRIMARY KEY,
  table_id         TEXT NOT NULL REFERENCES wedding_tables(table_id) ON DELETE CASCADE,
  event_id         TEXT NOT NULL,
  team_id          TEXT,          -- per-seat team override (null = inherit table's team_id)
  seat_number      INT  NOT NULL DEFAULT 1,
  first_name       TEXT,
  last_name        TEXT,
  entree_category  TEXT CHECK (entree_category IN ('beef','chicken','fish','vegetarian','kids','other')),
  entree_label     TEXT,          -- full name: "herb-crusted filet mignon"
  serve_side       TEXT CHECK (serve_side IN ('right','left')),
  allergies        TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seats_table_id ON table_seats(table_id);
CREATE INDEX IF NOT EXISTS idx_seats_event_id ON table_seats(event_id);

-- ─────────────────────────────────────────────────────────────────────
-- 2. EXTEND wedding_tables WITH VEG + KIDS COUNTS
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE wedding_tables ADD COLUMN IF NOT EXISTS veg_count  INT DEFAULT 0;
ALTER TABLE wedding_tables ADD COLUMN IF NOT EXISTS kids_count INT DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────
-- 3. REALTIME PUBLICATION
-- ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'table_seats'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE table_seats;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 4. ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE table_seats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_seats" ON table_seats;
DROP POLICY IF EXISTS "auth_all_seats"    ON table_seats;

CREATE POLICY "anon_select_seats" ON table_seats
  FOR SELECT TO anon USING (true);

CREATE POLICY "auth_all_seats" ON table_seats
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT ON table_seats TO anon;
GRANT ALL    ON table_seats TO authenticated;
