/* ═══════════════════════════════════════════════════════════════════════
   SAGAMORE RESORT — FLOOR PLAN MANAGER
   app.js  ·  Requires: Fabric.js v5  +  Supabase JS v2
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* ─────────────────────────────────────────────────────────────────────
   §1  CONFIGURATION
       Replace the two placeholder strings before going live.
   ───────────────────────────────────────────────────────────────────── */
const SUPABASE_URL      = 'https://qkfscgweyfopjgxhlfnl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_t0jVHlUpSdS9mbGXSGolDw_rfl33Pao';
const TABLE_NAME        = 'wedding_tables';

// Logical coordinate space stored in the database.
// All x_pos / y_pos values live in this 1600 × 900 grid.
// Fabric's viewport transform scales it to whatever the screen is.
const LOGICAL_W = 1600;
const LOGICAL_H = 900;

// Circle radius in logical units for each view
const ADMIN_R = 56;
const TV_R    = 72;

// Team → fill colour mapping.  Add 'Team 5', etc. here to extend.
const TEAM_COLORS = {
  'Team 1':  '#4A90D9',
  'Team 2':  '#E67E22',
  'Team 3':  '#27AE60',
  'Team 4':  '#9B59B6',
};
const DEFAULT_COLOR = '#6B7280';

/* ─────────────────────────────────────────────────────────────────────
   §2  MUTABLE STATE
   ───────────────────────────────────────────────────────────────────── */
let db;                     // Supabase client instance
let canvas;                 // fabric.Canvas instance
let currentView = 'admin';  // 'admin' | 'tv'

// Primary data store: table_id → { row: <DB row object>, group: <fabric.Group> }
const tableMap = new Map();

// Set of table_ids whose allergy_notes field is non-empty
const allergySet = new Set();

let activeTeam   = null;   // currently-selected team in the service queue
let allergyRafId = null;   // requestAnimationFrame handle for allergy pulse
let toastTimer   = null;   // setTimeout handle for auto-dismissing toast

/* ─────────────────────────────────────────────────────────────────────
   §3  BOOT — DOMContentLoaded
   ───────────────────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', async () => {
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  currentView = new URLSearchParams(window.location.search).get('view') === 'tv'
    ? 'tv'
    : 'admin';

  // Hide the unused view container entirely
  document.getElementById(currentView === 'tv' ? 'admin-view' : 'tv-view')
    .style.display = 'none';

  // Let the flex layout paint so wrapper dimensions are stable
  await rafTicks(2);

  if (currentView === 'tv') {
    await initTVView();
  } else {
    await initAdminView();
  }
});

/* ─────────────────────────────────────────────────────────────────────
   §4  CANVAS SETUP  (shared between both views)
   ───────────────────────────────────────────────────────────────────── */

/**
 * Create the Fabric.js canvas sized to its wrapper element, then apply
 * the viewport transform so the logical 1600×900 grid fits on screen.
 */
function setupCanvas(canvasElId, wrapperId) {
  const wrapper = document.getElementById(wrapperId);
  const w = wrapper.clientWidth  || window.innerWidth;
  const h = wrapper.clientHeight || (window.innerHeight - 64);

  canvas = new fabric.Canvas(canvasElId, {
    width:               w,
    height:              h,
    selection:           false,   // no rubber-band multi-select
    renderOnAddRemove:   false,   // manual renderAll for performance
    enableRetinaScaling: true,
    preserveObjectStacking: true,
  });

  applyViewport();
}

/**
 * Compute and set a viewport transform that centres the logical
 * 1600×900 space within the physical canvas at the largest uniform scale.
 */
function applyViewport() {
  if (!canvas) return;
  const scale   = Math.min(canvas.width / LOGICAL_W, canvas.height / LOGICAL_H);
  const offsetX = (canvas.width  - LOGICAL_W * scale) / 2;
  const offsetY = (canvas.height - LOGICAL_H * scale) / 2;
  canvas.setViewportTransform([scale, 0, 0, scale, offsetX, offsetY]);
}

