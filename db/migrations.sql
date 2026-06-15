-- ═══════════════════════════════════════════════════════════════════════
-- SAGAMORE FLOOR PLAN MANAGER — Schema Migration
-- Run this in the Supabase SQL Editor BEFORE deploying the new app.js.
-- Safe to re-run: uses IF NOT EXISTS / conditional checks where possible.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. EVENTS TABLE
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  event_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  event_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────
-- 2. TEAMS TABLE
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  team_id    TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#6B7280',
  sort_order INT  NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teams_event_id ON teams(event_id);

-- ─────────────────────────────────────────────────────────────────────
-- 3. EXTEND wedding_tables
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE wedding_tables ADD COLUMN IF NOT EXISTS event_id TEXT;
ALTER TABLE wedding_tables ADD COLUMN IF NOT EXISTS team_id   TEXT;
ALTER TABLE wedding_tables ADD COLUMN IF NOT EXISTS shape     TEXT DEFAULT 'round';
ALTER TABLE wedding_tables ADD COLUMN IF NOT EXISTS capacity    INT;

-- ─────────────────────────────────────────────────────────────────────
-- 4. BACKFILL — Default Event
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO events (event_id, name, event_date)
VALUES ('event_default', 'Default Event', CURRENT_DATE)
ON CONFLICT (event_id) DO NOTHING;

-- Assign all orphan tables to the default event
UPDATE wedding_tables
SET event_id = 'event_default'
WHERE event_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 5. BACKFILL — Teams from legacy server_team values
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  team_rec RECORD;
  new_id   TEXT;
  colors   TEXT[] := ARRAY['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];
  idx      INT := 0;
BEGIN
  FOR team_rec IN
    SELECT DISTINCT server_team AS name
    FROM wedding_tables
    WHERE server_team IS NOT NULL AND server_team <> ''
    ORDER BY server_team
  LOOP
    new_id := 'team_' || lower(replace(replace(team_rec.name, ' ', '_'), '.', ''));
    idx := idx + 1;

    INSERT INTO teams (team_id, event_id, name, color, sort_order)
    VALUES (
      new_id,
      'event_default',
      team_rec.name,
      colors[((idx - 1) % 4) + 1],
      idx
    )
    ON CONFLICT (team_id) DO NOTHING;

    UPDATE wedding_tables
    SET team_id = new_id
    WHERE server_team = team_rec.name
      AND team_id IS NULL;
  END LOOP;
END $$;

-- Default shape for any rows missing it
UPDATE wedding_tables SET shape = 'round' WHERE shape IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 6. REALTIME PUBLICATION
-- ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE events;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'teams'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE teams;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'wedding_tables'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE wedding_tables;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 7. ROW LEVEL SECURITY
--     anon: SELECT only (TV view, no login)
--     authenticated: full CRUD (admin captains)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams          ENABLE ROW LEVEL SECURITY;
ALTER TABLE wedding_tables ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS "anon_select_events"         ON events;
DROP POLICY IF EXISTS "auth_all_events"           ON events;
DROP POLICY IF EXISTS "anon_select_teams"         ON teams;
DROP POLICY IF EXISTS "auth_all_teams"            ON teams;
DROP POLICY IF EXISTS "anon_select_wedding_tables" ON wedding_tables;
DROP POLICY IF EXISTS "auth_all_wedding_tables"   ON wedding_tables;

-- events
CREATE POLICY "anon_select_events" ON events
  FOR SELECT TO anon USING (true);

CREATE POLICY "auth_all_events" ON events
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- teams
CREATE POLICY "anon_select_teams" ON teams
  FOR SELECT TO anon USING (true);

CREATE POLICY "auth_all_teams" ON teams
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- wedding_tables
CREATE POLICY "anon_select_wedding_tables" ON wedding_tables
  FOR SELECT TO anon USING (true);

CREATE POLICY "auth_all_wedding_tables" ON wedding_tables
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────
-- 8. GRANTS (required for RLS to work with anon/authenticated roles)
-- ─────────────────────────────────────────────────────────────────────
GRANT SELECT ON events         TO anon;
GRANT SELECT ON teams          TO anon;
GRANT SELECT ON wedding_tables TO anon;

GRANT ALL ON events         TO authenticated;
GRANT ALL ON teams          TO authenticated;
GRANT ALL ON wedding_tables TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 9. CAPTAIN AUTH SETUP (Supabase Dashboard)
--     Authentication → Users → Add User → create a captain account.
--     Admin view requires sign-in; TV view stays read-only with anon key.
-- ─────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────
-- 10. OPTIONAL CLEANUP (run manually after verifying migration)
-- ─────────────────────────────────────────────────────────────────────
-- ALTER TABLE wedding_tables DROP COLUMN IF EXISTS server_team;
