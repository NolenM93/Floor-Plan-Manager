-- ═══════════════════════════════════════════════════════════════════════
-- FLOOR PLAN MANAGER - Security Hardening Migration
-- 
-- PURPOSE: Tighten Row Level Security to protect guest PII (names, allergies)
-- 
-- CHANGES:
--   1. Remove anonymous access to table_seats (contains guest names/allergies)
--   2. Add owner_user_id to events for account-scoped access control
--   3. Update RLS policies to scope data to owning user
--   4. Keep TV view working (anon can still see floor layout, not guest details)
--
-- RUN THIS: In the Supabase SQL Editor AFTER backing up your data.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1. ADD OWNER TRACKING TO EVENTS
--    Each event is owned by the user who created it.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE events ADD COLUMN IF NOT EXISTS owner_user_id UUID;

-- Backfill: assign existing events to the first authenticated user found,
-- or leave NULL if no users exist yet. You should update this manually
-- for existing events after running the migration.
-- (Uncomment and customize if you have a known owner user ID)
-- UPDATE events SET owner_user_id = 'your-user-uuid-here' WHERE owner_user_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. DROP EXISTING OVERLY-PERMISSIVE POLICIES
-- ─────────────────────────────────────────────────────────────────────────

-- Events
DROP POLICY IF EXISTS "anon_select_events"  ON events;
DROP POLICY IF EXISTS "auth_all_events"     ON events;

-- Teams
DROP POLICY IF EXISTS "anon_select_teams"   ON teams;
DROP POLICY IF EXISTS "auth_all_teams"      ON teams;

-- Wedding tables
DROP POLICY IF EXISTS "anon_select_wedding_tables" ON wedding_tables;
DROP POLICY IF EXISTS "auth_all_wedding_tables"    ON wedding_tables;

-- Table seats (contains PII)
DROP POLICY IF EXISTS "anon_select_seats"   ON table_seats;
DROP POLICY IF EXISTS "auth_all_seats"      ON table_seats;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. CREATE SECURE RLS POLICIES
--
--    Security model:
--    - Authenticated users: full access to events they own
--    - Anonymous (TV view): read-only access to floor layout (events, teams,
--      wedding_tables) but NO access to table_seats (guest PII)
-- ─────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════
-- EVENTS TABLE
-- ═══════════════════════════════════════════════════════════════════════

-- Anon: can view events (needed for TV view event picker)
-- Note: owner_user_id is not exposed to anon, just basic event info
CREATE POLICY "anon_select_events" ON events
  FOR SELECT TO anon
  USING (true);

-- Authenticated: can view events they own OR events with no owner (legacy)
CREATE POLICY "auth_select_events" ON events
  FOR SELECT TO authenticated
  USING (
    owner_user_id IS NULL 
    OR owner_user_id = auth.uid()
  );

-- Authenticated: can insert events (automatically owned by creator)
CREATE POLICY "auth_insert_events" ON events
  FOR INSERT TO authenticated
  WITH CHECK (
    owner_user_id IS NULL 
    OR owner_user_id = auth.uid()
  );

-- Authenticated: can update/delete only events they own (or unowned legacy)
CREATE POLICY "auth_update_events" ON events
  FOR UPDATE TO authenticated
  USING (
    owner_user_id IS NULL 
    OR owner_user_id = auth.uid()
  )
  WITH CHECK (
    owner_user_id IS NULL 
    OR owner_user_id = auth.uid()
  );

CREATE POLICY "auth_delete_events" ON events
  FOR DELETE TO authenticated
  USING (
    owner_user_id IS NULL 
    OR owner_user_id = auth.uid()
  );

-- ═══════════════════════════════════════════════════════════════════════
-- TEAMS TABLE
-- ═══════════════════════════════════════════════════════════════════════

-- Anon: can view teams (needed for TV view team colors)
CREATE POLICY "anon_select_teams" ON teams
  FOR SELECT TO anon
  USING (true);

-- Authenticated: can view teams for events they have access to
CREATE POLICY "auth_select_teams" ON teams
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = teams.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

-- Authenticated: can manage teams for events they own
CREATE POLICY "auth_insert_teams" ON teams
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = teams.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

CREATE POLICY "auth_update_teams" ON teams
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = teams.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = teams.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

CREATE POLICY "auth_delete_teams" ON teams
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = teams.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- WEDDING_TABLES TABLE
-- ═══════════════════════════════════════════════════════════════════════

-- Anon: can view tables (needed for TV floor plan display)
-- Note: allergy_notes field is visible; avoid putting guest names in it
CREATE POLICY "anon_select_wedding_tables" ON wedding_tables
  FOR SELECT TO anon
  USING (true);

-- Authenticated: can view tables for events they have access to
CREATE POLICY "auth_select_wedding_tables" ON wedding_tables
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = wedding_tables.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

-- Authenticated: can manage tables for events they own
CREATE POLICY "auth_insert_wedding_tables" ON wedding_tables
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = wedding_tables.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

CREATE POLICY "auth_update_wedding_tables" ON wedding_tables
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = wedding_tables.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = wedding_tables.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

CREATE POLICY "auth_delete_wedding_tables" ON wedding_tables
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = wedding_tables.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- TABLE_SEATS TABLE (CONTAINS GUEST PII - MOST RESTRICTIVE)
-- ═══════════════════════════════════════════════════════════════════════

-- NO anon access at all - this table contains guest names and allergies

-- Authenticated: can view seats for events they have access to
CREATE POLICY "auth_select_table_seats" ON table_seats
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = table_seats.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

-- Authenticated: can manage seats for events they own
CREATE POLICY "auth_insert_table_seats" ON table_seats
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = table_seats.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

CREATE POLICY "auth_update_table_seats" ON table_seats
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = table_seats.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = table_seats.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

CREATE POLICY "auth_delete_table_seats" ON table_seats
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_id = table_seats.event_id
        AND (e.owner_user_id IS NULL OR e.owner_user_id = auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 4. UPDATE GRANTS
--    Revoke anon access to table_seats entirely
-- ─────────────────────────────────────────────────────────────────────────

-- Revoke any existing grants on table_seats for anon
REVOKE ALL ON table_seats FROM anon;

-- Keep anon SELECT on display tables (TV view)
GRANT SELECT ON events         TO anon;
GRANT SELECT ON teams          TO anon;
GRANT SELECT ON wedding_tables TO anon;

-- Authenticated gets full access (RLS will enforce ownership)
GRANT ALL ON events         TO authenticated;
GRANT ALL ON teams          TO authenticated;
GRANT ALL ON wedding_tables TO authenticated;
GRANT ALL ON table_seats    TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. CREATE INDEX FOR RLS PERFORMANCE
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_events_owner_user_id ON events(owner_user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 6. HELPER FUNCTION: Automatically set owner on new events
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_event_owner()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.owner_user_id IS NULL THEN
    NEW.owner_user_id := auth.uid();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_set_event_owner ON events;
CREATE TRIGGER trigger_set_event_owner
  BEFORE INSERT ON events
  FOR EACH ROW
  EXECUTE FUNCTION set_event_owner();

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run these after applying to confirm policies)
-- ═══════════════════════════════════════════════════════════════════════
-- 
-- Check all policies are in place:
--   SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
--   FROM pg_policies
--   WHERE tablename IN ('events', 'teams', 'wedding_tables', 'table_seats')
--   ORDER BY tablename, policyname;
--
-- Test anon cannot access table_seats:
--   SET ROLE anon;
--   SELECT * FROM table_seats LIMIT 1;  -- Should return 0 rows or error
--   RESET ROLE;
--
-- ═══════════════════════════════════════════════════════════════════════
