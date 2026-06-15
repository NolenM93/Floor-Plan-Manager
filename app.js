/* ═══════════════════════════════════════════════════════════════════════
   SAGAMORE RESORT — FLOOR PLAN MANAGER  (v2 — complete)
   Requires: Fabric.js v5  +  Supabase JS v2
   Run db/migrations.sql in Supabase before deploying.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* ─────────────────────────────────────────────────────────────────────
   §1  CONFIGURATION
   ───────────────────────────────────────────────────────────────────── */
const SUPABASE_URL      = 'https://uttyrbthhlgrfoobfngu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0dHlyYnRoaGxncmZvb2Jmbmd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzOTYwMTcsImV4cCI6MjA5Njk3MjAxN30.t76SBJ5uiQVdoXgCQ48uxiimCTWxPh4aXDP4hUitiRs';

const TABLE_NAME  = 'wedding_tables';
const EVENTS_NAME = 'events';
const TEAMS_NAME  = 'teams';

const LOGICAL_W = 1600;
const LOGICAL_H = 900;
const ADMIN_R   = 56;
const TV_R      = 72;
const GRID_SIZE = 24;

const DEFAULT_COLOR = '#6B7280';

// Legacy fallback colours (pre-migration rows still using server_team)
const LEGACY_TEAM_COLORS = {
  'Team 1': '#4A90D9',
  'Team 2': '#E67E22',
  'Team 3': '#27AE60',
  'Team 4': '#9B59B6',
};

const EVENT_STORAGE_KEY = 'sagamore_active_event';

/* ─────────────────────────────────────────────────────────────────────
   §2  MUTABLE STATE
   ───────────────────────────────────────────────────────────────────── */
let db;
let canvas;
let currentView   = 'admin';
let currentEventId = null;
let eventsList    = [];

const tableMap   = new Map();   // table_id → { row, group }
const teamsMap   = new Map();   // team_id  → team row object
const allergySet = new Set();

let activeTeamId    = null;
let selectedTableId = null;
let allergyRafId    = null;
let toastTimer      = null;
let snapToGrid      = false;
let realtimeChannel = null;

// Echo-guard: skip realtime UPDATEs we just wrote ourselves
const recentlyEdited = new Map(); // table_id → { fields, ts }

/* ─────────────────────────────────────────────────────────────────────
   §3  BOOT
   ───────────────────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', async () => {
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const params    = new URLSearchParams(window.location.search);
  currentView     = params.get('view') === 'tv' ? 'tv' : 'admin';

  if (currentView === 'tv') {
    document.getElementById('admin-view').classList.add('hidden');
    document.getElementById('tv-view').classList.remove('hidden');
    await rafTicks(2);
    await initTVView(params.get('event'));
  } else {
    document.getElementById('tv-view').classList.add('hidden');
    await requireAuth();
    document.getElementById('admin-view').classList.remove('hidden');
    await rafTicks(2);
    await initAdminView(params.get('event'));
  }
});

/* ─────────────────────────────────────────────────────────────────────
   §4  AUTH  (admin only — TV stays anon read-only)
   ───────────────────────────────────────────────────────────────────── */
async function requireAuth() {
  const { data: { session } } = await db.auth.getSession();
  if (session) return;

  const overlay = document.getElementById('login-overlay');
  overlay.classList.remove('hidden');

  return new Promise((resolve) => {
    const form  = document.getElementById('login-form');
    const errEl = document.getElementById('login-error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.classList.add('hidden');

      const email    = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;

      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) {
        errEl.textContent = error.message;
        errEl.classList.remove('hidden');
        return;
      }

      overlay.classList.add('hidden');
      resolve();
    });
  });
}

async function handleLogout() {
  await db.auth.signOut();
  location.reload();
}

/* ─────────────────────────────────────────────────────────────────────
   §5  LOADING OVERLAY
   ───────────────────────────────────────────────────────────────────── */
function showLoading(msg = 'Loading floor plan…') {
  document.getElementById('loading-text').textContent = msg;
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

/* ─────────────────────────────────────────────────────────────────────
   §6  EVENT LAYER
   ───────────────────────────────────────────────────────────────────── */
async function loadEvents() {
  const { data, error } = await db
    .from(EVENTS_NAME)
    .select('*')
    .order('event_date', { ascending: false, nullsFirst: false });

  if (error) {
    showToast('Could not load events: ' + error.message, 'error');
    return [];
  }

  eventsList = data ?? [];
  return eventsList;
}

function safeStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* tracking prevention — silently skip */ }
}

function resolveEventId(urlParam) {
  if (urlParam) return urlParam;
  const stored = safeStorageGet(EVENT_STORAGE_KEY);
  if (stored) return stored;
  if (eventsList.length > 0) return eventsList[0].event_id;
  return 'event_default';
}

async function selectEvent(eventId) {
  if (!eventId) return;
  currentEventId = eventId;
  safeStorageSet(EVENT_STORAGE_KEY, eventId);

  // Sync URL without reload
  const url = new URL(window.location.href);
  url.searchParams.set('event', eventId);
  history.replaceState(null, '', url.toString());

  updateTVLink();
  updateEventPickerUI();

  const ev = eventsList.find(e => e.event_id === eventId);
  const tvName = document.getElementById('tv-event-name');
  if (tvName) tvName.textContent = ev ? ev.name : '';

  await loadTeams();
  await loadAllTables();
  renderTeamTabs();
  updateEmptyState();
  subscribeRealtime();
}

function updateEventPickerUI() {
  const picker = document.getElementById('event-picker');
  if (!picker) return;

  picker.innerHTML = '';
  for (const ev of eventsList) {
    const opt       = document.createElement('option');
    opt.value       = ev.event_id;
    opt.textContent = ev.name + (ev.event_date ? ` (${ev.event_date})` : '');
    if (ev.event_id === currentEventId) opt.selected = true;
    picker.appendChild(opt);
  }
}

