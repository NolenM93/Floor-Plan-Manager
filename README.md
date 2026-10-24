# Grand Ballroom Floor Plan Manager

A real-time floor plan management system for banquet and event venues. Captains manage table assignments, guest seating, and service teams from an iPad or desktop browser, while kitchen staff view live updates on a TV display.

## Features

- **Admin View**: Drag-and-drop table placement, team assignments, guest management
- **TV View**: Read-only live floor plan for kitchen monitors (no login required)
- **Service Pass**: Printable per-team guest lists with entree selections and allergy notes
- **Real-time Sync**: Changes sync instantly across all connected devices via Supabase Realtime

## Quick Start

1. Set up a [Supabase](https://supabase.com) project
2. Run the migrations in order (see Database Setup below)
3. Create a user account in Supabase Authentication for admin access
4. Update `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `app.js` with your project credentials
5. Deploy to any static hosting (GitHub Pages, Vercel, Netlify, etc.)

## Database Setup

Run these SQL files in your Supabase SQL Editor in order:

1. `db/migrations.sql` - Creates tables, initial RLS, and realtime publication
2. `db/add_seats.sql` - Adds the table_seats table for guest management
3. `db/security_hardening.sql` - **Required security update** (see Security section)

---

## SECURITY

### Overview

This application stores sensitive guest information including names and dietary restrictions. The database uses Supabase Row Level Security (RLS) to control access.

### Current Security Model

After applying `db/security_hardening.sql`:

| Table | Anonymous (TV View) | Authenticated (Admin) |
|-------|--------------------|-----------------------|
| `events` | Read only | Full access (own events) |
| `teams` | Read only | Full access (own events) |
| `wedding_tables` | Read only | Full access (own events) |
| `table_seats` | **No access** | Full access (own events) |

- **Guest PII Protection**: The `table_seats` table (containing guest names and allergies) is not accessible to anonymous users
- **Account Scoping**: Each event has an `owner_user_id`; authenticated users can only access events they own
- **TV View Safety**: The TV view (anonymous) can display the floor layout but cannot access individual guest details

### Applying Security Updates to Your Live Database

**Important**: The live database will not change until you manually apply the migration.

1. **Back up your data** before running any migration
2. Open your Supabase project dashboard
3. Go to **SQL Editor**
4. Copy the contents of `db/security_hardening.sql`
5. Run the SQL script
6. Verify the policies are applied:

```sql
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE tablename IN ('events', 'teams', 'wedding_tables', 'table_seats')
ORDER BY tablename, policyname;
```

7. Test that anonymous access to guest data is blocked:

```sql
SET ROLE anon;
SELECT * FROM table_seats LIMIT 1;  -- Should return 0 rows
RESET ROLE;
```

### Assigning Ownership to Existing Events

After running the migration, existing events will have `owner_user_id = NULL` (legacy mode allows all authenticated users to access them). To assign ownership:

1. Find your user ID in Supabase Dashboard under **Authentication > Users**
2. Run:

```sql
UPDATE events SET owner_user_id = 'your-user-uuid-here' WHERE owner_user_id IS NULL;
```

### Configuration

The Supabase URL and anonymous key in `app.js` are intentionally client-side values. The anonymous key is designed to be public but should be paired with proper RLS policies. Never expose your service role key in client code.

### Best Practices

- **Allergy Notes**: Avoid putting guest names in the `wedding_tables.allergy_notes` field, as this field is visible to the TV view. Use the individual seat allergies in `table_seats` instead.
- **Regular Audits**: Periodically review RLS policies in your Supabase dashboard
- **User Management**: Create separate user accounts for each captain; do not share credentials

---

## Project Structure

```
/
├── app.js              # Main application logic
├── index.html          # Single-page application markup
├── style.css           # Styles for all views
└── db/
    ├── migrations.sql          # Initial schema
    ├── add_seats.sql           # Guest seat management tables
    └── security_hardening.sql  # RLS security policies
```

## Views

- **Admin**: `/?event=<event_id>` (requires login)
- **TV**: `/?view=tv&event=<event_id>` (read-only, no login)
- **Print**: `/?view=print&event=<event_id>` (service pass, requires login)

## License

Private repository. All rights reserved.