// Re-fit the canvas whenever the browser window is resized
window.addEventListener('resize', debounce(() => {
  if (!canvas) return;
  const wrapperId = currentView === 'tv' ? 'tv-canvas-wrapper' : 'canvas-wrapper';
  const wrapper   = document.getElementById(wrapperId);
  canvas.setDimensions({ width: wrapper.clientWidth, height: wrapper.clientHeight });
  applyViewport();
  canvas.renderAll();
}, 200));

/* ─────────────────────────────────────────────────────────────────────
   §5  TABLE GROUP BUILDERS
       Fabric.Group objects are rebuilt from scratch on any data change;
       this avoids the complexity of mutating nested group children.
   ───────────────────────────────────────────────────────────────────── */

/** Return the fill colour for a given server_team string (or null). */
function teamColor(team) {
  return TEAM_COLORS[team] ?? DEFAULT_COLOR;
}

/** True when the row contains non-empty allergy notes. */
function rowHasAllergy(row) {
  return !!(row.allergy_notes && row.allergy_notes.trim().length > 0);
}

/**
 * Build the interactive Fabric.Group used in the admin (iPad) view.
 *
 * Object names inside the group:
 *   'circle'      — main filled circle
 *   'label'       — large table-number text
 *   'guests'      — guest-count sub-text
 *   'allergy-ico' — warning icon shown when allergy notes exist
 */
function buildAdminGroup(row) {
  const color   = teamColor(row.server_team);
  const allergy = rowHasAllergy(row);

  const circle = new fabric.Circle({
    radius:      ADMIN_R,
    fill:        color,
    stroke:      allergy ? '#F59E0B' : 'rgba(255,255,255,0.13)',
    strokeWidth: allergy ? 4 : 1.5,
    originX: 'center',
    originY: 'center',
    name:    'circle',
  });

  const hasGuests   = (row.guest_count > 0);
  const labelText   = new fabric.Text(String(row.label ?? '?'), {
    fontSize:   31,
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontWeight: 'bold',
    fill:       '#FFFFFF',
    originX:    'center',
    originY:    'center',
    top:        hasGuests ? -10 : 0,
    name:       'label',
    shadow:     new fabric.Shadow({ color: 'rgba(0,0,0,0.5)', blur: 4, offsetX: 0, offsetY: 1 }),
  });

  const objects = [circle, labelText];

  if (hasGuests) {
    objects.push(new fabric.Text(`${row.guest_count} guests`, {
      fontSize:   13,
      fontFamily: '"Inter", "Segoe UI", Arial, sans-serif',
      fill:       'rgba(255,255,255,0.68)',
      originX:    'center',
      originY:    'center',
      top:        18,
      name:       'guests',
    }));
  }

  // Small amber warning triangle pinned to the bottom of the circle
  if (allergy) {
    objects.push(new fabric.Text('\u26A0', {
      fontSize:   14,
      fontFamily: 'Arial, sans-serif',
      fill:       '#F59E0B',
      originX:    'center',
      originY:    'center',
      top:        ADMIN_R - 19,
      name:       'allergy-ico',
    }));
  }

  return new fabric.Group(objects, {
    left:        row.x_pos ?? LOGICAL_W / 2,
    top:         row.y_pos ?? LOGICAL_H / 2,
    originX:     'center',
    originY:     'center',
    selectable:  true,
    evented:     true,
    hoverCursor: 'move',
    hasControls: false,   // no scale / rotate handles
    hasBorders:  true,
    borderColor: 'rgba(255,255,255,0.30)',
    borderScaleFactor: 1.5,
    lockScalingX: true,
    lockScalingY: true,
    lockRotation: true,
    data: { table_id: row.table_id },
  });
}

/**
 * Build the read-only Fabric.Group used in the kitchen TV view.
 * Larger typography for readability from across the room.
 * All interaction flags are disabled.
 */