function updateTVLink() {
  const link = document.getElementById('tv-link');
  if (link && currentEventId) {
    link.href = `?view=tv&event=${encodeURIComponent(currentEventId)}`;
  }
}

async function handleCreateEvent() {
  const name = document.getElementById('new-event-name').value.trim();
  const date = document.getElementById('new-event-date').value || null;
  if (!name) { showToast('Event name is required', 'error'); return; }

  const eventId = `event_${Date.now()}`;
  const { error } = await db.from(EVENTS_NAME).insert({ event_id: eventId, name, event_date: date });
  if (error) { showToast('Create event failed: ' + error.message, 'error'); return; }

  closeEventModal();
  await loadEvents();
  await selectEvent(eventId);
  showToast(`Event "${name}" created`);
}

function openEventModal() {
  document.getElementById('new-event-name').value = '';
  document.getElementById('new-event-date').value  = new Date().toISOString().slice(0, 10);
  document.getElementById('event-overlay').classList.remove('hidden');
  document.getElementById('new-event-name').focus();
}

function closeEventModal() {
  document.getElementById('event-overlay').classList.add('hidden');
}

/* ─────────────────────────────────────────────────────────────────────
   §7  TEAMS
   ───────────────────────────────────────────────────────────────────── */
async function loadTeams() {
  if (!currentEventId) return;

  const { data, error } = await db
    .from(TEAMS_NAME)
    .select('*')
    .eq('event_id', currentEventId)
    .order('sort_order', { ascending: true });

  if (error) {
    showToast('Could not load teams: ' + error.message, 'error');
    return;
  }

  teamsMap.clear();
  for (const t of (data ?? [])) teamsMap.set(t.team_id, t);
}

function teamColor(teamId) {
  if (!teamId) return DEFAULT_COLOR;
  return teamsMap.get(teamId)?.color ?? DEFAULT_COLOR;
}

/** Resolve colour for a table row (team_id preferred, legacy server_team fallback). */
function teamColorForRow(row) {
  if (row.team_id) return teamColor(row.team_id);
  if (row.server_team) return LEGACY_TEAM_COLORS[row.server_team] ?? DEFAULT_COLOR;
  return DEFAULT_COLOR;
}

function teamName(teamId) {
  if (!teamId) return null;
  return teamsMap.get(teamId)?.name ?? null;
}

function renderTeamSelectOptions() {
  const sel = document.getElementById('modal-server-team');
  if (!sel) return;

  const current = sel.value;
  sel.innerHTML = '<option value="">— Unassigned —</option>';

  const sorted = [...teamsMap.values()].sort((a, b) => a.sort_order - b.sort_order);
  for (const t of sorted) {
    const opt       = document.createElement('option');
    opt.value       = t.team_id;
    opt.textContent = t.name;
    sel.appendChild(opt);
  }

  sel.value = current;
}

function openTeamsModal() {
  renderTeamsList();
  document.getElementById('teams-overlay').classList.remove('hidden');
}

function closeTeamsModal() {
  document.getElementById('teams-overlay').classList.add('hidden');
}

function renderTeamsList() {
  const list = document.getElementById('teams-list');
  list.innerHTML = '';

  const sorted = [...teamsMap.values()].sort((a, b) => a.sort_order - b.sort_order);

  if (sorted.length === 0) {
    list.innerHTML = '<p class="teams-empty">No teams yet. Add one below.</p>';
    return;
  }

  for (const t of sorted) {
    const assigned = countTablesForTeam(t.team_id);
    const row      = document.createElement('div');
    row.className  = 'team-row';
    row.dataset.teamId = t.team_id;
    row.innerHTML = `
      <input type="color" class="team-color-input" value="${t.color}" title="Team color" />
      <input type="text"  class="team-name-input"  value="${escHtml(t.name)}" maxlength="32" />
      <span class="team-assigned-count">${assigned} table${assigned !== 1 ? 's' : ''}</span>
      <button class="icon-btn team-delete-btn" title="Delete team" aria-label="Delete team">&#x2715;</button>
    `;

    row.querySelector('.team-color-input').addEventListener('change', (e) => {
      handleUpdateTeam(t.team_id, { color: e.target.value });
    });

    row.querySelector('.team-name-input').addEventListener('change', (e) => {
      const name = e.target.value.trim();
      if (!name) { e.target.value = t.name; return; }
      handleUpdateTeam(t.team_id, { name });
    });

    row.querySelector('.team-delete-btn').addEventListener('click', () => {
      handleDeleteTeam(t.team_id);
    });

    list.appendChild(row);
  }
}

function countTablesForTeam(teamId) {
  let n = 0;
  for (const [, entry] of tableMap) {
    if (entry.row.team_id === teamId) n++;
  }
  return n;
}

async function handleAddTeam() {
  const name  = document.getElementById('new-team-name').value.trim();
  const color = document.getElementById('new-team-color').value;
  if (!name) { showToast('Team name is required', 'error'); return; }

  const teamId   = `team_${Date.now()}`;
  const maxOrder = [...teamsMap.values()].reduce((m, t) => Math.max(m, t.sort_order), 0);

  const { data, error } = await db.from(TEAMS_NAME)
    .insert({ team_id: teamId, event_id: currentEventId, name, color, sort_order: maxOrder + 1 })
    .select().single();

  if (error) { showToast('Add team failed: ' + error.message, 'error'); return; }

  teamsMap.set(data.team_id, data);
  document.getElementById('new-team-name').value = '';
  renderTeamsList();
  renderTeamSelectOptions();
  renderTeamTabs();
  showToast(`Team "${name}" added`);
}

