# Lessons Learned

This file is the persistent memory of the Implementation Guardian agent.
It is read at the start of every session and treated as an extension of the agent's core instructions.

**Format for new entries:**

```
## [YYYY-MM-DD] <short title>

**Context:** What was being built or changed.
**Problem:** What went wrong or what was learned.
**Principle:** The reusable rule extracted from this experience.
**Applied to:** Any files, patterns, or areas of the codebase this affects.
```

**Guidelines:**
- Write a lesson when a bug needed more than one attempt, an assumption was wrong, or a non-obvious project convention was discovered.
- Keep entries sharp — ten high-value entries beat fifty vague ones.
- Do not duplicate rules already covered in the agent file.

---

<!-- Agent: read everything below this line at session start -->

## [2026-06-15] Supabase publishable key vs. legacy JWT key incompatibility

**Context:** Connecting the Floor Plan Manager SPA to Supabase using `createClient`.
**Problem:** Supabase's new `sb_publishable_` key format is explicitly documented as "safe to use in a browser **if you have enabled Row Level Security**." With RLS disabled (which is the intentional choice for this internal tool), the publishable key is rejected with a 401. The legacy JWT anon key must be used instead.
**Principle:** When disabling RLS on a Supabase table, always use the **legacy JWT anon key**, never the new publishable key. Verify key compatibility with the security model before connecting.
**Applied to:** `app.js` SUPABASE_ANON_KEY constant; any future Supabase project setup.

---

## [2026-06-15] Visually ambiguous characters in Supabase Project IDs

**Context:** Deriving the Supabase project URL from a screenshot of the dashboard.
**Problem:** Supabase project IDs use lowercase alphanumeric characters. In common sans-serif dashboard fonts, lowercase `l` (ell), uppercase `I` (eye), and digit `1` (one) are visually identical. Reading the project ID `uttyrbthhlgrfoobfngu` from a screenshot produced `uttyrbthhIgrfoobfngu` (capital I), causing a URL mismatch and hours of debugging.
**Principle:** Never derive a Supabase project ID or URL from a screenshot. Always copy it directly from the dashboard using the **Copy** button in Settings → General, or decode it from the `ref` field of the JWT token programmatically.
**Applied to:** `app.js` SUPABASE_URL constant; any future credential setup.

---

## [2026-06-15] Subresource Integrity (SRI) hash blocks CDN script silently

**Context:** Loading Fabric.js v5 from cdnjs via a `<script>` tag with an `integrity` attribute.
**Problem:** An incorrect SRI hash (`integrity="sha512-..."`) causes the browser to silently block the script from loading. The page renders and no JavaScript error appears in the console — the canvas simply never initializes, buttons do nothing, and the failure is invisible to the user.
**Principle:** Never add an `integrity` attribute to a CDN script tag unless you have computed the hash yourself from the exact file being served. When in doubt, omit the attribute entirely. A missing SRI hash is a lesser risk than a wrong one that silently breaks the entire application.
**Applied to:** `index.html` CDN script tags.

---

## [2026-06-15] GitHub Pages requires the repo to be public on a free account

**Context:** Deploying a static SPA to GitHub Pages from a private repository.
**Problem:** GitHub Pages is not available on private repositories under a free GitHub account. The Pages settings page shows only an "Upgrade" prompt. The GitHub Actions workflow deploys successfully but the published URL returns 404.
**Principle:** Before choosing GitHub Pages as a deployment target, verify that the repository is public or the account has a paid plan. For private internal tools, prefer Netlify or Vercel (both support private repos on free tiers).
**Applied to:** Deployment strategy for any future project.

---

## [2026-06-15] Supabase URL and JWT key must belong to the same project

**Context:** Debugging repeated 401 "invalid API key" errors after correctly setting the Supabase URL.
**Problem:** The JWT anon key encodes the project `ref` in its payload. If the URL (`https://<project-id>.supabase.co`) references a different project than the one in the JWT `ref` field, every API call returns 401. This can happen silently when a developer has multiple Supabase projects open in browser tabs and copies credentials from the wrong one.
**Principle:** Always verify that the Supabase URL and anon key come from the **same project** by decoding the JWT payload (base64 middle segment) and confirming the `ref` field matches the project ID in the URL.
**Applied to:** `app.js` credentials block.

---

## [2026-06-15] Deploy schema migration before frontend that references new columns

**Context:** Extending the Floor Plan Manager with events, teams, team_id, shape, and capacity columns.
**Problem:** Deploying new `app.js` that queries `event_id` and `team_id` before running `db/migrations.sql` causes every Supabase call to fail with "column does not exist."
**Principle:** Schema migrations must be applied in Supabase **before** pushing frontend code that depends on the new columns. Keep migration SQL versioned in the repo and treat it as a deploy gate.
**Applied to:** `db/migrations.sql`, all deploy workflows.