function buildTVGroup(row) {
  const color = teamColor(row.server_team);

  const circle = new fabric.Circle({
    radius:      TV_R,
    fill:        color,
    stroke:      'rgba(255,255,255,0.07)',
    strokeWidth: 1,
    originX:     'center',
    originY:     'center',
    name:        'circle',
  });

  const labelText = new fabric.Text(String(row.label ?? '?'), {
    fontSize:   44,
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontWeight: 'bold',
    fill:       '#FFFFFF',
    originX:    'center',
    originY:    'center',
    top:        -22,
    name:       'label',
  });

  const guestText = new fabric.Text(
    row.guest_count > 0 ? `${row.guest_count} guests` : '',
    {
      fontSize:   18,
      fontFamily: '"Inter", "Segoe UI", Arial, sans-serif',
      fill:       'rgba(255,255,255,0.62)',
      originX:    'center',
      originY:    'center',
      top:        10,
      name:       'guests',
    }
  );

  // Compact entrée summary:  "6B · 4C · 2F"
  const parts = [];
  if (row.beef_count    > 0) parts.push(`${row.beef_count}B`);
  if (row.chicken_count > 0) parts.push(`${row.chicken_count}C`);
  if (row.fish_count    > 0) parts.push(`${row.fish_count}F`);
  const entreeText = new fabric.Text(parts.join(' \u00B7 '), {
    fontSize:   15,
    fontFamily: '"Inter", "Segoe UI", Arial, sans-serif',
    fill:       'rgba(255,255,255,0.42)',
    originX:    'center',
    originY:    'center',
    top:        32,
    name:       'entrees',
  });

  return new fabric.Group([circle, labelText, guestText, entreeText], {
    left:        row.x_pos ?? LOGICAL_W / 2,
    top:         row.y_pos ?? LOGICAL_H / 2,
    originX:     'center',
    originY:     'center',
    selectable:  false,
    evented:     false,
    hoverCursor: 'default',
    hasControls: false,
    hasBorders:  false,
    data: { table_id: row.table_id },
  });
}

/* ─────────────────────────────────────────────────────────────────────
   §6  CANVAS TABLE CRUD  (in-memory + visual layer)
   ───────────────────────────────────────────────────────────────────── */

/** Add a table row to the canvas and tableMap. */
function addToCanvas(row) {
  const group = currentView === 'tv' ? buildTVGroup(row) : buildAdminGroup(row);
  canvas.add(group);
  tableMap.set(row.table_id, { row, group });

  if (rowHasAllergy(row)) allergySet.add(row.table_id);
  else                    allergySet.delete(row.table_id);

  return group;
}

/** Remove a table completely from canvas and tableMap. */
function removeFromCanvas(tableId) {
  const entry = tableMap.get(tableId);
  if (!entry) return;
  canvas.remove(entry.group);
  tableMap.delete(tableId);
  allergySet.delete(tableId);
}

/**
 * Rebuild a table's Fabric.Group after its data changed.
 * The old group is removed and a new one is created with the updated row.
 */
function refreshOnCanvas(row) {
  const existing = tableMap.get(row.table_id);
  if (existing) canvas.remove(existing.group);
  addToCanvas(row);
}

/* ─────────────────────────────────────────────────────────────────────
   §7  DATA LOADING  (initial fetch from Supabase)
   ───────────────────────────────────────────────────────────────────── */
async function loadAllTables() {
  const { data, error } = await db
    .from(TABLE_NAME)
    .select('*');

  if (error) {
    showToast('Could not load tables: ' + error.message, 'error');
    return;
  }

  canvas.clear();
  tableMap.clear();
  allergySet.clear();

  for (const row of (data ?? [])) {
    addToCanvas(row);
  }

  canvas.renderAll();
}

/* ─────────────────────────────────────────────────────────────────────
   §8  ADMIN VIEW — INITIALISATION
   ───────────────────────────────────────────────────────────────────── */
async function initAdminView() {
  setupCanvas('floor-canvas', 'canvas-wrapper');
  await loadAllTables();
  renderTeamTabs();
  bindAdminEvents();
  startAllergyPulse();
}