async function handleUpdateTeam(teamId, updates) {
  const { data, error } = await db.from(TEAMS_NAME)
    .update(updates).eq('team_id', teamId).select().single();

  if (error) { showToast('Update team failed: ' + error.message, 'error'); return; }

  teamsMap.set(teamId, data);
  renderTeamSelectOptions();
  renderTeamTabs();

  // Refresh all table colours on canvas
  for (const [, entry] of tableMap) {
    if (entry.row.team_id === teamId) refreshOnCanvas(entry.row);
  }
  canvas.renderAll();
  if (activeTeamId) renderQueueList(activeTeamId);
}

async function handleDeleteTeam(teamId) {
  const team = teamsMap.get(teamId);
  if (!team) return;

  const assigned = countTablesForTeam(teamId);
  if (assigned > 0) {
    if (!window.confirm(
      `"${team.name}" has ${assigned} assigned table(s).\n\n` +
      'Delete anyway? Tables will become Unassigned.'
    )) return;

    // Unassign tables first
    const { error: unassignErr } = await db.from(TABLE_NAME)
      .update({ team_id: null })
      .eq('team_id', teamId)
      .eq('event_id', currentEventId);

    if (unassignErr) {
      showToast('Could not unassign tables: ' + unassignErr.message, 'error');
      return;
    }

    for (const [, entry] of tableMap) {
      if (entry.row.team_id === teamId) {
        entry.row.team_id = null;
        refreshOnCanvas(entry.row);
      }
    }
    canvas.renderAll();
  }

  const { error } = await db.from(TEAMS_NAME).delete().eq('team_id', teamId);
  if (error) { showToast('Delete team failed: ' + error.message, 'error'); return; }

  teamsMap.delete(teamId);
  if (activeTeamId === teamId) activeTeamId = null;
  renderTeamsList();
  renderTeamSelectOptions();
  renderTeamTabs();
  showToast(`Team "${team.name}" deleted`);
}

/* ─────────────────────────────────────────────────────────────────────
   §8  CANVAS SETUP
   ───────────────────────────────────────────────────────────────────── */
function setupCanvas(canvasElId, wrapperId) {
  const wrapper = document.getElementById(wrapperId);
  const w = wrapper.clientWidth  || window.innerWidth;
  const h = wrapper.clientHeight || (window.innerHeight - 64);

  canvas = new fabric.Canvas(canvasElId, {
    width: w, height: h,
    selection: false,
    renderOnAddRemove: false,
    enableRetinaScaling: true,
    preserveObjectStacking: true,
  });

  applyViewport();
}

function applyViewport() {
  if (!canvas) return;
  const scale   = Math.min(canvas.width / LOGICAL_W, canvas.height / LOGICAL_H);
  const offsetX = (canvas.width  - LOGICAL_W * scale) / 2;
  const offsetY = (canvas.height - LOGICAL_H * scale) / 2;
  canvas.setViewportTransform([scale, 0, 0, scale, offsetX, offsetY]);
}

window.addEventListener('resize', debounce(() => {
  if (!canvas) return;
  const wrapperId = currentView === 'tv' ? 'tv-canvas-wrapper' : 'canvas-wrapper';
  const wrapper   = document.getElementById(wrapperId);
  canvas.setDimensions({ width: wrapper.clientWidth, height: wrapper.clientHeight });
  applyViewport();
  canvas.renderAll();
}, 200));

/* ─────────────────────────────────────────────────────────────────────
   §9  TABLE SHAPE BUILDERS
   ───────────────────────────────────────────────────────────────────── */
function rowHasAllergy(row) {
  return !!(row.allergy_notes && row.allergy_notes.trim().length > 0);
}

function isOverCapacity(row) {
  return row.capacity > 0 && (row.guest_count ?? 0) > row.capacity;
}

function buildTableShape(row, radius, isTV) {
  const color   = teamColorForRow(row);
  const allergy = rowHasAllergy(row);
  const shape   = row.shape === 'rect' ? 'rect' : 'round';

  if (shape === 'rect') {
    const w = radius * 2.2;
    const h = radius * 1.4;
    return new fabric.Rect({
      width: w, height: h,
      fill: color,
      stroke: allergy ? '#F59E0B' : 'rgba(255,255,255,0.13)',
      strokeWidth: allergy ? 4 : 1.5,
      originX: 'center', originY: 'center',
      rx: 6, ry: 6,
      name: 'circle',
    });
  }

  return new fabric.Circle({
    radius,
    fill: color,
    stroke: allergy ? '#F59E0B' : 'rgba(255,255,255,0.13)',
    strokeWidth: allergy ? 4 : 1.5,
    originX: 'center', originY: 'center',
    name: 'circle',
  });
}

function buildAdminGroup(row) {
  const radius  = ADMIN_R;
  const allergy = rowHasAllergy(row);
  const shape   = buildTableShape(row, radius, false);

  const hasGuests   = (row.guest_count > 0);
  const overCap     = isOverCapacity(row);
  const labelText   = new fabric.Text(String(row.label ?? '?'), {
    fontSize: 31, fontFamily: 'Georgia, "Times New Roman", serif',
    fontWeight: 'bold', fill: '#FFFFFF',
    originX: 'center', originY: 'center',
    top: hasGuests ? -10 : 0,
    name: 'label',
    shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.5)', blur: 4, offsetX: 0, offsetY: 1 }),
  });

  const objects = [shape, labelText];

  if (hasGuests) {
    objects.push(new fabric.Text(`${row.guest_count} guests`, {
      fontSize: 13, fontFamily: '"Inter", "Segoe UI", Arial, sans-serif',
      fill: 'rgba(255,255,255,0.68)',
      originX: 'center', originY: 'center', top: 18, name: 'guests',
    }));
  }

  if (row.capacity > 0) {
    const capText = `${row.guest_count ?? 0}/${row.capacity}`;
    objects.push(new fabric.Text(capText, {
      fontSize: 11, fontFamily: '"Inter", "Segoe UI", Arial, sans-serif',
      fill: overCap ? '#F59E0B' : 'rgba(255,255,255,0.45)',
      originX: 'center', originY: 'center', top: 34, name: 'capacity',
    }));
  }

  if (allergy) {
    objects.push(new fabric.Text('\u26A0', {
      fontSize: 14, fontFamily: 'Arial, sans-serif', fill: '#F59E0B',
      originX: 'center', originY: 'center', top: radius - 19, name: 'allergy-ico',
    }));
  }

  const group = new fabric.Group(objects, {
    left: row.x_pos ?? LOGICAL_W / 2,
    top:  row.y_pos ?? LOGICAL_H / 2,
    originX: 'center', originY: 'center',
    selectable: true, evented: true, hoverCursor: 'move',
    hasControls: false, hasBorders: true,
    borderColor: 'rgba(255,255,255,0.30)', borderScaleFactor: 1.5,
    lockScalingX: true, lockScalingY: true, lockRotation: true,
    data: { table_id: row.table_id },
  });

  return group;
}

function buildTVGroup(row) {
  const radius = TV_R;
  const shape  = buildTableShape(row, radius, true);

  const labelText = new fabric.Text(String(row.label ?? '?'), {
    fontSize: 44, fontFamily: 'Georgia, "Times New Roman", serif',
    fontWeight: 'bold', fill: '#FFFFFF',
    originX: 'center', originY: 'center', top: -22, name: 'label',
  });

  const guestText = new fabric.Text(
    row.guest_count > 0 ? `${row.guest_count} guests` : '',
    {
      fontSize: 18, fontFamily: '"Inter", "Segoe UI", Arial, sans-serif',
      fill: 'rgba(255,255,255,0.62)',
      originX: 'center', originY: 'center', top: 10, name: 'guests',
    }
  );

  const parts = [];
  if (row.beef_count    > 0) parts.push(`${row.beef_count}B`);
  if (row.chicken_count > 0) parts.push(`${row.chicken_count}C`);
  if (row.fish_count    > 0) parts.push(`${row.fish_count}F`);

  const entreeText = new fabric.Text(parts.join(' \u00B7 '), {
    fontSize: 15, fontFamily: '"Inter", "Segoe UI", Arial, sans-serif',
    fill: 'rgba(255,255,255,0.42)',
    originX: 'center', originY: 'center', top: 32, name: 'entrees',
  });

  const objects = [shape, labelText, guestText, entreeText];

  if (row.capacity > 0) {
    const overCap = isOverCapacity(row);
    objects.push(new fabric.Text(`${row.guest_count ?? 0}/${row.capacity}`, {
      fontSize: 13, fontFamily: '"Inter", "Segoe UI", Arial, sans-serif',
      fill: overCap ? '#F59E0B' : 'rgba(255,255,255,0.35)',
      originX: 'center', originY: 'center', top: 50, name: 'capacity',
    }));
  }

  return new fabric.Group(objects, {
    left: row.x_pos ?? LOGICAL_W / 2,
    top:  row.y_pos ?? LOGICAL_H / 2,
    originX: 'center', originY: 'center',
    selectable: false, evented: false, hoverCursor: 'default',
    hasControls: false, hasBorders: false,
    data: { table_id: row.table_id },
  });
}

/* ─────────────────────────────────────────────────────────────────────
   §10  CANVAS TABLE CRUD
   ───────────────────────────────────────────────────────────────────── */
function addToCanvas(row) {
  const group = currentView === 'tv' ? buildTVGroup(row) : buildAdminGroup(row);
  canvas.add(group);
  tableMap.set(row.table_id, { row, group });

  if (rowHasAllergy(row)) allergySet.add(row.table_id);
  else                    allergySet.delete(row.table_id);

  return group;
}

function removeFromCanvas(tableId) {
  const entry = tableMap.get(tableId);
  if (!entry) return;
  canvas.remove(entry.group);
  tableMap.delete(tableId);
  allergySet.delete(tableId);
  if (selectedTableId === tableId) selectedTableId = null;
}

function refreshOnCanvas(row) {
  const existing = tableMap.get(row.table_id);
  if (existing) canvas.remove(existing.group);
  addToCanvas(row);
}

function updateEmptyState() {
  const el = document.getElementById('canvas-empty');
  if (!el) return;
  el.classList.toggle('hidden', tableMap.size > 0);
}

/* ─────────────────────────────────────────────────────────────────────
   §11  DATA LOADING
   ───────────────────────────────────────────────────────────────────── */
async function loadAllTables() {
  if (!currentEventId) return;

  const { data, error } = await db
    .from(TABLE_NAME)
    .select('*')
    .eq('event_id', currentEventId);

  if (error) {
    showToast('Could not load tables: ' + error.message, 'error');
    return;
  }

  canvas.clear();
  tableMap.clear();
  allergySet.clear();

  for (const row of (data ?? [])) addToCanvas(row);
  canvas.renderAll();
  updateEmptyState();
}

/* ─────────────────────────────────────────────────────────────────────
   §12  ADMIN VIEW INIT
   ───────────────────────────────────────────────────────────────────── */
async function initAdminView(urlEventParam) {
  showLoading('Loading events…');
  await loadEvents();
  currentEventId = resolveEventId(urlEventParam);
  hideLoading();

  setupCanvas('floor-canvas', 'canvas-wrapper');
  await selectEvent(currentEventId);
  bindAdminEvents();
  startAllergyPulse();
}