function bindAdminEvents() {
  /* ── Drag-end: persist new X/Y to Supabase ─────────────────────── */
  canvas.on('object:modified', async (e) => {
    const g = e.target;
    if (!g?.data?.table_id) return;

    const { table_id }   = g.data;
    const x_pos          = g.left;   // logical coords (pre-viewport-transform)
    const y_pos          = g.top;

    // Optimistic in-memory update so the queue stays consistent
    const entry = tableMap.get(table_id);
    if (entry) { entry.row.x_pos = x_pos; entry.row.y_pos = y_pos; }

    const { error } = await db
      .from(TABLE_NAME)
      .update({ x_pos, y_pos })
      .eq('table_id', table_id);

    if (error) showToast('Position not saved — check connection', 'error');
  });

  /* ── Double-click / double-tap: open edit modal ─────────────────── */
  canvas.on('mouse:dblclick', (e) => {
    if (!e.target?.data?.table_id) return;
    const entry = tableMap.get(e.target.data.table_id);
    if (entry) openModal(entry.row);
  });

  /* ── Control bar: Add Table ─────────────────────────────────────── */
  document.getElementById('add-table-btn').addEventListener('click', handleAddTable);

  /* ── Modal wiring ───────────────────────────────────────────────── */
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('pointerdown', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('save-table-btn').addEventListener('click', handleSaveModal);
  document.getElementById('delete-table-btn').addEventListener('click', handleDeleteFromModal);

  // Live team-colour swatch in the modal header
  document.getElementById('modal-server-team').addEventListener('change', (e) => {
    document.getElementById('modal-color-swatch').style.background =
      teamColor(e.target.value || null);
  });

  // Escape key closes the modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

/* ─────────────────────────────────────────────────────────────────────
   §9  ADD TABLE
   ───────────────────────────────────────────────────────────────────── */
async function handleAddTable() {
  // Auto-generate the next label number above the current maximum
  let maxNum = 0;
  for (const [, entry] of tableMap) {
    const n = parseInt(entry.row.label, 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  }

  // Place near canvas centre with a small random offset so tables don't stack
  const x_pos = LOGICAL_W / 2 + (Math.random() - 0.5) * 160;
  const y_pos = LOGICAL_H / 2 + (Math.random() - 0.5) * 160;

  const newRow = {
    table_id:      `table_${Date.now()}`,
    label:         String(maxNum + 1),
    guest_count:   0,
    beef_count:    0,
    chicken_count: 0,
    fish_count:    0,
    server_team:   null,
    allergy_notes: null,
    x_pos,
    y_pos,
  };

  const { data, error } = await db
    .from(TABLE_NAME)
    .insert(newRow)
    .select()
    .single();

  if (error) {
    showToast('Add table failed: ' + error.message, 'error');
    return;
  }

  addToCanvas(data);
  canvas.renderAll();
  renderTeamTabs();
  showToast(`Table ${data.label} added`);
}

/* ─────────────────────────────────────────────────────────────────────
   §10  EDIT MODAL
   ───────────────────────────────────────────────────────────────────── */
function openModal(row) {
  const $ = (id) => document.getElementById(id);

  $('modal-table-id').value       = row.table_id;
  $('modal-title').textContent    = `Table ${row.label}`;
  $('modal-label').value          = row.label         ?? '';
  $('modal-guest-count').value    = row.guest_count   ?? 0;
  $('modal-beef').value           = row.beef_count    ?? 0;
  $('modal-chicken').value        = row.chicken_count ?? 0;
  $('modal-fish').value           = row.fish_count    ?? 0;
  $('modal-server-team').value    = row.server_team   ?? '';
  $('modal-allergy').value        = row.allergy_notes ?? '';
  $('modal-color-swatch').style.background = teamColor(row.server_team);

  $('modal-overlay').classList.remove('hidden');
  $('modal-label').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

async function handleSaveModal() {
  const tableId = document.getElementById('modal-table-id').value;
  if (!tableId) return;

  const numVal = (id) => Math.max(0, parseInt(document.getElementById(id).value, 10) || 0);
  const strVal = (id) => document.getElementById(id).value;

  const updates = {
    label:         strVal('modal-label').trim() || '?',
    guest_count:   numVal('modal-guest-count'),
    beef_count:    numVal('modal-beef'),
    chicken_count: numVal('modal-chicken'),
    fish_count:    numVal('modal-fish'),
    server_team:   strVal('modal-server-team') || null,
    allergy_notes: strVal('modal-allergy').trim() || null,
  };

  const { data, error } = await db
    .from(TABLE_NAME)
    .update(updates)
    .eq('table_id', tableId)
    .select()
    .single();

  if (error) {
    showToast('Save failed: ' + error.message, 'error');
    return;
  }

  refreshOnCanvas(data);
  canvas.renderAll();
  renderTeamTabs();
  if (activeTeam !== null) renderQueueList(activeTeam);

  closeModal();
  showToast(`Table ${data.label} saved`);
}

async function handleDeleteFromModal() {
  const tableId = document.getElementById('modal-table-id').value;
  const label   = document.getElementById('modal-label').value || tableId;
  if (!tableId) return;

  if (!window.confirm(`Delete Table ${label}?\n\nThis removes it permanently from the floor plan.`)) return;

  const { error } = await db
    .from(TABLE_NAME)
    .delete()
    .eq('table_id', tableId);

  if (error) {
    showToast('Delete failed: ' + error.message, 'error');
    return;
  }

  removeFromCanvas(tableId);
  canvas.renderAll();
  renderTeamTabs();
  if (activeTeam !== null) renderQueueList(activeTeam);

  closeModal();
  showToast(`Table ${label} deleted`);
}

/* ─────────────────────────────────────────────────────────────────────
   §11  SERVICE PASS QUEUE SIDEBAR
   ───────────────────────────────────────────────────────────────────── */

/** Rebuild the team-filter tab strip from what's actually in the tableMap. */
function renderTeamTabs() {
  const teamsPresent = new Set();
  for (const [, entry] of tableMap) {
    if (entry.row.server_team) teamsPresent.add(entry.row.server_team);
  }

  // Preserve defined order; only show teams that have at least one table
  const orderedTeams = ['Team 1', 'Team 2', 'Team 3', 'Team 4']
    .filter(t => teamsPresent.has(t));

  // Also include any custom teams not in the predefined list
  for (const t of teamsPresent) {
    if (!orderedTeams.includes(t)) orderedTeams.push(t);
  }

  const container = document.getElementById('team-tabs');
  container.innerHTML = '';

  if (orderedTeams.length === 0) {
    container.innerHTML =
      '<span style="font-size:12px;color:#404666;padding:4px 6px">No teams assigned yet.</span>';
    document.getElementById('queue-list').innerHTML =
      '<p class="queue-placeholder">Assign server teams<br>via the table editor.</p>';
    document.getElementById('queue-summary').textContent = '';
    return;
  }

  orderedTeams.forEach(team => {
    const btn       = document.createElement('button');
    btn.className   = 'team-tab' + (activeTeam === team ? ' active' : '');
    btn.dataset.team = team;
    btn.textContent = team;
    btn.addEventListener('click', () => {
      activeTeam = team;
      container.querySelectorAll('.team-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderQueueList(team);
    });
    container.appendChild(btn);
  });

  // Keep the current queue in sync if the active team still exists
  if (activeTeam && teamsPresent.has(activeTeam)) {
    renderQueueList(activeTeam);
  } else if (activeTeam && !teamsPresent.has(activeTeam)) {
    // Active team was just removed — clear queue
    activeTeam = null;
    document.getElementById('queue-list').innerHTML =
      '<p class="queue-placeholder">Select a team above<br>to view their tables.</p>';
    document.getElementById('queue-summary').textContent = '';
  }
}

/**
 * Render the ordered list of tables assigned to `team`.
 * Sorted numerically by label; Banquet Captain reads top-to-bottom
 * to orchestrate the service pass.
 */
function renderQueueList(team) {
  const rows = [];
  for (const [, entry] of tableMap) {
    if (entry.row.server_team === team) rows.push(entry.row);
  }

  // Numeric label sort; fall back to lexicographic for non-numeric labels
  rows.sort((a, b) => {
    const na = parseInt(a.label, 10), nb = parseInt(b.label, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a.label).localeCompare(String(b.label));
  });

  const list = document.getElementById('queue-list');

  if (rows.length === 0) {
    list.innerHTML = `<p class="queue-placeholder">No tables assigned to ${team}.</p>`;
    document.getElementById('queue-summary').textContent = '';
    return;
  }

  let totBeef = 0, totChicken = 0, totFish = 0, totGuests = 0;

  const itemsHTML = rows.map(row => {
    totBeef    += row.beef_count    ?? 0;
    totChicken += row.chicken_count ?? 0;
    totFish    += row.fish_count    ?? 0;
    totGuests  += row.guest_count   ?? 0;

    // Entrée pill HTML
    const entreePills = [];
    if (row.beef_count    > 0) entreePills.push(`<span class="queue-entree-count"><span class="queue-dot beef"></span>${row.beef_count} Beef</span>`);
    if (row.chicken_count > 0) entreePills.push(`<span class="queue-entree-count"><span class="queue-dot chicken"></span>${row.chicken_count} Chicken</span>`);
    if (row.fish_count    > 0) entreePills.push(`<span class="queue-entree-count"><span class="queue-dot fish"></span>${row.fish_count} Fish</span>`);

    const entreeHTML = entreePills.length
      ? `<div class="queue-entrees">${entreePills.join('')}</div>`
      : `<div class="queue-entrees" style="font-size:12px;color:#404666">No entr\u00e9es recorded</div>`;

    const allergyHTML = row.allergy_notes
      ? `<div class="queue-allergy-flag"><span>\u26A0</span>${row.allergy_notes}</div>`
      : '';

    return `
      <div class="queue-item">
        <div class="queue-table-num">
          Table ${row.label}
          <span class="queue-guest-pill">${row.guest_count ?? 0} guests</span>
        </div>
        ${entreeHTML}
        ${allergyHTML}
      </div>`;
  }).join('');

  list.innerHTML = itemsHTML;

  // Footer summary line
  document.getElementById('queue-summary').innerHTML =
    `${rows.length} tables &nbsp;&middot;&nbsp; ${totGuests} guests &nbsp;&middot;&nbsp; ` +
    `<span style="color:#C0392B">${totBeef}B</span>&nbsp;` +
    `<span style="color:#D4A017">${totChicken}C</span>&nbsp;` +
    `<span style="color:#2980B9">${totFish}F</span>`;
}

/* ─────────────────────────────────────────────────────────────────────
   §12  TV / KITCHEN MONITOR VIEW
   ───────────────────────────────────────────────────────────────────── */
async function initTVView() {
  setupCanvas('tv-canvas', 'tv-canvas-wrapper');
  startTVClock();
  await loadAllTables();
  startAllergyPulse();
  subscribeRealtime();
}

function startTVClock() {
  const el = document.getElementById('tv-clock');
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  };
  tick();
  setInterval(tick, 15000);
}

/* ─────────────────────────────────────────────────────────────────────
   §13  SUPABASE REALTIME SUBSCRIPTION  (TV view only)
   ───────────────────────────────────────────────────────────────────── */
function subscribeRealtime() {
  const statusEl     = document.getElementById('tv-connection-status');
  const lastUpdateEl = document.getElementById('tv-last-update');

  db.channel('sagamore-floor-plan')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: TABLE_NAME },
      (payload) => {
        handleRealtimeEvent(payload);
        lastUpdateEl.textContent = 'Last update: ' +
          new Date().toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
          });
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        statusEl.textContent = '\u25CF Live';
        statusEl.className   = 'status-live';
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        statusEl.textContent = '\u25CF Connection lost \u2014 reconnecting\u2026';
        statusEl.className   = 'status-error';
        // Reload after 6 s to re-establish the WebSocket
        setTimeout(() => location.reload(), 6000);
      }
    });
}