function bindAdminEvents() {
  canvas.on('object:modified', handleDragEnd);

  canvas.on('selection:created', (e) => {
    selectedTableId = e.selected?.[0]?.data?.table_id ?? null;
  });
  canvas.on('selection:updated', (e) => {
    selectedTableId = e.selected?.[0]?.data?.table_id ?? null;
  });
  canvas.on('selection:cleared', () => { selectedTableId = null; });

  canvas.on('mouse:down', (e) => {
    if (e.target?.data?.table_id) {
      selectedTableId = e.target.data.table_id;
      canvas.setActiveObject(e.target);
    }
  });

  canvas.on('mouse:dblclick', (e) => {
    if (!e.target?.data?.table_id) return;
    const entry = tableMap.get(e.target.data.table_id);
    if (entry) openModal(entry.row);
  });

  document.getElementById('add-table-btn').addEventListener('click', handleAddTable);
  document.getElementById('manage-teams-btn').addEventListener('click', openTeamsModal);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  document.getElementById('event-picker').addEventListener('change', (e) => {
    selectEvent(e.target.value);
  });
  document.getElementById('new-event-btn').addEventListener('click', openEventModal);
  document.getElementById('event-modal-close').addEventListener('click', closeEventModal);
  document.getElementById('event-modal-cancel').addEventListener('click', closeEventModal);
  document.getElementById('event-modal-create').addEventListener('click', handleCreateEvent);

  document.getElementById('teams-modal-close').addEventListener('click', closeTeamsModal);
  document.getElementById('teams-modal-done').addEventListener('click', closeTeamsModal);
  document.getElementById('add-team-btn').addEventListener('click', handleAddTeam);
  document.getElementById('teams-overlay').addEventListener('pointerdown', (e) => {
    if (e.target === e.currentTarget) closeTeamsModal();
  });

  document.getElementById('snap-toggle').addEventListener('change', (e) => {
    snapToGrid = e.target.checked;
  });

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('pointerdown', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('save-table-btn').addEventListener('click', handleSaveModal);
  document.getElementById('delete-table-btn').addEventListener('click', handleDeleteFromModal);
  document.getElementById('duplicate-table-btn').addEventListener('click', handleDuplicateTable);

  document.getElementById('modal-server-team').addEventListener('change', (e) => {
    document.getElementById('modal-color-swatch').style.background = teamColor(e.target.value || null);
  });

  document.getElementById('modal-guest-count').addEventListener('input', updateCapacityWarning);
  document.getElementById('modal-capacity').addEventListener('input', updateCapacityWarning);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeTeamsModal();
      closeEventModal();
    } else {
      handleKeyboard(e);
    }
  });
}

function updateCapacityWarning() {
  const guests   = parseInt(document.getElementById('modal-guest-count').value, 10) || 0;
  const capacity = parseInt(document.getElementById('modal-capacity').value, 10) || 0;
  const warn     = document.getElementById('capacity-warning');
  warn.classList.toggle('hidden', !(capacity > 0 && guests > capacity));
}

/* ─────────────────────────────────────────────────────────────────────
   §13  DRAG / SNAP
   ───────────────────────────────────────────────────────────────────── */
async function handleDragEnd(e) {
  const g = e.target;
  if (!g?.data?.table_id) return;

  let x_pos = g.left;
  let y_pos = g.top;

  if (snapToGrid) {
    x_pos = Math.round(x_pos / GRID_SIZE) * GRID_SIZE;
    y_pos = Math.round(y_pos / GRID_SIZE) * GRID_SIZE;
    g.set({ left: x_pos, top: y_pos });
    canvas.renderAll();
  }

  const { table_id } = g.data;
  const entry = tableMap.get(table_id);
  if (entry) { entry.row.x_pos = x_pos; entry.row.y_pos = y_pos; }

  markRecent(table_id, { x_pos, y_pos });

  const { error } = await db.from(TABLE_NAME)
    .update({ x_pos, y_pos })
    .eq('table_id', table_id);

  if (error) showToast('Position not saved — check connection', 'error');
}

function snapCoord(v) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

/* ─────────────────────────────────────────────────────────────────────
   §14  KEYBOARD CONTROLS
   ───────────────────────────────────────────────────────────────────── */
async function handleKeyboard(e) {
  if (document.getElementById('modal-overlay').classList.contains('hidden') === false) return;
  if (document.getElementById('teams-overlay').classList.contains('hidden') === false) return;
  if (document.getElementById('event-overlay').classList.contains('hidden') === false) return;

  if (!selectedTableId) return;
  const entry = tableMap.get(selectedTableId);
  if (!entry) return;

  const STEP = e.shiftKey ? GRID_SIZE : 8;
  let dx = 0, dy = 0;

  switch (e.key) {
    case 'ArrowLeft':  dx = -STEP; break;
    case 'ArrowRight': dx =  STEP; break;
    case 'ArrowUp':    dy = -STEP; break;
    case 'ArrowDown':  dy =  STEP; break;
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      if (window.confirm(`Delete Table ${entry.row.label}?\n\nThis removes it permanently.`)) {
        await deleteTableById(selectedTableId, entry.row.label);
      }
      return;
    default: return;
  }

  e.preventDefault();

  let newX = entry.group.left + dx;
  let newY = entry.group.top  + dy;

  if (snapToGrid) {
    newX = snapCoord(newX);
    newY = snapCoord(newY);
  }

  entry.group.set({ left: newX, top: newY });
  entry.row.x_pos = newX;
  entry.row.y_pos = newY;
  canvas.renderAll();

  markRecent(selectedTableId, { x_pos: newX, y_pos: newY });

  const { error } = await db.from(TABLE_NAME)
    .update({ x_pos: newX, y_pos: newY })
    .eq('table_id', selectedTableId);

  if (error) showToast('Position not saved', 'error');
}

/* ─────────────────────────────────────────────────────────────────────
   §15  ADD / EDIT / DELETE / DUPLICATE TABLE
   ───────────────────────────────────────────────────────────────────── */