/**
 * Dispatch an incoming Supabase Realtime payload to the correct handler.
 *
 *   INSERT  → add a new table group
 *   UPDATE  → rebuild the group with fresh data; animate position if it moved
 *   DELETE  → remove the group
 */
function handleRealtimeEvent({ eventType, new: newRow, old: oldRow }) {
  if (eventType === 'INSERT') {
    if (!tableMap.has(newRow.table_id)) {
      addToCanvas(newRow);
      canvas.renderAll();
    }

  } else if (eventType === 'UPDATE') {
    const existing = tableMap.get(newRow.table_id);

    if (existing) {
      const startX = existing.group.left;
      const startY = existing.group.top;

      // Rebuild group with updated data (new position embedded)
      refreshOnCanvas(newRow);

      const updated = tableMap.get(newRow.table_id);
      const dx = Math.abs(startX - (newRow.x_pos ?? startX));
      const dy = Math.abs(startY - (newRow.y_pos ?? startY));

      if (updated && (dx > 4 || dy > 4)) {
        // Animate from the old position to the new one
        updated.group.set({ left: startX, top: startY });
        fabric.util.animate({
          startValue: 0,
          endValue:   1,
          duration:   380,
          easing:     fabric.util.ease.easeOutCubic,
          onChange: (v) => {
            updated.group.set({
              left: startX + ((newRow.x_pos ?? startX) - startX) * v,
              top:  startY + ((newRow.y_pos ?? startY) - startY) * v,
            });
            canvas.requestRenderAll();
          },
          onComplete: () => canvas.requestRenderAll(),
        });
      } else {
        canvas.renderAll();
      }
    } else {
      // Row appeared via UPDATE but we didn't have it — treat as INSERT
      addToCanvas(newRow);
      canvas.renderAll();
    }

  } else if (eventType === 'DELETE') {
    removeFromCanvas(oldRow.table_id);
    canvas.renderAll();
  }
}

/* ─────────────────────────────────────────────────────────────────────
   §14  ALLERGY PULSE ANIMATION
       Runs on BOTH views.
       Admin view: subtle static amber stroke + warning icon set in
                   buildAdminGroup; pulse adds urgency on top.
       TV view:    high-visibility pulsing stroke so food runners get
                   an immediate alert when passing the monitor.
   ───────────────────────────────────────────────────────────────────── */

/** Start the per-frame animation loop that pulses allergy-flagged tables. */
function startAllergyPulse() {
  if (allergyRafId) return; // already running

  const tick = () => {
    if (allergySet.size > 0) {
      // ~1.4-second sinusoidal cycle
      const t          = Date.now() / 700;
      const pulse      = (Math.sin(t * Math.PI * 2) + 1) / 2;  // 0 → 1 → 0
      const alpha      = 0.45 + pulse * 0.55;                    // 0.45 → 1.0
      const strokeW    = 3    + pulse * 7;                        // 3 → 10
      const strokeClr  = `rgba(245, 158, 11, ${alpha})`;

      let dirty = false;
      for (const tableId of allergySet) {
        const entry = tableMap.get(tableId);
        if (!entry) continue;
        const circle = entry.group.getObjects().find(o => o.name === 'circle');
        if (circle) {
          circle.set({ stroke: strokeClr, strokeWidth: strokeW });
          dirty = true;
        }
      }
      if (dirty) canvas.requestRenderAll();
    }

    allergyRafId = requestAnimationFrame(tick);
  };

  allergyRafId = requestAnimationFrame(tick);
}

/* ─────────────────────────────────────────────────────────────────────
   §15  TOAST NOTIFICATION
   ───────────────────────────────────────────────────────────────────── */
function showToast(message, type = 'info') {
  const el       = document.getElementById('toast');
  el.textContent = message;
  el.className   = 'visible' + (type === 'error' ? ' error' : '');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = '';
  }, 3200);
}

/* ─────────────────────────────────────────────────────────────────────
   §16  UTILITIES
   ───────────────────────────────────────────────────────────────────── */

/** Standard debounce — delays `fn` by `ms` after the last call. */
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Resolve after `n` animation frames.
 * Used at startup to let the browser complete flex layout before we
 * measure wrapper dimensions for the canvas.
 */
function rafTicks(n = 1) {
  return new Promise(resolve => {
    let count = 0;
    const step = () => (++count >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}