async function handleAddTable() {
  let maxNum = 0;
  for (const [, entry] of tableMap) {
    const n = parseInt(entry.row.label, 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  }

  let x_pos = LOGICAL_W / 2 + (Math.random() - 0.5) * 160;
  let y_pos = LOGICAL_H / 2 + (Math.random() - 0.5) * 160;
  if (snapToGrid) { x_pos = snapCoord(x_pos); y_pos = snapCoord(y_pos); }

  const newRow = {
    table_id:      `table_${Date.now()}`,
    event_id:      currentEventId,
    label:         String(maxNum + 1),
    guest_count:   0,
    beef_count:    0,
    chicken_count: 0,
    fish_count:    0,
    team_id:       null,
    allergy_notes: null,
    shape:         'round',
    capacity:      null,
    x_pos, y_pos,
  };

  const { data, error } = await db.from(TABLE_NAME).insert(newRow).select().single();
  if (error) { showToast('Add table failed: ' + error.message, 'error'); return; }

  addToCanvas(data);
  canvas.renderAll();
  renderTeamTabs();
  updateEmptyState();
  showToast(`Table ${data.label} added`);
}

function openModal(row) {
  renderTeamSelectOptions();

  const $ = (id) => document.getElementById(id);
  $('modal-table-id').value    = row.table_id;
  $('modal-title').textContent = `Table ${row.label}`;
  $('modal-label').value       = row.label         ?? '';
  $('modal-guest-count').value = row.guest_count   ?? 0;
  $('modal-beef').value        = row.beef_count    ?? 0;
  $('modal-chicken').value     = row.chicken_count ?? 0;
  $('modal-fish').value        = row.fish_count    ?? 0;
  $('modal-server-team').value = row.team_id       ?? '';
  $('modal-allergy').value     = row.allergy_notes ?? '';
  $('modal-shape').value       = row.shape         ?? 'round';
  $('modal-capacity').value    = row.capacity      ?? '';
  $('modal-color-swatch').style.background = teamColorForRow(row);
  updateCapacityWarning();

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
  const optNum = (id) => {
    const v = document.getElementById(id).value;
    return v === '' ? null : Math.max(0, parseInt(v, 10) || 0);
  };

  const teamIdVal = strVal('modal-server-team') || null;

  const updates = {
    label:         strVal('modal-label').trim() || '?',
    guest_count:   numVal('modal-guest-count'),
    beef_count:    numVal('modal-beef'),
    chicken_count: numVal('modal-chicken'),
    fish_count:    numVal('modal-fish'),
    team_id:       teamIdVal,
    allergy_notes: strVal('modal-allergy').trim() || null,
    shape:         strVal('modal-shape') || 'round',
    capacity:      optNum('modal-capacity'),
  };

  markRecent(tableId, updates);

  const { data, error } = await db.from(TABLE_NAME)
    .update(updates).eq('table_id', tableId).select().single();

  if (error) { showToast('Save failed: ' + error.message, 'error'); return; }

  refreshOnCanvas(data);
  canvas.renderAll();
  renderTeamTabs();
  if (activeTeamId) renderQueueList(activeTeamId);
  closeModal();
  showToast(`Table ${data.label} saved`);
}

async function handleDeleteFromModal() {
  const tableId = document.getElementById('modal-table-id').value;
  const label   = document.getElementById('modal-label').value || tableId;
  if (!tableId) return;

  if (!window.confirm(`Delete Table ${label}?\n\nThis removes it permanently from the floor plan.`)) return;

  const ok = await deleteTableById(tableId, label);
  if (ok) closeModal();
}

async function deleteTableById(tableId, label) {
  const { error } = await db.from(TABLE_NAME).delete().eq('table_id', tableId);
  if (error) { showToast('Delete failed: ' + error.message, 'error'); return false; }

  removeFromCanvas(tableId);
  canvas.renderAll();
  renderTeamTabs();
  if (activeTeamId) renderQueueList(activeTeamId);
  updateEmptyState();
  showToast(`Table ${label} deleted`);
  return true;
}

async function handleDuplicateTable() {
  const tableId = document.getElementById('modal-table-id').value;
  const entry   = tableMap.get(tableId);
  if (!entry) return;

  const src = entry.row;
  let x_pos = (src.x_pos ?? LOGICAL_W / 2) + 80;
  let y_pos = (src.y_pos ?? LOGICAL_H / 2) + 60;
  if (snapToGrid) { x_pos = snapCoord(x_pos); y_pos = snapCoord(y_pos); }

  const newRow = {
    table_id:      `table_${Date.now()}`,
    event_id:      currentEventId,
    label:         src.label + ' copy',
    guest_count:   src.guest_count   ?? 0,
    beef_count:    src.beef_count    ?? 0,
    chicken_count: src.chicken_count ?? 0,
    fish_count:    src.fish_count    ?? 0,
    team_id:       src.team_id       ?? null,
    allergy_notes: src.allergy_notes ?? null,
    shape:         src.shape         ?? 'round',
    capacity:      src.capacity      ?? null,
    x_pos, y_pos,
  };

  const { data, error } = await db.from(TABLE_NAME).insert(newRow).select().single();
  if (error) { showToast('Duplicate failed: ' + error.message, 'error'); return; }

  addToCanvas(data);
  canvas.renderAll();
  renderTeamTabs();
  updateEmptyState();
  closeModal();
  showToast(`Table duplicated as "${data.label}"`);
}

/* ─────────────────────────────────────────────────────────────────────
   §16  SERVICE PASS QUEUE
   ───────────────────────────────────────────────────────────────────── */
function renderTeamTabs() {
  const container = document.getElementById('team-tabs');
  if (!container) return;

  const sorted = [...teamsMap.values()].sort((a, b) => a.sort_order - b.sort_order);

  container.innerHTML = '';

  if (sorted.length === 0) {
    container.innerHTML =
      '<span class="teams-hint">No teams yet — click <strong>Manage Teams</strong> to add one.</span>';
    document.getElementById('queue-list').innerHTML =
      '<p class="queue-placeholder">Add server teams first,<br>then assign them to tables.</p>';
    document.getElementById('queue-summary').textContent = '';
    return;
  }

  // Show ALL teams as tabs, even those with 0 assigned tables
  sorted.forEach(team => {
    const btn = document.createElement('button');
    btn.className   = 'team-tab' + (activeTeamId === team.team_id ? ' active' : '');
    btn.dataset.teamId = team.team_id;
    btn.textContent = team.name;
    btn.style.setProperty('--team-color', team.color);

    if (activeTeamId === team.team_id) {
      btn.style.background   = hexToRgba(team.color, 0.18);
      btn.style.color        = team.color;
      btn.style.borderColor  = hexToRgba(team.color, 0.5);
    }

    btn.addEventListener('click', () => {
      activeTeamId = team.team_id;
      container.querySelectorAll('.team-tab').forEach(b => {
        b.classList.remove('active');
        b.style.background  = '';
        b.style.color       = '';
        b.style.borderColor = '';
      });
      btn.classList.add('active');
      btn.style.background  = hexToRgba(team.color, 0.18);
      btn.style.color       = team.color;
      btn.style.borderColor = hexToRgba(team.color, 0.5);
      renderQueueList(team.team_id);
    });

    container.appendChild(btn);
  });

  if (activeTeamId && teamsMap.has(activeTeamId)) {
    renderQueueList(activeTeamId);
  }
}

function renderQueueList(teamId) {
  const team = teamsMap.get(teamId);
  const rows = [];
  for (const [, entry] of tableMap) {
    if (entry.row.team_id === teamId) rows.push(entry.row);
  }

  rows.sort((a, b) => {
    const na = parseInt(a.label, 10), nb = parseInt(b.label, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a.label).localeCompare(String(b.label));
  });

  const list = document.getElementById('queue-list');

  if (rows.length === 0) {
    const hasAnyTables = tableMap.size > 0;
    const hint = hasAnyTables
      ? `Double-click a table on the canvas, then pick <strong>${escHtml(team?.name ?? 'this team')}</strong> from the team dropdown.`
      : `Click <strong>+ Add Table</strong> to place a table, then double-click it to assign it to <strong>${escHtml(team?.name ?? 'this team')}</strong>.`;
    list.innerHTML = `<p class="queue-placeholder">${hint}</p>`;
    document.getElementById('queue-summary').textContent = '';
    return;
  }

  let totBeef = 0, totChicken = 0, totFish = 0, totGuests = 0;

  const itemsHTML = rows.map(row => {
    totBeef    += row.beef_count    ?? 0;
    totChicken += row.chicken_count ?? 0;
    totFish    += row.fish_count    ?? 0;
    totGuests  += row.guest_count   ?? 0;

    const entreePills = [];
    if (row.beef_count    > 0) entreePills.push(`<span class="queue-entree-count"><span class="queue-dot beef"></span>${row.beef_count} Beef</span>`);
    if (row.chicken_count > 0) entreePills.push(`<span class="queue-entree-count"><span class="queue-dot chicken"></span>${row.chicken_count} Chicken</span>`);
    if (row.fish_count    > 0) entreePills.push(`<span class="queue-entree-count"><span class="queue-dot fish"></span>${row.fish_count} Fish</span>`);

    const entreeHTML = entreePills.length
      ? `<div class="queue-entrees">${entreePills.join('')}</div>`
      : `<div class="queue-entrees" style="font-size:12px;color:#404666">No entr\u00e9es recorded</div>`;

    const allergyHTML = row.allergy_notes
      ? `<div class="queue-allergy-flag"><span>\u26A0</span>${escHtml(row.allergy_notes)}</div>`
      : '';

    const capHTML = row.capacity > 0
      ? `<span class="queue-guest-pill${isOverCapacity(row) ? ' over-cap' : ''}">${row.guest_count ?? 0}/${row.capacity}</span>`
      : `<span class="queue-guest-pill">${row.guest_count ?? 0} guests</span>`;

    return `
      <div class="queue-item" data-table-id="${row.table_id}">
        <div class="queue-table-num">
          Table ${escHtml(String(row.label))}
          ${capHTML}
        </div>
        ${entreeHTML}
        ${allergyHTML}
      </div>`;
  }).join('');

  list.innerHTML = itemsHTML;

  // Click queue item → open modal
  list.querySelectorAll('.queue-item').forEach(el => {
    el.addEventListener('click', () => {
      const entry = tableMap.get(el.dataset.tableId);
      if (entry) openModal(entry.row);
    });
  });

  document.getElementById('queue-summary').innerHTML =
    `${rows.length} tables &nbsp;&middot;&nbsp; ${totGuests} guests &nbsp;&middot;&nbsp; ` +
    `<span style="color:#C0392B">${totBeef}B</span>&nbsp;` +
    `<span style="color:#D4A017">${totChicken}C</span>&nbsp;` +
    `<span style="color:#2980B9">${totFish}F</span>`;
}

/* ─────────────────────────────────────────────────────────────────────
   §17  TV VIEW
   ───────────────────────────────────────────────────────────────────── */
async function initTVView(urlEventParam) {
  showLoading('Connecting to floor plan…');
  await loadEvents();
  currentEventId = resolveEventId(urlEventParam);
  hideLoading();

  setupCanvas('tv-canvas', 'tv-canvas-wrapper');
  await loadTeams();
  await loadAllTables();

  const ev = eventsList.find(e => e.event_id === currentEventId);
  const tvName = document.getElementById('tv-event-name');
  if (tvName) tvName.textContent = ev ? ev.name : '';

  startTVClock();
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
   §18  REALTIME  (both views)
   ───────────────────────────────────────────────────────────────────── */
function subscribeRealtime() {
  if (realtimeChannel) {
    db.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  const statusEl     = document.getElementById('tv-connection-status');
  const lastUpdateEl = document.getElementById('tv-last-update');

  const channel = db.channel(`floor-plan-${currentEventId}`);

  channel.on('postgres_changes', {
    event: '*', schema: 'public', table: TABLE_NAME,
    filter: `event_id=eq.${currentEventId}`,
  }, (payload) => {
    handleTableRealtime(payload);
    if (lastUpdateEl) {
      lastUpdateEl.textContent = 'Last update: ' +
        new Date().toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
        });
    }
  });

  channel.on('postgres_changes', {
    event: '*', schema: 'public', table: TEAMS_NAME,
    filter: `event_id=eq.${currentEventId}`,
  }, (payload) => {
    handleTeamRealtime(payload);
  });

  channel.subscribe((status) => {
    if (!statusEl) return;
    if (status === 'SUBSCRIBED') {
      statusEl.textContent = '\u25CF Live';
      statusEl.className   = 'status-live';
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      statusEl.textContent = '\u25CF Connection lost \u2014 reconnecting\u2026';
      statusEl.className   = 'status-error';
      setTimeout(() => location.reload(), 6000);
    }
  });

  realtimeChannel = channel;
}

function handleTableRealtime({ eventType, new: newRow, old: oldRow }) {
  if (eventType === 'UPDATE' && isEcho(newRow.table_id, newRow)) return;

  if (eventType === 'INSERT') {
    if (!tableMap.has(newRow.table_id)) {
      addToCanvas(newRow);
      canvas.renderAll();
      renderTeamTabs();
      updateEmptyState();
    }

  } else if (eventType === 'UPDATE') {
    const existing = tableMap.get(newRow.table_id);

    if (existing) {
      const startX = existing.group.left;
      const startY = existing.group.top;

      refreshOnCanvas(newRow);

      const updated = tableMap.get(newRow.table_id);
      const dx = Math.abs(startX - (newRow.x_pos ?? startX));
      const dy = Math.abs(startY - (newRow.y_pos ?? startY));

      if (updated && (dx > 4 || dy > 4)) {
        updated.group.set({ left: startX, top: startY });
        fabric.util.animate({
          startValue: 0, endValue: 1, duration: 380,
          easing: fabric.util.ease.easeOutCubic,
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
      addToCanvas(newRow);
      canvas.renderAll();
    }

    renderTeamTabs();
    if (activeTeamId) renderQueueList(activeTeamId);

  } else if (eventType === 'DELETE') {
    removeFromCanvas(oldRow.table_id);
    canvas.renderAll();
    renderTeamTabs();
    if (activeTeamId) renderQueueList(activeTeamId);
    updateEmptyState();
  }
}

function handleTeamRealtime({ eventType, new: newRow, old: oldRow }) {
  if (eventType === 'INSERT' || eventType === 'UPDATE') {
    teamsMap.set(newRow.team_id, newRow);
  } else if (eventType === 'DELETE') {
    teamsMap.delete(oldRow.team_id);
    if (activeTeamId === oldRow.team_id) activeTeamId = null;
  }

  renderTeamSelectOptions();
  renderTeamTabs();

  // Refresh table colours
  for (const [, entry] of tableMap) {
    refreshOnCanvas(entry.row);
  }
  canvas.renderAll();
  if (activeTeamId) renderQueueList(activeTeamId);

  if (currentView === 'admin' && !document.getElementById('teams-overlay').classList.contains('hidden')) {
    renderTeamsList();
  }
}

/* ─────────────────────────────────────────────────────────────────────
   §19  ECHO GUARD
   ───────────────────────────────────────────────────────────────────── */
function markRecent(tableId, fields) {
  recentlyEdited.set(tableId, { fields, ts: Date.now() });
  setTimeout(() => recentlyEdited.delete(tableId), 2500);
}

function isEcho(tableId, row) {
  const recent = recentlyEdited.get(tableId);
  if (!recent || Date.now() - recent.ts > 2500) return false;

  for (const [key, val] of Object.entries(recent.fields)) {
    const incoming = row[key];
    if (key === 'x_pos' || key === 'y_pos') {
      if (Math.abs((incoming ?? 0) - (val ?? 0)) > 2) return false;
    } else if (incoming !== val) {
      return false;
    }
  }
  return true;
}

/* ─────────────────────────────────────────────────────────────────────
   §20  ALLERGY PULSE
   ───────────────────────────────────────────────────────────────────── */
function startAllergyPulse() {
  if (allergyRafId) return;

  const tick = () => {
    if (allergySet.size > 0) {
      const t         = Date.now() / 700;
      const pulse     = (Math.sin(t * Math.PI * 2) + 1) / 2;
      const alpha     = 0.45 + pulse * 0.55;
      const strokeW   = 3 + pulse * 7;
      const strokeClr = `rgba(245, 158, 11, ${alpha})`;

      let dirty = false;
      for (const tableId of allergySet) {
        const entry = tableMap.get(tableId);
        if (!entry) continue;
        const shape = entry.group.getObjects().find(o => o.name === 'circle');
        if (shape) {
          shape.set({ stroke: strokeClr, strokeWidth: strokeW });
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
   §21  TOAST
   ───────────────────────────────────────────────────────────────────── */
function showToast(message, type = 'info') {
  const el       = document.getElementById('toast');
  el.textContent = message;
  el.className   = 'visible' + (type === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

/* ─────────────────────────────────────────────────────────────────────
   §22  UTILITIES
   ───────────────────────────────────────────────────────────────────── */
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function rafTicks(n = 1) {
  return new Promise(resolve => {
    let count = 0;
    const step = () => (++count >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
