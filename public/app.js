const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const STORAGE_KEY = 'rsa.session.v1';

function getAnalysisIdFromUrl() {
  const u = new URL(window.location.href);
  return u.searchParams.get('a');
}
function setAnalysisIdInUrl(id) {
  const u = new URL(window.location.href);
  if (id) u.searchParams.set('a', id);
  else u.searchParams.delete('a');
  history.replaceState({}, '', u.toString());
}
function readFiltersFromForm() {
  return {
    include_pozo: !!$('#include-pozo')?.checked,
    include_construccion: !!$('#include-construccion')?.checked,
    require_pool: !!$('#require-pool')?.checked,
    require_garage: !!$('#require-garage')?.checked,
    min_rooms: Number($('#min-rooms')?.value) || undefined,
    max_rooms: Number($('#max-rooms')?.value) || undefined,
    min_yield: Number($('#min-yield')?.value) ? Number($('#min-yield').value) / 100 : undefined,
    min_build_yield: Number($('#min-build-yield')?.value)
      ? Number($('#min-build-yield').value) / 100
      : undefined,
  };
}
function applyFiltersToForm(filters = {}) {
  $('#include-pozo').checked = !!filters.include_pozo;
  $('#include-construccion').checked = !!filters.include_construccion;
  $('#require-pool').checked = !!filters.require_pool;
  $('#require-garage').checked = !!filters.require_garage;
  $('#min-rooms').value = filters.min_rooms ?? '';
  $('#max-rooms').value = filters.max_rooms ?? '';
  $('#min-yield').value = filters.min_yield != null ? filters.min_yield * 100 : 5;
  $('#min-build-yield').value =
    filters.min_build_yield != null ? filters.min_build_yield * 100 : 5;
}

const state = {
  neighborhoods: [],
  jobId: null,
  pollHandle: null,
  allNeighborhoods: [],
  activeSuggestion: -1,
  currentMatches: [],
  rankingItems: [],
  rankingView: {
    rooms: [], // empty = all
    statuses: [], // empty = all
    amenities: [], // empty = all (values: 'pool', 'garage')
    sortBy: 'score',
    sortDir: 'desc',
    mode: 'table', // 'table' | 'map' — toggle in ranking section
  },
  refreshJobs: {}, // key = source|n|op → { jobId, pollHandle }
  // Multi-analysis selection. `analyses` is the ordered list of analyses
  // the user has selected. `activeAnalysisId` is the one currently shown in
  // per-analysis blocks (stats + sources) — switched via the tab bar. The
  // ranking table + map merge across ALL selected analyses, so this picker
  // only affects the per-analysis cards.
  // `analysis` is kept as an alias to the active one so the dozens of
  // `state.analysis?.id` reads scattered around the file don't need
  // touching — setActiveAnalysis() keeps them in sync.
  analyses: [], // selected analyses (full objects), ordered by add time
  activeAnalysisId: null,
  analysis: null, // = analyses.find(a => a.id === activeAnalysisId), or null
  map: null, // Leaflet map instance (lazy-init when user opens the tab)
  mapLayers: { markers: null, polygons: null }, // layer groups we add/clear per render
  // Listings the user has clicked "Ver listing" on. Persisted in localStorage
  // so they survive reloads. Used to render those markers (and table rows)
  // greyed out, so the user can tell at a glance which they've already
  // opened. Stored as Set<number> in memory; serialized to a plain array.
  viewedListings: (() => {
    try {
      const raw = localStorage.getItem('viewedListings');
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  })(),
};

// =====================================================================
// Multi-analysis selection helpers.
// =====================================================================
//
// We persist just the IDs in localStorage; the full objects are re-fetched
// on page load via /api/analyses/:id (one request per id, in parallel).
// Active id is also persisted so the user lands on the same tab they left.
const SELECTION_LS_KEY = 'analysisSelection';

function persistSelection() {
  try {
    localStorage.setItem(
      SELECTION_LS_KEY,
      JSON.stringify({
        ids: state.analyses.map((a) => a.id),
        activeId: state.activeAnalysisId,
      }),
    );
  } catch { /* private mode / quota — ignore */ }
}

// Switch which selected analysis the per-analysis blocks (stats + sources)
// render for. Keeps `state.analysis` pointing at the active one so old code
// that reads `state.analysis?.id` keeps working. Re-renders the tabs +
// per-analysis blocks. Does NOT re-fetch the ranking/map (those are merged
// across all selected, independent of which tab is active).
function setActiveAnalysis(id) {
  state.activeAnalysisId = id;
  state.analysis = state.analyses.find((a) => a.id === id) || null;
  persistSelection();
  setAnalysisIdInUrl(id);
  renderCurrentAnalysisBar();
  // Per-analysis blocks (stats + "estado por fuente") re-render for the
  // newly active tab. Ranking + map already span all selected so they're
  // untouched.
  const aid = state.activeAnalysisId;
  if (aid) {
    renderStats(aid).catch((e) => console.warn('renderStats failed', e));
    loadSources(aid).catch((e) => console.warn('loadSources failed', e));
  }
}

// Add a fully-loaded analysis object to the selection. If it's already
// selected, just switch to it. Triggers re-fetch of the merged ranking/map
// because the universe of properties changed.
async function addAnalysisToSelection(analysis, { makeActive = true } = {}) {
  if (!state.analyses.some((a) => a.id === analysis.id)) {
    state.analyses.push(analysis);
  }
  if (makeActive) setActiveAnalysis(analysis.id);
  else { renderCurrentAnalysisBar(); persistSelection(); }
  await loadRanking();
}

// Drop one analysis from the selection. Picks another as active if the
// removed one was active. If the selection becomes empty, falls back to
// the legacy "no analysis selected" state.
async function removeAnalysisFromSelection(id) {
  state.analyses = state.analyses.filter((a) => a.id !== id);
  if (state.activeAnalysisId === id) {
    const next = state.analyses[0]?.id || null;
    setActiveAnalysis(next);
  }
  persistSelection();
  renderCurrentAnalysisBar();
  if (state.analyses.length === 0) {
    state.rankingItems = [];
    state.analysis = null;
    state.activeAnalysisId = null;
    setAnalysisIdInUrl(null);
    $('#ranking-section').classList.add('hidden');
    $('#stats-section').classList.add('hidden');
    $('#sources-section').classList.add('hidden');
    return;
  }
  await loadRanking();
}

// Track that the user opened a listing's URL. Updates the in-memory Set
// and persists. Caller is responsible for re-rendering whatever shows the
// viewed state.
function markListingViewed(id) {
  if (id == null || state.viewedListings.has(id)) return false;
  state.viewedListings.add(id);
  try {
    localStorage.setItem('viewedListings', JSON.stringify([...state.viewedListings]));
  } catch { /* localStorage full / private mode — ignore */ }
  return true;
}

function persistSession() {
  try {
    const snapshot = {
      analysisId: state.analysis?.id || null,
      neighborhoods: state.neighborhoods,
      jobId: state.jobId,
      filters: {
        include_pozo: $('#include-pozo').checked,
        include_construccion: $('#include-construccion').checked,
        min_yield: $('#min-yield').value,
        min_build_yield: $('#min-build-yield').value,
        min_rooms: $('#min-rooms').value,
        max_rooms: $('#max-rooms').value,
        require_pool: $('#require-pool').checked,
        require_garage: $('#require-garage').checked,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // localStorage unavailable; not fatal.
  }
}

function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearJobFromSession() {
  state.jobId = null;
  persistSession();
}

const MAX_SUGGESTIONS = 8;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadFx() {
  try {
    const r = await fetch('/api/fx');
    const j = await r.json();
    if (j.mep_sell) {
      $('#fx-value').textContent = `compra ${fmtNum(j.mep_buy)} / venta ${fmtNum(j.mep_sell)}`;
    } else {
      $('#fx-value').textContent = 'no disponible';
    }
  } catch {
    $('#fx-value').textContent = 'error';
  }
}

async function loadNeighborhoods() {
  const r = await fetch('/api/neighborhoods');
  const j = await r.json();
  state.allNeighborhoods = (j.neighborhoods || []).map((n) => ({
    ...n,
    _norm: normalize([n.id, n.display, ...(n.aliases || [])].join(' ')),
    _displayNorm: normalize(n.display),
  }));
}

function matchNeighborhoods(query) {
  const q = normalize(query);
  if (!q) return [];
  const selected = new Set(state.neighborhoods);
  const exact = [];
  const prefix = [];
  const contains = [];
  for (const n of state.allNeighborhoods) {
    if (selected.has(n.id)) continue;
    if (n._displayNorm === q || n.id === q) exact.push(n);
    else if (n._displayNorm.startsWith(q) || n.id.startsWith(q)) prefix.push(n);
    else if (n._norm.includes(q)) contains.push(n);
  }
  return [...exact, ...prefix, ...contains].slice(0, MAX_SUGGESTIONS);
}

function highlightMatch(text, query) {
  const norm = normalize(text);
  const q = normalize(query);
  if (!q) return text;
  const idx = norm.indexOf(q);
  if (idx < 0) return text;
  // Map normalized index back to the original string (close enough; both share length when
  // the original has no diacritics, and slightly imprecise when it does — acceptable).
  return (
    text.slice(0, idx) +
    '<mark>' +
    text.slice(idx, idx + q.length) +
    '</mark>' +
    text.slice(idx + q.length)
  );
}

function renderSuggestions(query) {
  const ul = $('#neighborhoods-suggestions');
  const matches = matchNeighborhoods(query);
  state.currentMatches = matches;
  state.activeSuggestion = matches.length ? 0 : -1;
  ul.innerHTML = '';
  if (!matches.length) {
    if (!query.trim()) {
      ul.hidden = true;
      return;
    }
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Sin coincidencias';
    ul.appendChild(li);
    ul.hidden = false;
    return;
  }
  matches.forEach((n, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.index = String(i);
    if (i === state.activeSuggestion) li.classList.add('active');
    const left = document.createElement('span');
    left.innerHTML = highlightMatch(n.display, query);
    const right = document.createElement('span');
    right.className = 'region';
    right.textContent = n.region;
    li.appendChild(left);
    li.appendChild(right);
    li.addEventListener('mousedown', (e) => {
      // mousedown (not click) fires before the input loses focus, avoiding the blur-close race.
      e.preventDefault();
      selectNeighborhood(n);
    });
    ul.appendChild(li);
  });
  ul.hidden = false;
}

function selectNeighborhood(n) {
  if (!state.neighborhoods.includes(n.id)) {
    state.neighborhoods.push(n.id);
    renderChips();
  }
  const input = $('#neighborhoods-input');
  input.value = '';
  $('#neighborhoods-suggestions').hidden = true;
  state.currentMatches = [];
  state.activeSuggestion = -1;
  input.focus();
}

function setActiveSuggestion(idx) {
  const ul = $('#neighborhoods-suggestions');
  const items = ul.querySelectorAll('li[role="option"]');
  if (!items.length) return;
  state.activeSuggestion = (idx + items.length) % items.length;
  items.forEach((li, i) => li.classList.toggle('active', i === state.activeSuggestion));
  const active = items[state.activeSuggestion];
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function renderChips() {
  const el = $('#selected-neighborhoods');
  el.innerHTML = '';
  for (const n of state.neighborhoods) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = n;
    const x = document.createElement('button');
    x.textContent = '×';
    x.onclick = () => {
      state.neighborhoods = state.neighborhoods.filter((m) => m !== n);
      renderChips();
      persistSession();
    };
    chip.appendChild(x);
    el.appendChild(chip);
  }
  persistSession();
}

const nbhInput = $('#neighborhoods-input');
nbhInput.addEventListener('input', (e) => renderSuggestions(e.target.value));
nbhInput.addEventListener('focus', (e) => {
  if (e.target.value.trim()) renderSuggestions(e.target.value);
});
nbhInput.addEventListener('blur', () => {
  // Delay so a click on a suggestion can fire first.
  setTimeout(() => {
    $('#neighborhoods-suggestions').hidden = true;
  }, 120);
});
nbhInput.addEventListener('keydown', (e) => {
  const ul = $('#neighborhoods-suggestions');
  const items = ul.querySelectorAll('li[role="option"]');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!items.length) {
      if (e.target.value.trim()) renderSuggestions(e.target.value);
      return;
    }
    setActiveSuggestion(state.activeSuggestion + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    setActiveSuggestion(state.activeSuggestion - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (state.activeSuggestion >= 0 && state.currentMatches[state.activeSuggestion]) {
      selectNeighborhood(state.currentMatches[state.activeSuggestion]);
    }
  } else if (e.key === 'Escape') {
    ul.hidden = true;
    state.currentMatches = [];
    state.activeSuggestion = -1;
  } else if (e.key === 'Backspace' && !e.target.value && state.neighborhoods.length) {
    // Backspace on empty input removes the last chip.
    state.neighborhoods.pop();
    renderChips();
  }
});

$('#analyze').addEventListener('click', async () => {
  if (!state.neighborhoods.length) {
    alert('Agregá al menos un barrio.');
    return;
  }
  $('#analyze').disabled = true;
  try {
    const filters = readFiltersFromForm();
    const r = await fetch('/api/analyses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ neighborhoods: state.neighborhoods, filters }),
    });
    if (!r.ok) throw new Error('create analysis failed: ' + r.status);
    const analysis = await r.json();
    // Add to the multi-selection rather than replacing. If the user already
    // had other analyses open, the new one shows up as a new tab and
    // becomes active.
    if (!state.analyses.some((a) => a.id === analysis.id)) {
      state.analyses.push(analysis);
    }
    state.activeAnalysisId = analysis.id;
    state.analysis = analysis;
    setAnalysisIdInUrl(analysis.id);
    persistSelection();
    renderCurrentAnalysisBar();

    // Trigger a scrape for this analysis. force=true on first creation? No —
    // upsertAnalysis returns existing one if signature matches; we still
    // scrape (incremental) to refresh. The Analizar button always triggers.
    const force = !!$('#force')?.checked;
    const sr = await fetch(`/api/analyses/${analysis.id}/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    if (!sr.ok) throw new Error('scrape start failed: ' + sr.status);
    const sj = await sr.json();
    state.jobId = sj.job_id;
    persistSession();

    $('#job-status').classList.remove('hidden');
    $('#job-progress').innerHTML = '<div>Lanzando job…</div>';
    pollJob();
  } catch (err) {
    alert('No se pudo iniciar: ' + err.message);
    $('#analyze').disabled = false;
  }
});

$('#refresh-analysis')?.addEventListener('click', async () => {
  if (!state.analysis) return;
  $('#refresh-analysis').disabled = true;
  try {
    const sr = await fetch(`/api/analyses/${state.analysis.id}/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    if (!sr.ok) throw new Error('scrape start failed: ' + sr.status);
    const sj = await sr.json();
    state.jobId = sj.job_id;
    persistSession();
    $('#analyze').disabled = true;
    $('#job-status').classList.remove('hidden');
    pollJob();
  } catch (err) {
    alert('No se pudo refrescar: ' + err.message);
  } finally {
    $('#refresh-analysis').disabled = false;
  }
});

$('#new-analysis')?.addEventListener('click', () => {
  // "Nuevo análisis" clears the WHOLE multi-selection, not just one tab.
  // (To drop a single analysis without losing the others, the user clicks
  // the × on its tab.)
  state.analyses = [];
  state.activeAnalysisId = null;
  state.analysis = null;
  state.neighborhoods = [];
  state.rankingItems = [];
  state.jobId = null;
  persistSelection();
  setAnalysisIdInUrl(null);
  applyFiltersToForm({});
  renderChips();
  renderCurrentAnalysisBar();
  $('#stats-section').classList.add('hidden');
  $('#ranking-section').classList.add('hidden');
  $('#sources-section').classList.add('hidden');
  $('#job-status').classList.add('hidden');
  const enrichBar = document.getElementById('enrich-status');
  if (enrichBar) {
    enrichBar.classList.add('hidden');
    enrichBar.innerHTML = '';
  }
  if (state.enrichPollHandle) clearTimeout(state.enrichPollHandle);
  state.enrichPollHandle = null;
  if (state.enrichFreshHandle) clearInterval(state.enrichFreshHandle);
  state.enrichFreshHandle = null;
  state.lastEnrichPending = 0;
  loadRecentAnalyses();
});

function pct(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n / 100 : 0.05;
}

async function pollJob() {
  if (state.pollHandle) clearTimeout(state.pollHandle);
  if (!state.jobId) return;
  try {
    const r = await fetch(`/api/jobs/${state.jobId}`);
    if (r.status === 404) {
      // Job no longer exists (cleared from DB?). Drop it.
      clearJobFromSession();
      return;
    }
    const job = await r.json();
    renderJobProgress(job);
    if (job.status === 'completed' || job.status === 'failed') {
      $('#analyze').disabled = false;
      if (job.status === 'completed') {
        await loadResults();
        await loadRecentAnalyses();
      }
      return;
    }
  } catch (e) {
    console.warn('poll error', e);
  }
  state.pollHandle = setTimeout(pollJob, 2000);
}

async function restoreSession() {
  // Priority 1: multi-selection persisted from the previous session.
  // Read both lists + active id, fetch each analysis in parallel, and
  // restore the tabs in their original order. If any id 404s (was deleted
  // server-side), we just skip it and continue with the rest.
  let restoredFromSelection = false;
  try {
    const raw = localStorage.getItem(SELECTION_LS_KEY);
    if (raw) {
      const sel = JSON.parse(raw);
      const ids = Array.isArray(sel?.ids) ? sel.ids.filter(Boolean) : [];
      if (ids.length) {
        const fetched = await Promise.all(
          ids.map((id) =>
            fetch('/api/analyses/' + encodeURIComponent(id))
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null),
          ),
        );
        const valid = fetched.filter(Boolean);
        if (valid.length) {
          state.analyses = valid;
          state.activeAnalysisId = sel.activeId && valid.some((a) => a.id === sel.activeId)
            ? sel.activeId
            : valid[0].id;
          state.analysis = valid.find((a) => a.id === state.activeAnalysisId);
          state.neighborhoods = [...state.analysis.neighborhoods];
          applyFiltersToForm(state.analysis.filters);
          renderChips();
          renderCurrentAnalysisBar();
          setAnalysisIdInUrl(state.activeAnalysisId);
          await loadResults();
          await loadRecentAnalyses();
          restoredFromSelection = true;
        }
      }
    }
  } catch (e) {
    console.warn('could not restore multi-selection', e);
  }
  if (restoredFromSelection) return;

  // Priority 2: URL has ?a=<analysis_id> → load that analysis (single).
  const urlAid = getAnalysisIdFromUrl();
  if (urlAid) {
    try {
      const r = await fetch('/api/analyses/' + encodeURIComponent(urlAid));
      if (r.ok) {
        const analysis = await r.json();
        await loadAnalysisIntoUI(analysis);
        await loadResults();
        await loadRecentAnalyses();
        return;
      }
    } catch (e) {
      console.warn('could not load analysis from URL', e);
    }
  }
  // Priority 3: legacy single-analysis snapshot from localStorage.
  const snapshot = readSession();
  if (snapshot?.analysisId) {
    try {
      const r = await fetch('/api/analyses/' + encodeURIComponent(snapshot.analysisId));
      if (r.ok) {
        const analysis = await r.json();
        await loadAnalysisIntoUI(analysis);
        await loadResults();
        await loadRecentAnalyses();
        return;
      }
    } catch {
      // fall through to the legacy path
    }
  }
  // No active analysis — just show the recents list and let the user pick.
  await loadRecentAnalyses();
}

// Adds the given analysis to the selection (if not already there) and makes
// it the active tab. The ranking + map re-fetch and merge across all
// selected. The "neighborhoods chips" / filters form reflect the active
// tab's setup so the user knows what created the active block.
async function loadAnalysisIntoUI(analysis) {
  if (!state.analyses.some((a) => a.id === analysis.id)) {
    state.analyses.push(analysis);
  }
  state.activeAnalysisId = analysis.id;
  state.analysis = analysis;
  state.neighborhoods = [...analysis.neighborhoods];
  applyFiltersToForm(analysis.filters);
  renderChips();
  renderCurrentAnalysisBar();
  setAnalysisIdInUrl(analysis.id);
  persistSession();
  persistSelection();

  // Bump view count on the server.
  fetch(`/api/analyses/${analysis.id}/view`, { method: 'POST' }).catch(() => {});

  // If the analysis has a running scrape job, attach to it.
  if (analysis.last_scrape_job_id) {
    try {
      const r = await fetch(`/api/jobs/${analysis.last_scrape_job_id}`);
      if (r.ok) {
        const job = await r.json();
        if (job.status === 'running') {
          state.jobId = job.id;
          $('#job-status').classList.remove('hidden');
          renderJobProgress(job);
          $('#analyze').disabled = true;
          pollJob();
          return;
        }
      }
    } catch {
      // ignore
    }
  }
  await loadResults();
  await loadRecentAnalyses();
}

function renderCurrentAnalysisBar() {
  const bar = $('#analysis-current');
  if (!state.analyses.length) {
    bar.classList.add('hidden');
    $('#refresh-analysis').classList.add('hidden');
    $('#new-analysis').classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  $('#refresh-analysis').classList.remove('hidden');
  $('#new-analysis').classList.remove('hidden');

  // Tab strip: one tab per selected analysis. Active tab is highlighted;
  // clicking another tab switches the per-analysis blocks (stats + sources)
  // to that analysis. The ranking + map below merge across ALL tabs.
  const tabs = state.analyses
    .map((a) => {
      const active = a.id === state.activeAnalysisId ? ' active' : '';
      const label = escapeHtml(a.neighborhoods.join(', '));
      return `<button class="analysis-tab${active}" data-id="${a.id}" title="${escapeHtml(a.label || '')}">
        <span class="analysis-tab-label">${label}</span>
        <span class="analysis-tab-close" data-close="${a.id}" title="Quitar de la selección">×</span>
      </button>`;
    })
    .join('');
  const merged = state.analyses.length > 1
    ? `<div class="analysis-merged-note">Ranking + mapa muestran las ${state.analyses.length} búsquedas combinadas. Las cards de estadísticas / fuentes son del tab activo.</div>`
    : '';

  // Filter pills + ID/CLI snippet for the ACTIVE tab.
  const a = state.analysis;
  let activeBlock = '';
  if (a) {
    const pillFilters = [];
    const f = a.filters || {};
    if (f.min_rooms || f.max_rooms) pillFilters.push(`${f.min_rooms ?? '?'}-${f.max_rooms ?? '?'} amb`);
    if (f.require_pool) pillFilters.push('🏊');
    if (f.require_garage) pillFilters.push('🚗');
    if (f.include_pozo) pillFilters.push('+ pozo');
    if (f.include_construccion) pillFilters.push('+ obra');
    if (f.min_yield) pillFilters.push(`yield≥${(f.min_yield * 100).toFixed(1)}%`);
    activeBlock = `
      <div class="analysis-active-meta">
        ${pillFilters.length ? '<span>filtros: ' + pillFilters.join(' · ') + '</span>' : '<span>sin filtros adicionales</span>'}
      </div>
      <div class="analysis-id-row">
        <span class="analysis-id-label">ID:</span>
        <code class="analysis-id">${a.id}</code>
        <button class="btn-copy" data-copy="${a.id}" title="Copiar ID">copiar id</button>
        <button class="btn-copy" data-copy="node --env-file=.env scripts/run-analysis.js ${a.id}" title="Copiar comando CLI">copiar comando</button>
      </div>`;
  }

  bar.innerHTML = `
    <div class="analysis-tabs">${tabs}</div>
    ${merged}
    ${activeBlock}
  `;

  // Wire tab clicks (switch active) and close buttons (remove from
  // selection). Close handler runs first to avoid the click bubbling into
  // the parent tab's switch handler.
  bar.querySelectorAll('.analysis-tab-close').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      removeAnalysisFromSelection(btn.dataset.close);
    };
  });
  bar.querySelectorAll('.analysis-tab').forEach((tab) => {
    tab.onclick = () => {
      const id = tab.dataset.id;
      if (id !== state.activeAnalysisId) setActiveAnalysis(id);
    };
  });
  bar.querySelectorAll('.btn-copy').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const text = b.dataset.copy;
      navigator.clipboard?.writeText(text);
      const original = b.textContent;
      b.textContent = '✓ copiado';
      setTimeout(() => { b.textContent = original; }, 1200);
    };
  });
}

async function loadRecentAnalyses() {
  try {
    const r = await fetch('/api/analyses');
    if (!r.ok) return;
    const data = await r.json();
    const list = data.analyses || [];
    if (!list.length) {
      $('#recent-analyses').classList.add('hidden');
      return;
    }
    $('#recent-analyses').classList.remove('hidden');
    const c = $('#recent-analyses-list');
    c.innerHTML = list
      .map((a) => {
        const pillFilters = [];
        const f = a.filters || {};
        if (f.min_rooms || f.max_rooms) pillFilters.push(`${f.min_rooms ?? '?'}-${f.max_rooms ?? '?'} amb`);
        if (f.require_pool) pillFilters.push('🏊');
        if (f.require_garage) pillFilters.push('🚗');
        if (f.include_pozo) pillFilters.push('+ pozo');
        if (f.include_construccion) pillFilters.push('+ obra');
        if (f.min_yield) pillFilters.push(`yield≥${(f.min_yield * 100).toFixed(1)}%`);
        const isSelected = state.analyses.some((x) => x.id === a.id);
        const cls = isSelected ? ' analysis-card-selected' : '';
        const button = isSelected
          ? `<button class="btn-refresh" data-action="activate">activar →</button>`
          : `<button class="btn-refresh" data-action="add">+ agregar</button>`;
        return `<div class="analysis-card${cls}" data-id="${a.id}">
          <div>
            <div class="label">${a.neighborhoods.join(', ')}
              ${pillFilters.map((p) => `<span class="pill">${p}</span>`).join('')}
            </div>
            <div class="meta">${relativeTime(a.last_viewed_at)} · visto ${a.view_count}× ·
              <code class="analysis-id-small">${a.id}</code>
              <button class="btn-copy-small" data-copy="${a.id}" title="Copiar ID">copiar</button>
            </div>
          </div>
          ${button}
        </div>`;
      })
      .join('');
    // Copy buttons inside the card meta row — must intercept the click so it
    // doesn't bubble up to the card and open the analysis.
    c.querySelectorAll('.btn-copy-small').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(b.dataset.copy);
        const original = b.textContent;
        b.textContent = '✓';
        setTimeout(() => { b.textContent = original; }, 1200);
      };
    });
    c.querySelectorAll('.analysis-card').forEach((card) => {
      card.onclick = async () => {
        const id = card.dataset.id;
        // If already in selection, just switch to that tab — don't re-fetch.
        if (state.analyses.some((a) => a.id === id)) {
          setActiveAnalysis(id);
          return;
        }
        try {
          const r = await fetch('/api/analyses/' + encodeURIComponent(id));
          if (!r.ok) return;
          const analysis = await r.json();
          // ADD to selection (don't replace) and make it the active tab.
          // Then refresh the merged ranking + per-analysis stats.
          state.jobId = null;
          await loadAnalysisIntoUI(analysis);
          await loadResults();
          await loadRecentAnalyses();
        } catch (e) {
          console.warn('could not open analysis', e);
        }
      };
    });
  } catch (e) {
    console.warn('loadRecentAnalyses failed', e);
  }
}

function renderJobProgress(job) {
  const el = $('#job-progress');
  // Two event streams: scrape (phase undefined) keyed by source×operation,
  // and enrich (phase='enrich') keyed by source. Render each stream in its
  // own collapsed view so the user sees one row per stable identity.
  const latestScrape = new Map();
  const latestEnrich = new Map();
  for (const p of job.progress || []) {
    if (p.phase === 'enrich') {
      latestEnrich.set(`${p.neighborhood}|${p.source}`, p);
    } else {
      latestScrape.set(`${p.neighborhood}|${p.source}|${p.operation}`, p);
    }
  }
  const scrapeRows = [...latestScrape.values()].sort((a, b) => {
    if (a.neighborhood !== b.neighborhood) return a.neighborhood.localeCompare(b.neighborhood);
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.operation.localeCompare(b.operation);
  });
  const enrichRows = [...latestEnrich.values()].sort((a, b) => {
    if (a.neighborhood !== b.neighborhood) return a.neighborhood.localeCompare(b.neighborhood);
    return a.source.localeCompare(b.source);
  });

  const scrapeLines = scrapeRows.map((p) => {
    const cls = p.status === 'done' ? (p.ok ? 'ok' : 'bad') : 'warn';
    const counts = p.counts
      ? `new=${p.counts.new ?? 0} upd=${p.counts.updated ?? 0} unch=${p.counts.unchanged ?? 0}${
          p.counts.skipped ? ' skip=' + p.counts.skipped : ''
        }`
      : '';
    const err = p.error ? `<span class="badge bad">err: ${escapeHtml(p.error)}</span>` : '';
    return `<div class="row-progress">
      <span>${p.neighborhood}</span>
      <span class="badge">${p.source}</span>
      <span class="badge ${cls}">${p.status} · ${p.operation}${p.mode ? ' · ' + p.mode : ''}</span>
      <span>${counts} ${err}</span>
    </div>`;
  });

  const enrichLines = enrichRows.map((p) => {
    const cls = p.status === 'done' ? 'ok' : 'warn';
    const ratio = p.total ? `${p.enriched ?? 0}/${p.total}` : `${p.enriched ?? 0}`;
    const healed = p.healed ? ` healed=${p.healed}` : '';
    const failed = p.failed ? ` failed=${p.failed}` : '';
    return `<div class="row-progress">
      <span>${p.neighborhood}</span>
      <span class="badge">${p.source}</span>
      <span class="badge ${cls}">enrich · ${p.status}</span>
      <span>${ratio}${healed}${failed}</span>
    </div>`;
  });

  const head = `<div>Status: <b>${job.status}</b> · ${scrapeRows.length} scrapers${enrichRows.length ? ' · ' + enrichRows.length + ' enrichers' : ''}</div>`;
  const enrichHeader = enrichLines.length ? '<div style="color:var(--muted);font-size:11px;margin-top:8px;text-transform:uppercase;letter-spacing:.05em;">Enrichment</div>' : '';
  el.innerHTML = head + scrapeLines.join('') + enrichHeader + enrichLines.join('');
}

async function loadResults() {
  const aid = state.analysis?.id;
  await Promise.all([renderStats(aid), loadRanking(aid), loadSources(aid)]);
  // Kick off the background-enrich poller. It self-stops once pending hits 0.
  pollEnrichStatus();
}

// While the scrape job is already "completed", the enrichment phase keeps
// running in the background to pull detail-page fields (m², age, address).
// This poller surfaces a banner with the pending count and auto-refreshes
// the results once enrichment drains.
async function pollEnrichStatus() {
  if (state.enrichPollHandle) clearTimeout(state.enrichPollHandle);
  const q = state.neighborhoods.join(',');
  if (!q) return;
  let data;
  try {
    const r = await fetch('/api/stats/enrich-status?neighborhoods=' + encodeURIComponent(q));
    if (!r.ok) return;
    data = await r.json();
  } catch {
    return;
  }
  const bar = document.getElementById('enrich-status');
  if (!bar) return;
  // Banner stays visible while EITHER enrichment or geocoding has pending
  // work. Hiding it only on `pending<=0` would dismiss the bar while the
  // geocoder is still processing thousands of addresses in the background.
  const stillEnriching = (data.pending || 0) > 0;
  const stillGeocoding = (data.pending_geocode || 0) > 0;
  if (!stillEnriching && !stillGeocoding) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    // One last refresh so freshly-enriched fields show up.
    if (state.lastEnrichPending > 0 || state.lastPendingGeocode > 0) {
      const aid = state.analysis?.id;
      await Promise.all([renderStats(aid), loadRanking(aid)]);
    }
    state.lastEnrichPending = 0;
    state.lastPendingGeocode = 0;
    return;
  }
  const enriched = Math.max(0, (data.total || 0) - (data.pending || 0));
  const pct = data.total ? Math.round((enriched / data.total) * 100) : 0;
  const geoAvailable = typeof data.pending_geocode === 'number';
  const failedGeo = Number(data.failed_geocode) || 0;
  const geoLine = data.pending_geocode > 0
    ? ` · ${data.pending_geocode} pendientes de geocoding`
    : '';
  const failedLine = failedGeo > 0 ? ` · ${failedGeo} fallidos` : '';
  // When enrichment is done but geocoding is still running, switch the
  // headline so it doesn't say "100%" forever — the user wants to see that
  // there's still work happening.
  const headline = stillEnriching
    ? `Enriqueciendo en background: <b>${enriched}/${data.total}</b> (${pct}%)${geoLine}${failedLine}`
    : (data.pending_geocode > 0
        ? `Geocodificando direcciones: <b>${data.pending_geocode}</b> pendientes${failedLine}`
        : `Geocoding completo${failedLine}`);
  const now = Date.now();
  state.lastEnrichPollAt = now;
  state.lastPendingGeocode = data.pending_geocode || 0;
  bar.classList.remove('hidden');
  // Show the "forzar geocoding" button when the sub-zones flag is on (server
  // returns `pending_geocode` as a number) — it's safe even with 0 pendings
  // because the user may want to backfill ML/Remax addresses first.
  const geoButton = geoAvailable
    ? '<button id="enrich-geo-btn" class="btn-small" title="Backfill addresses de ML/Remax y disparar el loop de geocoding ahora">Forzar geocoding</button>'
    : '';
  const retryFailedButton = failedGeo > 0
    ? `<button id="enrich-retry-failed-btn" class="btn-small" title="Limpia el marker geocode_failed_at de los ${failedGeo} listings que fallaron y re-corre el geocoder">Reintentar fallidos (${failedGeo})</button>`
    : '';
  bar.innerHTML = `
    <span>${headline} <span class="enrich-fresh" data-ts="${now}">· actualizado recién</span></span>
    <span style="display:flex;gap:8px;">
      ${retryFailedButton}
      ${geoButton}
      <button id="enrich-refresh-btn" class="btn-small">Refrescar resultados</button>
    </span>
  `;
  document.getElementById('enrich-refresh-btn').onclick = async () => {
    const aid = state.analysis?.id;
    await Promise.all([renderStats(aid), loadRanking(aid), loadSources(aid)]);
  };
  const retryFailedBtn = document.getElementById('enrich-retry-failed-btn');
  if (retryFailedBtn) {
    retryFailedBtn.onclick = async () => {
      retryFailedBtn.disabled = true;
      retryFailedBtn.textContent = 'Reintentando…';
      try {
        const neighborhoods = (state.analysis?.neighborhoods || []).join(',');
        const url = '/api/stats/retry-failed-geocoding' + (neighborhoods ? `?neighborhoods=${encodeURIComponent(neighborhoods)}` : '');
        const r = await fetch(url, { method: 'POST' });
        const out = await r.json();
        if (r.ok) {
          retryFailedBtn.textContent = `OK: ${out.reset} reseteados`;
          setTimeout(() => pollEnrichStatus(), 2000);
        } else {
          retryFailedBtn.textContent = `Falló: ${out.error || r.status}`;
          setTimeout(() => { retryFailedBtn.disabled = false; retryFailedBtn.textContent = `Reintentar fallidos (${failedGeo})`; }, 4000);
        }
      } catch (err) {
        retryFailedBtn.textContent = `Error: ${err.message}`;
        setTimeout(() => { retryFailedBtn.disabled = false; retryFailedBtn.textContent = `Reintentar fallidos (${failedGeo})`; }, 4000);
      }
    };
  }
  const geoBtn = document.getElementById('enrich-geo-btn');
  if (geoBtn) {
    geoBtn.onclick = async () => {
      geoBtn.disabled = true;
      geoBtn.textContent = 'Procesando…';
      try {
        const r = await fetch('/api/stats/run-geocoding', { method: 'POST' });
        const out = await r.json();
        if (r.ok) {
          geoBtn.textContent = `OK: ${out.backfilled} backfilled, ${out.pending_geocode} en cola`;
          // Re-fetch enrich-status soon so the user sees the new pending count.
          setTimeout(() => pollEnrichStatus(), 2000);
        } else {
          geoBtn.textContent = `Falló: ${out.error || r.status}`;
          setTimeout(() => { geoBtn.disabled = false; geoBtn.textContent = 'Forzar geocoding'; }, 4000);
        }
      } catch (err) {
        geoBtn.textContent = `Error: ${err.message}`;
        setTimeout(() => { geoBtn.disabled = false; geoBtn.textContent = 'Forzar geocoding'; }, 4000);
      }
    };
  }
  // Tick the freshness label every 30s so the user sees the timestamp
  // advance between polls (poll fires once on load, then every 15 min).
  if (state.enrichFreshHandle) clearInterval(state.enrichFreshHandle);
  state.enrichFreshHandle = setInterval(() => {
    const el = document.querySelector('#enrich-status .enrich-fresh');
    if (!el) { clearInterval(state.enrichFreshHandle); state.enrichFreshHandle = null; return; }
    const ts = Number(el.dataset.ts) || 0;
    const ago = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (ago < 60) el.textContent = `· hace ${ago}s`;
    else if (ago < 3600) el.textContent = `· hace ${Math.round(ago / 60)} min`;
    else el.textContent = `· hace ${Math.round(ago / 3600)} h`;
  }, 30_000);
  // Sub-zone labels are computed continuously by the background geocoder, so
  // refresh the chip panel of every visible neighborhood-block on each poll.
  document.querySelectorAll('.neighborhood-block[data-neighborhood]').forEach((block) => {
    const n = block.dataset.neighborhood;
    if (n) populateSubZonePanel(block, n, null);
  });
  state.lastEnrichPending = data.pending;
  // First poll fires immediately on page-load (from loadResults); subsequent
  // polls every 15 min — enough to see meaningful progress on a slow ML
  // enrich without hammering the endpoint or animating the banner.
  state.enrichPollHandle = setTimeout(pollEnrichStatus, 15 * 60 * 1000);
}

async function loadSources() {
  const q = state.neighborhoods.join(',');
  if (!q) return;
  const r = await fetch('/api/sources?neighborhoods=' + encodeURIComponent(q));
  const data = await r.json();
  renderSources(data.sources || []);
}

function relativeTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min atrás`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h atrás`;
  return `${Math.floor(h / 24)}d atrás`;
}

function renderSources(rows) {
  $('#sources-section').classList.remove('hidden');
  const c = $('#sources-container');
  if (!rows.length) {
    c.innerHTML = '<div style="color:var(--muted)">Sin barrios seleccionados.</div>';
    return;
  }
  // Group by neighborhood for cleaner reading.
  const byNb = new Map();
  for (const r of rows) {
    if (!byNb.has(r.neighborhood)) byNb.set(r.neighborhood, []);
    byNb.get(r.neighborhood).push(r);
  }
  let html = '';
  for (const [nb, items] of byNb.entries()) {
    const body = items
      .map((it) => {
        const key = `${it.source}|${it.neighborhood}|${it.operation}`;
        const refresh = state.refreshJobs[key];
        const btnLabel = refresh ? 'refrescando…' : 'refrescar';
        const btnClass = refresh ? 'btn-refresh running' : 'btn-refresh';
        const total = it.active_count || 0;
        const inactive = it.inactive_count ? ` <span class="ago">(${it.inactive_count} inactivos)</span>` : '';
        // Show incompletos (universe of listings still missing fields) and,
        // when different, how many of those are eligible to retry right now
        // (the rest are within their 24h cooldown).
        const inc = it.incomplete_total || 0;
        let pending = '';
        if (inc > 0) {
          const ready = it.pending_enrich || 0;
          const readyHint = ready === inc ? '' : ` (${ready} listos)`;
          const color = ready > 0 ? 'var(--warn)' : 'var(--muted)';
          pending = ` <span class="ago" style="color:${color}">· ${inc} incompletos${readyHint}</span>`;
        }
        const lastScrape = it.last_incremental_scrape_at || it.last_full_scrape_at;
        const mode = it.last_incremental_scrape_at && (!it.last_full_scrape_at || it.last_incremental_scrape_at > it.last_full_scrape_at)
          ? 'incremental' : 'full';
        return `<tr>
          <td>${it.source}</td>
          <td>${it.operation}</td>
          <td class="num">${total}${inactive}${pending}</td>
          <td>${lastScrape ? `${mode} · <span class="ago">${relativeTime(lastScrape)}</span>` : '<span class="ago">nunca</span>'}</td>
          <td>
            <button class="${btnClass}"
              data-source="${it.source}"
              data-neighborhood="${it.neighborhood}"
              data-operation="${it.operation}"
              ${refresh ? 'disabled' : ''}>${btnLabel}</button>
            ${(() => {
              if (!it.incomplete_total) return '';
              const enrichKey = `enrich|${it.source}|${it.neighborhood}`;
              const enrichJob = state.refreshJobs[enrichKey];
              const isRunning = !!enrichJob;
              const progress = enrichJob?.progress;
              const flightStr = progress?.in_flight
                ? ` (${progress.in_flight} en curso${progress.agent_in_flight ? `, ${progress.agent_in_flight} agente` : ''})`
                : '';
              // The button always forces: it re-attempts every incomplete
              // listing regardless of when it was last touched.
              const label = isRunning
                ? `enriqueciendo… ${progress ? `${progress.enriched}/${progress.total}${flightStr}` : ''}`
                : `forzar enrich (${it.incomplete_total})`;
              const cls = isRunning ? 'btn-refresh running' : 'btn-refresh';
              return `<button class="${cls}"
                data-action="enrich-pending"
                data-source="${it.source}"
                data-neighborhood="${it.neighborhood}"
                style="margin-left:6px"
                ${isRunning ? 'disabled' : ''}
                title="Re-procesa TODOS los listings incompletos (ignora cooldown de 24h)">${label}</button>
              <button class="btn-info-pending"
                data-source="${it.source}"
                data-neighborhood="${it.neighborhood}"
                title="Ver los listings pendientes (auditar)">ℹ️</button>`;
            })()}
          </td>
        </tr>`;
      })
      .join('');
    html += `<div class="neighborhood-block">
      <h3>${nb}</h3>
      <table class="sources-table">
        <thead><tr><th>Fuente</th><th>Operación</th><th class="num">Listings activos</th><th>Último scrape</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  }
  c.innerHTML = html;
  c.querySelectorAll('button.btn-refresh').forEach((b) => {
    if (b.disabled) return;
    if (b.dataset.action === 'enrich-pending') {
      b.onclick = (e) => retryPending(b.dataset.source, b.dataset.neighborhood, e.currentTarget);
    } else {
      b.onclick = (e) =>
        refreshSource(b.dataset.source, b.dataset.neighborhood, b.dataset.operation, e.currentTarget);
    }
  });
  c.querySelectorAll('button.btn-info-pending').forEach((b) => {
    b.onclick = () => openPendingModal(b.dataset.source, b.dataset.neighborhood);
  });
}

function missingFieldsList(row) {
  const missing = [];
  if (row.covered_m2 == null) missing.push('cubierta');
  if (row.total_m2 == null) missing.push('total');
  if (row.age_years == null) missing.push('antigüedad');
  return missing;
}

async function openPendingModal(source, neighborhood) {
  const existing = document.querySelector('.modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>Pendientes · ${escapeHtml(source)} / ${escapeHtml(neighborhood)}</h3>
        <button class="modal-close" title="Cerrar">×</button>
      </div>
      <div class="modal-body"><div style="color:var(--muted)">Cargando…</div></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('.modal-close').onclick = () => overlay.remove();

  let data;
  try {
    const r = await fetch(
      `/api/sources/pending-listings?source=${encodeURIComponent(source)}&neighborhood=${encodeURIComponent(neighborhood)}`,
    );
    if (!r.ok) throw new Error('status ' + r.status);
    data = await r.json();
  } catch (err) {
    overlay.querySelector('.modal-body').innerHTML =
      `<div style="color:var(--bad)">Error: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const pendingRows = (data.pending || [])
    .map((row) => {
      const missing = missingFieldsList(row);
      return `<tr>
        <td><a href="${row.url}" target="_blank" rel="noopener"><code>${row.external_id}</code></a></td>
        <td>${row.operation}</td>
        <td>${row.status || '-'}</td>
        <td class="num">${row.covered_m2 ?? '-'}</td>
        <td class="num">${row.total_m2 ?? '-'}</td>
        <td class="num">${row.age_years ?? '-'}</td>
        <td>${missing.map((m) => `<span class="badge bad">${m}</span>`).join(' ')}</td>
        <td>${row.enrich_attempted_at ? relativeTime(row.enrich_attempted_at) : '<span class="ago">nunca</span>'}</td>
      </tr>`;
    })
    .join('');

  const attemptedRows = (data.recently_attempted || [])
    .map((row) => {
      const missing = missingFieldsList(row);
      return `<tr>
        <td><a href="${row.url}" target="_blank" rel="noopener"><code>${row.external_id}</code></a></td>
        <td>${row.operation}</td>
        <td class="num">${row.covered_m2 ?? '-'}</td>
        <td class="num">${row.total_m2 ?? '-'}</td>
        <td class="num">${row.age_years ?? '-'}</td>
        <td>${missing.map((m) => `<span class="badge warn">${m}</span>`).join(' ')}</td>
        <td>${relativeTime(row.enrich_attempted_at)}</td>
      </tr>`;
    })
    .join('');

  overlay.querySelector('.modal-body').innerHTML = `
    <div style="color:var(--muted);font-size:12px;margin-bottom:10px">
      Para auditar: abrí el link, fijate si la publicación realmente tiene el dato.
      Si el sitio lo muestra y acá falta, es bug del parser.
      Si el sitio no lo muestra, está bien marcado como faltante.
    </div>
    <h4 style="margin:8px 0 4px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em">
      Sin intentar / vencidos (${(data.pending || []).length})
    </h4>
    ${
      pendingRows
        ? `<table class="modal-table">
            <thead><tr>
              <th>ID</th><th>Op</th><th>Status</th>
              <th class="num">m² cub</th><th class="num">m² tot</th><th class="num">Años</th>
              <th>Falta</th><th>Último intento</th>
            </tr></thead>
            <tbody>${pendingRows}</tbody>
          </table>`
        : '<div style="color:var(--muted)">Ninguno.</div>'
    }
    <h4 style="margin:16px 0 4px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em">
      Intentados recientemente (${(data.recently_attempted || []).length})
    </h4>
    <div style="color:var(--muted);font-size:11px;margin-bottom:6px">
      Ya se intentó enriquecerlos en las últimas 24 h y todavía faltan datos.
      No vuelven a entrar al ciclo hasta que pase el cooldown.
    </div>
    ${
      attemptedRows
        ? `<table class="modal-table">
            <thead><tr>
              <th>ID</th><th>Op</th>
              <th class="num">m² cub</th><th class="num">m² tot</th><th class="num">Años</th>
              <th>Falta</th><th>Cuándo</th>
            </tr></thead>
            <tbody>${attemptedRows}</tbody>
          </table>`
        : '<div style="color:var(--muted)">Ninguno.</div>'
    }
  `;
}

async function retryPending(source, neighborhood, btn) {
  if (btn) {
    btn.disabled = true;
    btn.classList.add('running');
    btn.textContent = 'enriqueciendo…';
  }
  let r;
  try {
    r = await fetch('/api/sources/enrich-pending', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, neighborhood, force: true }),
    });
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('running');
      btn.textContent = 'retry pendientes';
    }
    alert('No se pudo iniciar enrichment: ' + err.message);
    return;
  }
  if (!r.ok) {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('running');
      btn.textContent = 'retry pendientes';
    }
    alert('Error iniciando enrichment: ' + r.status);
    return;
  }
  const { job_id } = await r.json();
  // Poll the job until it finishes, then re-render the sources panel.
  const key = `enrich|${source}|${neighborhood}`;
  state.refreshJobs[key] = { jobId: job_id, startedAt: Date.now() };
  pollRefresh(key, 1500);
}

async function refreshSource(source, neighborhood, operation, btn) {
  const key = `${source}|${neighborhood}|${operation}`;
  if (state.refreshJobs[key]) return;

  // Synchronous, race-free visual feedback. We mutate the clicked button
  // *before* awaiting anything so the user always sees the state flip even
  // if the job completes in milliseconds.
  const startedAt = Date.now();
  if (btn) {
    btn.disabled = true;
    btn.classList.add('running');
    btn.textContent = 'refrescando…';
    btn.dataset.startedAt = String(startedAt);
  }
  state.refreshJobs[key] = { jobId: null, startedAt };

  let r;
  try {
    r = await fetch('/api/sources/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, neighborhood, operation, mode: 'full' }),
    });
  } catch (err) {
    delete state.refreshJobs[key];
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('running');
      btn.textContent = 'refrescar';
    }
    alert('No se pudo iniciar el refresh: ' + err.message);
    return;
  }
  if (!r.ok) {
    delete state.refreshJobs[key];
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('running');
      btn.textContent = 'refrescar';
    }
    alert('Error iniciando refresh: ' + r.status);
    return;
  }
  const { job_id } = await r.json();
  state.refreshJobs[key].jobId = job_id;
  pollRefresh(key, 800);
}

async function pollRefresh(key, nextDelay = 800) {
  const job = state.refreshJobs[key];
  if (!job || !job.jobId) return;
  try {
    const r = await fetch(`/api/jobs/${job.jobId}`);
    if (r.ok) {
      const data = await r.json();
      // Snapshot latest enrich progress so the button can render it live.
      const enrichEvents = (data.progress || []).filter((p) => p.phase === 'enrich');
      if (enrichEvents.length) {
        const last = enrichEvents[enrichEvents.length - 1];
        job.progress = {
          enriched: last.enriched ?? 0,
          failed: last.failed ?? 0,
          total: last.total ?? 0,
          in_flight: last.in_flight ?? 0,
          agent_in_flight: last.agent_in_flight ?? 0,
          started: last.started ?? 0,
        };
      }
      if (data.status !== 'running') {
        const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
        const ok = data.status === 'completed';
        const finalProgress = job.progress;
        delete state.refreshJobs[key];
        await loadSources(state.neighborhoods.join(','));
        const note = document.createElement('div');
        note.className = 'ranking-count';
        note.style.color = ok ? 'var(--good)' : 'var(--bad)';
        const counts = finalProgress
          ? ` (${finalProgress.enriched}/${finalProgress.total}${finalProgress.failed ? ', ' + finalProgress.failed + ' failed' : ''})`
          : '';
        note.textContent = `${key.replace(/\|/g, ' / ')}: ${data.status}${counts} en ${elapsed}s`;
        const head = $('#sources-container');
        if (head) head.prepend(note);
        setTimeout(() => note.remove(), 10000);
        if (ok) await loadRanking(state.neighborhoods.join(','));
        return;
      }
      // Still running: refresh the sources table so pending_enrich updates
      // in real time, and let renderSources pick up the progress snapshot
      // to update the button label.
      await loadSources(state.neighborhoods.join(','));
    }
  } catch {
    // transient — keep polling
  }
  const next = Math.min(Math.floor(nextDelay * 1.5), 4000);
  setTimeout(() => pollRefresh(key, next), nextDelay);
}

async function renderStats(aidOrNeighborhoods) {
  const url = aidOrNeighborhoods && state.analysis?.id === aidOrNeighborhoods
    ? '/api/stats?analysis_id=' + encodeURIComponent(state.analysis.id)
    : '/api/stats?neighborhoods=' + encodeURIComponent(state.neighborhoods.join(','));
  const r = await fetch(url);
  const data = await r.json();
  $('#stats-section').classList.remove('hidden');
  const c = $('#stats-container');
  c.innerHTML = '';
  for (const s of data.per_neighborhood || []) {
    c.appendChild(renderNeighborhoodStats(s));
  }
  if (data.aggregate) {
    c.appendChild(renderAggregate(data.aggregate));
  }
  // Wire ℹ️ buttons in the matrix cells to open the cell-listings modal.
  c.querySelectorAll('button.btn-info-cell').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openCellModal({
        matrix: btn.dataset.matrix,
        neighborhood: btn.dataset.neighborhood,
        age: btn.dataset.age,
        rooms: btn.dataset.rooms,
      });
    };
  });
}

async function openCellModal({ matrix, neighborhood, age, rooms }) {
  const existing = document.querySelector('.modal-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>${matrix === 'alquiler' ? 'Alquiler' : 'Venta'} · ${escapeHtml(neighborhood)} · ${escapeHtml(age)} · ${escapeHtml(rooms)} amb</h3>
        <button class="modal-close" title="Cerrar">×</button>
      </div>
      <div class="modal-body"><div style="color:var(--muted)">Cargando…</div></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('.modal-close').onclick = () => overlay.remove();

  const params = new URLSearchParams({ neighborhood, matrix, age, rooms });
  if (state.analysis?.id) params.set('analysis_id', state.analysis.id);
  let data;
  try {
    const r = await fetch('/api/stats/cell-listings?' + params.toString());
    if (!r.ok) throw new Error('status ' + r.status);
    data = await r.json();
  } catch (err) {
    overlay.querySelector('.modal-body').innerHTML =
      `<div style="color:var(--bad)">Error: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const unit = matrix === 'alquiler' ? 'USD/mes' : 'USD/m²';
  // KDE-style density plot with proper X (price) and Y (%) axes. Y is
  // expressed as "% of listings per ~price-bin" so a peak labelled "12%" means
  // about 12% of listings sit around that price band. X ticks are placed at
  // ~6 evenly-spaced price values plus the median + threshold markers.
  const renderDensityPlot = () => {
    const all = [...data.kept, ...data.outliers].map((r) => r.metric).filter(Number.isFinite);
    if (all.length < 3) return '';
    const min = Math.min(...all);
    const max = Math.max(...all);
    if (max === min) return '';
    const range = max - min;
    const x0 = min - range * 0.05;
    const x1 = max + range * 0.05;
    const meanVal = all.reduce((a, v) => a + v, 0) / all.length;
    const sd = Math.sqrt(all.reduce((a, v) => a + (v - meanVal) ** 2, 0) / all.length);
    const bandwidth = Math.max(1.06 * sd * Math.pow(all.length, -1 / 5), range / 30);
    // SVG coordinate system with margins for axes.
    const W = 700, H = 200;
    const margin = { top: 10, right: 10, bottom: 30, left: 50 };
    const plotW = W - margin.left - margin.right;
    const plotH = H - margin.top - margin.bottom;
    const N_POINTS = 200;
    const xs = Array.from({ length: N_POINTS }, (_, i) => x0 + ((x1 - x0) * i) / (N_POINTS - 1));
    // Kernel density at each x, then convert "density" → "fraction of listings
    // per pixel-bin" so the y-axis is interpretable as "% of listings".
    const ds = xs.map((x) => {
      let s = 0;
      for (const v of all) {
        const z = (x - v) / bandwidth;
        s += Math.exp(-0.5 * z * z);
      }
      return s / (all.length * bandwidth * Math.sqrt(2 * Math.PI));
    });
    // Integrate density * bin_width to get fraction-per-bin. Bin = the x
    // distance covered by 1/N_POINTS of the visible range. Then × 100 → %.
    const binWidth = (x1 - x0) / (N_POINTS - 1);
    const pcts = ds.map((d) => d * binWidth * 100);
    const yMax = Math.max(...pcts) * 1.1; // pad top a bit
    const xScale = (x) => margin.left + ((x - x0) / (x1 - x0)) * plotW;
    const yScale = (y) => margin.top + plotH - (y / yMax) * plotH;
    const threshold = data.threshold;
    const tx = threshold != null ? xScale(threshold) : null;
    const pathPoints = xs.map((x, i) => `${xScale(x).toFixed(1)},${yScale(pcts[i]).toFixed(1)}`);
    const splitIdx = tx != null ? xs.findIndex((x) => x >= threshold) : -1;
    let keptPath = '', premPath = '';
    const yBase = margin.top + plotH;
    if (splitIdx > 0) {
      const keptPts = pathPoints.slice(0, splitIdx + 1).join(' L');
      keptPath = `M${xScale(x0).toFixed(1)},${yBase} L${keptPts} L${xScale(xs[splitIdx]).toFixed(1)},${yBase} Z`;
      const premPts = pathPoints.slice(splitIdx).join(' L');
      premPath = `M${xScale(xs[splitIdx]).toFixed(1)},${yBase} L${premPts} L${xScale(x1).toFixed(1)},${yBase} Z`;
    } else {
      const pts = pathPoints.join(' L');
      keptPath = `M${xScale(x0).toFixed(1)},${yBase} L${pts} L${xScale(x1).toFixed(1)},${yBase} Z`;
    }
    // X-axis ticks: ~6 evenly-spaced price values.
    const N_X_TICKS = 6;
    const xTicks = Array.from({ length: N_X_TICKS }, (_, i) => x0 + ((x1 - x0) * i) / (N_X_TICKS - 1));
    const xTickMarks = xTicks.map((v) => {
      const x = xScale(v);
      return `<line x1="${x.toFixed(1)}" y1="${yBase}" x2="${x.toFixed(1)}" y2="${(yBase + 4).toFixed(1)}" stroke="var(--muted)" stroke-width="1"/>
              <text x="${x.toFixed(1)}" y="${(yBase + 16).toFixed(1)}" fill="var(--muted)" font-size="11" text-anchor="middle">${fmtUsd(v)}</text>`;
    }).join('');
    // Y-axis ticks: 4 horizontal gridlines at 0%, 25%, 50%, 75%, 100% of yMax.
    const N_Y_TICKS = 5;
    const yTickMarks = Array.from({ length: N_Y_TICKS }, (_, i) => {
      const pct = (yMax * i) / (N_Y_TICKS - 1);
      const y = yScale(pct);
      return `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${(W - margin.right).toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--muted)" stroke-width="0.5" stroke-opacity="0.3"/>
              <text x="${(margin.left - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="var(--muted)" font-size="11" text-anchor="end">${pct.toFixed(0)}%</text>`;
    }).join('');
    // Rug ticks (individual listings) along the X-axis baseline.
    const keptTicks = data.kept.map((r) =>
      `<line x1="${xScale(r.metric).toFixed(1)}" y1="${yBase - 2}" x2="${xScale(r.metric).toFixed(1)}" y2="${(yBase + 3).toFixed(1)}" stroke="var(--good)" stroke-width="1"/>`,
    ).join('');
    const outTicks = data.outliers.map((r) =>
      `<line x1="${xScale(r.metric).toFixed(1)}" y1="${yBase - 2}" x2="${xScale(r.metric).toFixed(1)}" y2="${(yBase + 3).toFixed(1)}" stroke="var(--warn)" stroke-width="1"/>`,
    ).join('');
    const thresholdLine = tx != null
      ? `<line x1="${tx.toFixed(1)}" y1="${margin.top}" x2="${tx.toFixed(1)}" y2="${yBase}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="3 3"/>
         <text x="${(tx + 4).toFixed(1)}" y="${(margin.top + 12).toFixed(1)}" fill="var(--warn)" font-size="11">umbral ${fmtUsd(threshold)}</text>`
      : '';
    const medianX = data.median_kept != null ? xScale(data.median_kept) : null;
    const medianLine = medianX != null
      ? `<line x1="${medianX.toFixed(1)}" y1="${margin.top}" x2="${medianX.toFixed(1)}" y2="${yBase}" stroke="var(--accent)" stroke-width="1"/>
         <text x="${(medianX + 4).toFixed(1)}" y="${(margin.top + 26).toFixed(1)}" fill="var(--accent)" font-size="11">median ${fmtUsd(data.median_kept)}</text>`
      : '';
    return `<div style="margin:8px 0 14px">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:240px;display:block;">
        <text x="${margin.left}" y="${(margin.top - 2).toFixed(1)}" fill="var(--muted)" font-size="11">% de listings</text>
        ${yTickMarks}
        ${keptPath ? `<path d="${keptPath}" fill="var(--good)" fill-opacity="0.35" stroke="var(--good)" stroke-width="1.5"/>` : ''}
        ${premPath ? `<path d="${premPath}" fill="var(--warn)" fill-opacity="0.35" stroke="var(--warn)" stroke-width="1.5"/>` : ''}
        ${thresholdLine}
        ${medianLine}
        ${keptTicks}
        ${outTicks}
        ${xTickMarks}
        <text x="${(W - margin.right).toFixed(1)}" y="${(H - 2).toFixed(1)}" fill="var(--muted)" font-size="11" text-anchor="end">${unit}</text>
      </svg>
    </div>`;
  };
  const renderRow = (r) => `<tr>
    <td class="num"><b>${fmtUsd(r.metric)}</b></td>
    <td class="num">${fmtUsd(r.price_usd)}</td>
    <td class="num">${r.homogenized_m2 ? r.homogenized_m2.toFixed(0) : '-'}</td>
    <td>${r.age_years ?? '-'}</td>
    <td>${r.has_garage ? '🚗' : ''}${r.has_pool ? '🏊' : ''}</td>
    <td><a href="${r.url}" target="_blank" rel="noopener"><code>${r.source}/${escapeHtml(r.external_id)}</code></a></td>
  </tr>`;
  const keptRows = (data.kept || []).map(renderRow).join('');
  const outRows = (data.outliers || []).map(renderRow).join('');
  overlay.querySelector('.modal-body').innerHTML = `
    <div style="color:var(--muted);font-size:12px;margin-bottom:6px">
      ${data.kept.length} usados en el median · ${data.outliers.length} premium excluidos
      ${data.threshold != null ? ` · umbral premium: ${fmtUsd(data.threshold)} ${unit}` : ''}
      ${data.median_kept != null ? ` · median kept: ${fmtUsd(data.median_kept)} ${unit}` : ''}
    </div>
    ${renderDensityPlot()}
    <h4 style="margin:8px 0 4px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em">
      Usados en el median (${data.kept.length})
    </h4>
    ${keptRows
      ? `<table class="modal-table">
          <thead><tr>
            <th class="num">${unit}</th><th class="num">precio</th><th class="num">m² hom</th>
            <th>años</th><th>amen</th><th>fuente / id</th>
          </tr></thead>
          <tbody>${keptRows}</tbody>
        </table>`
      : '<div style="color:var(--muted)">Ninguno.</div>'}
    <h4 style="margin:16px 0 4px;color:var(--warn);font-size:11px;text-transform:uppercase;letter-spacing:.05em">
      Premium excluidos (${data.outliers.length})
    </h4>
    ${outRows
      ? `<table class="modal-table">
          <thead><tr>
            <th class="num">${unit}</th><th class="num">precio</th><th class="num">m² hom</th>
            <th>años</th><th>amen</th><th>fuente / id</th>
          </tr></thead>
          <tbody>${outRows}</tbody>
        </table>`
      : '<div style="color:var(--muted)">Ninguno.</div>'}
  `;
}

function renderNeighborhoodStats(s, opts = {}) {
  const block = document.createElement('div');
  block.className = 'neighborhood-block';
  block.dataset.neighborhood = s.neighborhood;
  const sample = s.sample_total || 0;
  const usd = s.usd_per_m2 || {};
  const subZoneBadge = opts.subZone
    ? `<span class="badge warn">sub-zona: ${escapeHtml(opts.subZoneLabel || opts.subZone)}</span>`
    : '';
  block.innerHTML = `
    <h3>${s.neighborhood} <span class="badge">${sample} listings</span> ${subZoneBadge}</h3>
    <div class="subzone-panel" data-subzone-panel></div>
    <div class="stat-grid">
      ${statCard('USD/m² disponible (mediana)', usd.disponible)}
      ${statCard('USD/m² en pozo (mediana)', usd.en_pozo)}
      ${statCard('USD/m² construcción (mediana)', usd.construccion)}
      ${statCard('USD/m² con pileta (mediana)', s.with_pool)}
    </div>
    <h4 style="margin-top:14px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">Por ambientes</h4>
    ${renderRoomsTable(s.by_rooms || {})}
    <h4 style="margin-top:14px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">Antigüedad × ambientes (USD/m² venta)</h4>
    ${renderAgeMatrix(s.age_x_rooms || {}, { matrixKind: 'venta', neighborhood: s.neighborhood })}
    <h4 style="margin-top:14px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">Alquiler mensual × ambientes × antigüedad</h4>
    ${renderAgeMatrix(s.rent_age_x_rooms || {}, {
      matrixKind: 'alquiler',
      neighborhood: s.neighborhood,
      unitLabel: 'USD/mes',
      secondaryMatrix: s.rent_per_m2_age_x_rooms || {},
      secondaryLabel: 'USD/m²/mes',
      secondaryFmt: (v) => v.toFixed(2),
      caption: 'Mediana USD/mes (grande) y USD/m²/mes (chico, color acento) cruzando antigüedad × ambientes. n = total. Abajo, cuántas por fuente.',
    })}
    <h4 style="margin-top:14px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">Alquiler × antigüedad × tamaño (chico/normal/grande)</h4>
    ${renderAgeMatrix(s.rent_age_x_size || {}, {
      matrixKind: 'alquiler-size',
      neighborhood: s.neighborhood,
      unitLabel: 'USD/mes',
      buckets: ['1-mono', '2-chico', '2-normal', '2-grande', '3-chico', '3-normal', '3-grande', '4+', 'ph-casa'],
      bucketLabels: {
        '1-mono': 'Mono',
        '2-chico': '2 chico',
        '2-normal': '2 normal',
        '2-grande': '2 grande',
        '3-chico': '3 chico',
        '3-normal': '3 normal',
        '3-grande': '3 grande',
        '4+': '4+',
        'ph-casa': 'PH/casa',
      },
      secondaryMatrix: s.rent_per_m2_age_x_size || {},
      secondaryLabel: 'USD/m²/mes',
      secondaryFmt: (v) => v.toFixed(2),
      caption: 'Mismo cruce que la tabla anterior, pero separando cada ambiente por m² (chico/normal/grande). Evita promediar un 2-amb 100m² con un 2-amb 45m².',
    })}
  `;
  // Lazy-load the sub-zones chip panel. The endpoint 404s when the feature
  // flag is off; we render nothing in that case (silent no-op).
  populateSubZonePanel(block, s.neighborhood, opts.subZone || null);
  return block;
}

async function populateSubZonePanel(block, neighborhood, activeSubZone) {
  let data;
  let status;
  try {
    const [zonesRes, statusRes] = await Promise.all([
      fetch('/api/stats/subzones?neighborhood=' + encodeURIComponent(neighborhood)),
      fetch('/api/stats/enrich-status?neighborhoods=' + encodeURIComponent(neighborhood)),
    ]);
    if (!zonesRes.ok) return; // 404 when feature flag off — silently skip.
    data = await zonesRes.json();
    if (statusRes.ok) status = await statusRes.json();
  } catch {
    return;
  }
  const list = data?.sub_zones || [];
  const panel = block.querySelector('[data-subzone-panel]');
  if (!panel) return;
  // Build the "Total geocodificados / total listings" progress hint so the
  // user understands why chip counts don't add up to the listing total in
  // the title (388 still pending geocoding, etc.).
  const geocodedInZones = list.reduce((a, z) => a + (z.count || 0), 0);
  const totalListings = status?.total ?? null;
  const pendingGeocode = status?.pending_geocode ?? null;
  const progressBits = [];
  if (totalListings != null) progressBits.push(`${geocodedInZones} de ${totalListings} listings con coordenadas`);
  if (pendingGeocode != null && pendingGeocode > 0) progressBits.push(`${pendingGeocode} pendientes`);
  const progress = progressBits.length > 0 ? ` · ${progressBits.join(' · ')}` : '';
  if (list.length === 0) {
    // No chips yet — show the empty-state hint so the user knows the panel
    // exists and is waiting, instead of being silently hidden.
    panel.innerHTML = `<div class="subzone-chips empty"><span class="subzone-title">Sub-zonas (beta):</span> <em>aún procesando${progress}</em></div>`;
    return;
  }
  const chips = [
    `<button class="chip-subzone ${!activeSubZone ? 'active' : ''}" data-subzone="">Todo el barrio</button>`,
    ...list.map((z) =>
      `<button class="chip-subzone ${activeSubZone === z.sub_zone ? 'active' : ''}" data-subzone="${escapeHtml(z.sub_zone)}" title="${escapeHtml(z.sub_zone)}">${escapeHtml(z.label)} <span class="chip-count">${z.count}</span></button>`
    ),
  ].join(' ');
  panel.innerHTML = `
    <div class="subzone-chips">
      <span class="subzone-title">Sub-zonas (beta):</span> ${chips}
    </div>
    <div class="subzone-progress">${progress.replace(/^ · /, '')}</div>
  `;
  panel.querySelectorAll('.chip-subzone').forEach((btn) => {
    btn.onclick = () => {
      const sub = btn.dataset.subzone || null;
      const label = sub ? list.find((z) => z.sub_zone === sub)?.label : null;
      reloadNeighborhoodStats(neighborhood, { subZone: sub, subZoneLabel: label });
    };
  });
}

async function reloadNeighborhoodStats(neighborhood, { subZone, subZoneLabel } = {}) {
  const params = new URLSearchParams();
  if (state.analysis?.id) {
    params.set('analysis_id', state.analysis.id);
  } else {
    params.set('neighborhoods', neighborhood);
  }
  if (subZone) params.set('sub_zone', subZone);
  const r = await fetch('/api/stats?' + params.toString());
  const data = await r.json();
  const newStats = (data.per_neighborhood || []).find((s) => s.neighborhood === neighborhood);
  if (!newStats) return;
  const block = document.querySelector(`.neighborhood-block[data-neighborhood="${CSS.escape(neighborhood)}"]`);
  if (!block) return;
  const replaced = renderNeighborhoodStats(newStats, { subZone, subZoneLabel });
  block.replaceWith(replaced);
  // Re-wire the cell-info buttons inside the replaced block.
  replaced.querySelectorAll('button.btn-info-cell').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openCellModal({
        matrix: btn.dataset.matrix,
        neighborhood: btn.dataset.neighborhood,
        age: btn.dataset.age,
        rooms: btn.dataset.rooms,
      });
    };
  });
}

// Short line describing the premium tail Stats excluded from the headline
// median. Returns '' when there were no outliers.
function outlierLine(stat) {
  const o = stat?.outliers;
  if (!o || !o.count) return '';
  return `<div class="sub" style="color:var(--warn)">+ ${o.count} premium > ${fmtUsd(o.threshold)} (~${fmtUsd(o.mean)} prom)</div>`;
}

function statCard(label, stat) {
  if (!stat || stat.median == null) {
    return `<div class="stat"><div class="label">${label}</div><div class="value">n/d</div><div class="sub">n=${stat?.n ?? 0}</div></div>`;
  }
  const src = bySourceLine(stat.by_source);
  return `<div class="stat">
    <div class="label">${label}</div>
    <div class="value">${fmtUsd(stat.median)}</div>
    <div class="sub">n=${stat.n} · p25 ${fmtUsd(stat.p25)} · p75 ${fmtUsd(stat.p75)}</div>
    ${src ? `<div class="sub">${src}</div>` : ''}
    ${outlierLine(stat)}
  </div>`;
}

function renderRoomsTable(byRooms) {
  const buckets = ['1', '2', '3', '4', '5+'];
  const rows = buckets
    .map((b) => {
      const s = byRooms[b];
      if (!s || s.median == null) {
        return `<tr><td>${b} amb</td><td class="num">n/d</td><td class="num">${s?.n ?? 0}</td><td></td></tr>`;
      }
      const o = s.outliers;
      const outBadge = o?.count ? `<div style="color:var(--warn);font-size:10px">+ ${o.count} premium &gt; ${fmtUsd(o.threshold)}</div>` : '';
      return `<tr><td>${b} amb</td><td class="num">${fmtUsd(s.median)}${outBadge}</td><td class="num">${s.n}</td><td style="color:var(--muted);font-size:11px">${bySourceLine(s.by_source)}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Bucket</th><th class="num">Mediana USD/m²</th><th class="num">n</th><th>Por fuente</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const SOURCE_ABBREV = {
  argenprop: 'AP',
  zonaprop: 'ZP',
  mercadolibre: 'ML',
  remax: 'RM',
};
function bySourceLine(by) {
  if (!by) return '';
  const entries = Object.entries(by).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${SOURCE_ABBREV[k] || k} ${v}`).join(' · ');
}

function renderAgeMatrix(matrix, opts = {}) {
  const matrixKind = opts.matrixKind || 'venta'; // for the ℹ️ deep-link
  const neighborhood = opts.neighborhood || null;
  // Optional secondary matrix rendered as a small extra line in each cell —
  // used for the rent table to show USD/m²/mes alongside the absolute USD/mes.
  const secondaryMatrix = opts.secondaryMatrix || null;
  const secondaryFmt = opts.secondaryFmt || ((v) => fmtUsd(v));
  const secondaryLabel = opts.secondaryLabel || '';
  // Column dimension: defaults to room buckets, but callers can override
  // (e.g. size buckets "2-chico" / "2-normal" / "2-grande" …).
  const buckets = opts.buckets || ['1', '2', '3', '4', '5+'];
  const bucketLabels = opts.bucketLabels || null;
  const bucketHeaderSuffix = opts.bucketHeaderSuffix ?? ' amb';
  const ages = ['a-estrenar', '0-5', '5-20', '20-50', '50+'];
  const ageLabels = {
    'a-estrenar': 'A estrenar',
    '0-5': '1–5 años',
    '5-20': '5–20 años',
    '20-50': '20–50 años',
    '50+': '50+ años',
  };
  // `opts.unitLabel` lets callers reuse the matrix layout for non-USD/m²
  // values (e.g., monthly rent in USD). When omitted we use the original
  // "USD/m² (homogeneizado)" framing.
  const captionDefault = 'Mediana USD/m² (homogeneizado) cruzando antigüedad × cantidad de ambientes. <code>n</code> = total. Abajo, cuántas por fuente (AP=ArgenProp · ZP=Zonaprop · ML=MercadoLibre · RM=Remax). Celdas con <code>—</code> tienen menos de 3 muestras.';
  // Drive the grid column count from the bucket array so 9-wide size
  // matrices don't wrap into the 5-column CSS default.
  let html = `<div class="matrix" style="--matrix-cols:${buckets.length}">`;
  // Header row: one empty corner cell + N column headers.
  html +=
    '<div class="head"></div>' +
    buckets.map((b) => `<div class="head">${bucketLabels?.[b] ?? `${b}${bucketHeaderSuffix}`}</div>`).join('');
  // Data rows: one row-head label + N data cells.
  for (const a of ages) {
    html += `<div class="row-head">${ageLabels[a]}</div>`;
    for (const b of buckets) {
      const s = matrix[a]?.[b];
      const s2 = secondaryMatrix?.[a]?.[b];
      let v = '—';
      if (s && s.median != null) {
        const canInspect = neighborhood && s.n > 0;
        const info = canInspect
          ? ` <button class="btn-info-cell" data-matrix="${matrixKind}" data-neighborhood="${neighborhood}" data-age="${a}" data-rooms="${b}" title="Ver listings de esta celda">ℹ️</button>`
          : '';
        v = `${fmtUsd(s.median)}${info}<br><span style="color:var(--muted);font-size:10px">n=${s.n}</span>`;
        if (s2 && s2.median != null) {
          v += `<br><span style="color:var(--accent);font-size:11px">${secondaryFmt(s2.median)} ${secondaryLabel}</span>`;
        }
        const src = bySourceLine(s.by_source);
        if (src) v += `<br><span style="color:var(--muted);font-size:10px">${src}</span>`;
        const o = s.outliers;
        if (o?.count) {
          v += `<br><span style="color:var(--warn);font-size:10px">+ ${o.count} prem &gt;${fmtUsd(o.threshold)}</span>`;
        }
      }
      html += `<div>${v}</div>`;
    }
  }
  html += '</div>';
  const caption = opts.caption || captionDefault;
  html += `<div class="matrix-caption">${caption}</div>`;
  return html;
}

function renderAggregate(a) {
  const block = document.createElement('div');
  block.className = 'neighborhood-block';
  block.innerHTML = `
    <h3>Agregado <span class="badge">${a.sample_total} listings</span></h3>
    <div class="stat-grid">
      ${statCard('USD/m² disponible (mediana)', a.usd_per_m2_disponible)}
      ${statCard('USD/m² todo (mediana)', a.usd_per_m2_all)}
    </div>
  `;
  return block;
}

async function loadRanking() {
  // Multi-analysis: fetch one /api/properties per selected analysis in
  // parallel, then concatenate and dedupe by listing id. Each analysis has
  // its own filter set, so a property might appear in some but not others —
  // we want the UNION (the user "selected" all of them).
  let items = [];
  if (state.analyses.length > 0) {
    const responses = await Promise.all(
      state.analyses.map((a) =>
        fetch('/api/properties?analysis_id=' + encodeURIComponent(a.id))
          .then((r) => r.ok ? r.json() : { items: [] })
          .catch(() => ({ items: [] })),
      ),
    );
    const seen = new Set();
    for (const data of responses) {
      for (const it of (data.items || [])) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
    }
  } else {
    // Legacy fallback (no analysis selected yet): build the query from the
    // raw form inputs. Same payload as before so the path is unchanged when
    // the user hasn't created an analysis.
    const params = new URLSearchParams({
      neighborhoods: state.neighborhoods.join(','),
      include_pozo: String($('#include-pozo').checked),
      include_construccion: String($('#include-construccion').checked),
      min_yield: String(pct($('#min-yield').value)),
      min_build_yield: String(pct($('#min-build-yield').value)),
      require_pool: String($('#require-pool').checked),
      require_garage: String($('#require-garage').checked),
    });
    const minRooms = $('#min-rooms').value;
    if (minRooms) params.set('min_rooms', minRooms);
    const maxRooms = $('#max-rooms').value;
    if (maxRooms) params.set('max_rooms', maxRooms);
    const r = await fetch('/api/properties?' + params.toString());
    const data = await r.json();
    items = Array.isArray(data.items) ? data.items : [];
  }
  state.rankingItems = items;
  $('#ranking-section').classList.remove('hidden');
  renderRankingToolbar();
  renderRankingTable();
}

function roomsBucket(rooms) {
  if (rooms == null) return null;
  if (rooms >= 5) return '5+';
  return String(rooms);
}

function applyRankingView(items) {
  const v = state.rankingView;
  let out = items;
  // Defensive client-side enforcement of the top-form requirements. The
  // backend should already exclude these, but if the user toggles the
  // checkbox before the refetch lands, this keeps the visible list correct.
  if ($('#require-pool')?.checked) out = out.filter((it) => it.has_pool);
  if ($('#require-garage')?.checked) out = out.filter((it) => it.has_garage);
  const minRooms = Number($('#min-rooms')?.value);
  if (Number.isFinite(minRooms) && minRooms > 0) out = out.filter((it) => (it.rooms ?? 0) >= minRooms);
  const maxRooms = Number($('#max-rooms')?.value);
  if (Number.isFinite(maxRooms) && maxRooms > 0) out = out.filter((it) => (it.rooms ?? Infinity) <= maxRooms);

  if (v.rooms.length) {
    out = out.filter((it) => v.rooms.includes(roomsBucket(it.rooms)));
  }
  if (v.statuses.length) {
    out = out.filter((it) => v.statuses.includes(it.status));
  }
  if (v.amenities.includes('pool')) out = out.filter((it) => it.has_pool);
  if (v.amenities.includes('garage')) out = out.filter((it) => it.has_garage);
  out = [...out].sort((a, b) => {
    const dir = v.sortDir === 'asc' ? 1 : -1;
    const av = a[v.sortBy];
    const bv = b[v.sortBy];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(String(bv)) * dir;
    return (av - bv) * dir;
  });
  return out;
}

function renderRankingToolbar() {
  const t = $('#ranking-toolbar');
  const v = state.rankingView;
  const roomChips = ['1', '2', '3', '4', '5+']
    .map(
      (r) =>
        `<button class="filter-chip${v.rooms.includes(r) ? ' active' : ''}" data-room="${r}">${r} amb</button>`,
    )
    .join('');
  const statusChips = ['disponible', 'en-pozo', 'construccion']
    .map(
      (s) =>
        `<button class="filter-chip${v.statuses.includes(s) ? ' active' : ''}" data-status="${s}">${s}</button>`,
    )
    .join('');
  const amenityChips = [
    { id: 'pool', label: '🏊 pileta' },
    { id: 'garage', label: '🚗 cochera' },
  ]
    .map(
      (a) =>
        `<button class="filter-chip${v.amenities.includes(a.id) ? ' active' : ''}" data-amenity="${a.id}">${a.label}</button>`,
    )
    .join('');
  t.innerHTML = `
    <div class="group">
      <span class="group-label">ambientes</span>
      ${roomChips}
    </div>
    <div class="group">
      <span class="group-label">estado</span>
      ${statusChips}
    </div>
    <div class="group">
      <span class="group-label">amenities</span>
      ${amenityChips}
    </div>
    <button class="filter-chip" id="ranking-clear">limpiar</button>
  `;

  t.querySelectorAll('[data-room]').forEach((b) => {
    b.onclick = () => toggleSet(state.rankingView.rooms, b.dataset.room);
  });
  t.querySelectorAll('[data-status]').forEach((b) => {
    b.onclick = () => toggleSet(state.rankingView.statuses, b.dataset.status);
  });
  t.querySelectorAll('[data-amenity]').forEach((b) => {
    b.onclick = () => toggleSet(state.rankingView.amenities, b.dataset.amenity);
  });
  $('#ranking-clear').onclick = () => {
    state.rankingView.rooms = [];
    state.rankingView.statuses = [];
    state.rankingView.amenities = [];
    renderRankingToolbar();
    renderRankingTable();
    persistRankingView();
  };
}

function toggleSet(arr, value) {
  const idx = arr.indexOf(value);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(value);
  renderRankingToolbar();
  renderRankingTable();
  persistRankingView();
}

function setSort(col) {
  const v = state.rankingView;
  if (v.sortBy === col) {
    v.sortDir = v.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    v.sortBy = col;
    v.sortDir = col === 'price_usd_per_m2' || col === 'price_usd' ? 'asc' : 'desc';
  }
  renderRankingTable();
  persistRankingView();
}

function persistRankingView() {
  try {
    localStorage.setItem('rsa.ranking-view.v1', JSON.stringify(state.rankingView));
  } catch {
    // ignore
  }
}

function restoreRankingView() {
  try {
    const raw = localStorage.getItem('rsa.ranking-view.v1');
    if (!raw) return;
    Object.assign(state.rankingView, JSON.parse(raw));
  } catch {
    // ignore
  }
}

function renderRankingTable() {
  const c = $('#ranking-container');
  const items = applyRankingView(state.rankingItems);
  if (!state.rankingItems.length) {
    c.innerHTML = '<div style="color:var(--muted)">Sin resultados con los filtros del formulario superior.</div>';
    return;
  }

  const v = state.rankingView;
  const sortableTh = (col, label, num) => {
    const sorted = v.sortBy === col ? 'sorted' : '';
    const arrow = v.sortBy === col ? (v.sortDir === 'asc' ? '↑' : '↓') : '↕';
    return `<th class="sortable ${sorted}${num ? ' num' : ''}" data-sort="${col}">${label} <span class="arrow">${arrow}</span></th>`;
  };

  const rows = items
    .map((it) => {
      const yieldDisplay =
        it.rental_yield_pct != null
          ? `<span class="badge ok">${fmtPct(it.rental_yield_pct)} alq</span>`
          : `<span class="badge warn">${fmtPct(it.build_yield_pct)} build</span>`;
      // Compose the rent-reference label. The suffix tells the user how
      // hyper-local the reference was: strict sub-zone, sub-zone+vecinas,
      // or barrio-wide.
      let rentSourceLabel = it.rent_source;
      if (it.rent_match_level === 'subzone' && it.rent_sub_zone_label) {
        rentSourceLabel = `scraped · ${it.rent_sub_zone_label}`;
      } else if (it.rent_match_level === 'subzone-expanded' && it.rent_sub_zone_label) {
        rentSourceLabel = `scraped · ${it.rent_sub_zone_label} + vecinas`;
      } else if (it.rent_match_level === 'subzone-expanded') {
        rentSourceLabel = 'scraped · sub-zona + vecinas';
      } else if (it.rent_match_level === 'neighborhood' && it.rent_source === 'scraped') {
        rentSourceLabel = 'scraped · barrio';
      } else if (it.rent_match_level === 'fallback') {
        rentSourceLabel = 'fallback (tabla seed)';
      }
      const primaryRent = it.rent_estimate_usd != null
        ? `alq ~ ${fmtUsd(it.rent_estimate_usd)}/mes (${rentSourceLabel}${it.rent_rate_per_m2 != null ? `, ${fmtUsd(it.rent_rate_per_m2)}/m²` : ''})`
        : it.ref_usd_per_m2 != null
          ? `ref ${fmtUsd(it.ref_usd_per_m2)} USD/m² (${it.build_ref_source})`
          : '';
      // Sub-zone anchored alternative: shown in a second line, accent color,
      // when the primary cascade landed on barrio/fallback. Gives the user
      // "if we just averaged your hex (or ring 1) you'd pay $X".
      let altLine = '';
      if (it.rent_subzone_alt_usd != null && it.rent_estimate_usd != null) {
        const scopeLabel =
          it.rent_subzone_alt_scope === 'own' ? 'sub-zona' :
          it.rent_subzone_alt_scope === 'ring1' ? 'sub-zona ±1' :
          it.rent_subzone_alt_scope === 'inferred' ? 'sub-zona inferida del address' :
          'sub-zona';
        const zoneLabel = it.rent_subzone_alt_label ? ` "${it.rent_subzone_alt_label}"` : '';
        const rateBit = it.rent_subzone_alt_rate != null ? `, ${fmtUsd(it.rent_subzone_alt_rate)}/m²` : '';
        altLine = `<br><span style="color:var(--accent);font-size:11px">≈ ${fmtUsd(it.rent_subzone_alt_usd)}/mes si mergeáramos con ${scopeLabel}${zoneLabel} (n=${it.rent_subzone_alt_n}${rateBit})</span>`;
      }
      const refDisplay = primaryRent + altLine;
      const links = [`<a href="${it.url}" target="_blank" rel="noopener">${it.source}</a>`];
      if (it.duplicates) {
        for (const d of it.duplicates) {
          links.push(`<a href="${d.url}" target="_blank" rel="noopener">${d.source}</a>`);
        }
      }
      return `<tr>
        <td>${escapeHtml(it.neighborhood)}</td>
        <td class="num">${it.rooms ?? '-'}</td>
        <td>${fmtFloor(it.floor)}</td>
        <td class="num">${it.covered_m2 != null ? it.covered_m2.toFixed(0) : '-'}</td>
        <td class="num">${it.uncovered_m2 != null ? it.uncovered_m2.toFixed(0) : '-'}</td>
        <td class="num">${it.homogenized_m2?.toFixed(1) ?? '-'}</td>
        <td>${it.age_band || '-'}</td>
        <td>${[
          it.has_pool ? '🏊' : null,
          it.has_garage ? '🚗' : null,
          it.has_amenities ? '⭐' : null,
        ].filter(Boolean).join(' ')}</td>
        <td class="num">${fmtUsd(it.price_usd)}</td>
        <td class="num">${fmtUsd(it.price_usd_per_m2)}</td>
        <td>${yieldDisplay}</td>
        <td>${refDisplay}</td>
        <td>${links.join(' · ')}</td>
      </tr>`;
    })
    .join('');

  const activeFilters = [];
  if ($('#require-pool')?.checked) activeFilters.push('🏊 con pileta');
  if ($('#require-garage')?.checked) activeFilters.push('🚗 con cochera');
  const minR = $('#min-rooms')?.value;
  const maxR = $('#max-rooms')?.value;
  if (minR || maxR) activeFilters.push(`amb ${minR || '?'}–${maxR || '?'}`);
  if ($('#include-pozo')?.checked) activeFilters.push('+ pozo');
  if ($('#include-construccion')?.checked) activeFilters.push('+ construcción');
  const myField = $('#min-yield')?.value;
  if (myField) activeFilters.push(`yield≥${myField}%`);

  c.innerHTML = `
    <div class="ranking-count">
      <b>${items.length}</b> de ${state.rankingItems.length} propiedades visibles
      ${activeFilters.length ? '· filtros: ' + activeFilters.map((f) => `<span class="badge ok">${f}</span>`).join(' ') : ''}
    </div>
    <table>
      <thead><tr>
        ${sortableTh('neighborhood', 'Barrio', false)}
        ${sortableTh('rooms', 'Amb', true)}
        <th>Piso</th>
        ${sortableTh('covered_m2', 'm² cub', true)}
        ${sortableTh('uncovered_m2', 'm² desc', true)}
        ${sortableTh('homogenized_m2', 'm² homog', true)}
        ${sortableTh('age_years', 'Antigüedad', false)}
        <th>Amenities</th>
        ${sortableTh('price_usd', 'Precio USD', true)}
        ${sortableTh('price_usd_per_m2', 'USD/m²', true)}
        ${sortableTh('score', 'Yield', false)}
        <th>Referencia</th><th>Origen</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  c.querySelectorAll('th.sortable').forEach((th) => {
    th.onclick = () => setSort(th.dataset.sort);
  });
}

function fmtFloor(f) {
  if (!f) return '-';
  const s = String(f).trim();
  if (/^\d+$/.test(s)) return s + '°';
  return s;
}
function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  return 'US$ ' + Math.round(n).toLocaleString('es-AR');
}
function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return '-';
  return (p * 100).toFixed(1) + '%';
}
function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  return n.toLocaleString('es-AR');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Filter inputs in the top form drive the backend ranking query. When the
// user changes any of them after a search has already loaded, re-fetch the
// ranking immediately (no scrape, just a re-query). Also persist.
let rankingDebounce = null;
function onRankingFilterChange() {
  persistSession();
  // Immediate visible feedback: re-apply view filters over the items we
  // already have, so the user sees the change without waiting for the fetch.
  if (state.rankingItems.length) renderRankingTable();
  if (!state.neighborhoods.length) return;
  if (!state.rankingItems.length && !document.querySelector('#ranking-section:not(.hidden)')) return;
  clearTimeout(rankingDebounce);
  // Then refetch from the backend so the count is correct and we pick up
  // edge cases the client view didn't know about.
  rankingDebounce = setTimeout(() => loadRanking(state.neighborhoods.join(',')), 200);
}

[
  '#include-pozo',
  '#include-construccion',
  '#min-yield',
  '#min-build-yield',
  '#min-rooms',
  '#max-rooms',
  '#require-pool',
  '#require-garage',
].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener('change', onRankingFilterChange);
  // Numeric inputs benefit from `input` too, so the user sees results while typing.
  if (el.type === 'number') el.addEventListener('input', onRankingFilterChange);
});

restoreRankingView();
loadFx();
loadNeighborhoods().then(() => restoreSession());

// =====================================================================
// Map view (Tabla / Mapa toggle in the ranking section).
// =====================================================================

// Toggle handler: switch the visible container, lazy-init the Leaflet map
// the first time the user opens the map tab.
function bindRankingViewToggle() {
  const buttons = document.querySelectorAll('#ranking-view-toggle .view-tab');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === state.rankingView.mode) return;
      state.rankingView.mode = view;
      buttons.forEach((b) => b.classList.toggle('active', b.dataset.view === view));
      $('#ranking-container').classList.toggle('hidden', view !== 'table');
      $('#ranking-map').classList.toggle('hidden', view !== 'map');
      if (view === 'map') renderRankingMap();
    });
  });
}
bindRankingViewToggle();

// Color for the price-pill marker, scaled by score (or yield). Green for
// strong returns, gray for weak. Anchored on rental yield when present,
// build yield otherwise.
function markerColor(it) {
  const y = it.rental_yield_pct ?? it.build_yield_pct;
  if (y == null) return '#94a3b8';      // slate-400
  if (y >= 0.08) return '#16a34a';      // green-600
  if (y >= 0.06) return '#65a30d';      // lime-600
  if (y >= 0.05) return '#ca8a04';      // yellow-600
  return '#94a3b8';
}

// Format the price for the marker label: "USD 180k" / "USD 1.2M".
function fmtPriceShort(usd) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  if (usd >= 1_000_000) return `USD ${(usd / 1_000_000).toFixed(1)}M`;
  return `USD ${Math.round(usd / 1000)}k`;
}

// Cache for boundary GeoJSON keyed by neighborhood id. The endpoint 404s
// for non-CABA barrios (Vicente López, etc); we cache the miss so we
// don't refetch on every render.
const boundaryCache = new Map();
async function loadBoundary(id) {
  if (boundaryCache.has(id)) return boundaryCache.get(id);
  try {
    const r = await fetch(`/api/neighborhoods/${encodeURIComponent(id)}/boundary`);
    if (!r.ok) {
      boundaryCache.set(id, null);
      return null;
    }
    const j = await r.json();
    boundaryCache.set(id, j);
    return j;
  } catch {
    boundaryCache.set(id, null);
    return null;
  }
}

// Render or refresh the Leaflet map. Lazy-initializes the map instance on
// first call; subsequent calls reuse it (just clear and repaint layers).
async function renderRankingMap() {
  if (typeof L === 'undefined') return; // Leaflet not loaded yet (CDN failed?)
  const el = $('#ranking-map');
  if (!el) return;

  // Lazy-init the Leaflet map. Tile provider: OSM standard (free, no key).
  if (!state.map) {
    // Default center: CABA centro (will recenter once we have data).
    state.map = L.map(el, { zoomControl: true, attributionControl: true })
      .setView([-34.605, -58.435], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(state.map);
    state.mapLayers.markers = L.layerGroup().addTo(state.map);
    state.mapLayers.polygons = L.layerGroup().addTo(state.map);
  } else {
    // Leaflet needs invalidateSize() after the container went from hidden
    // to visible — otherwise tiles render at 0×0.
    setTimeout(() => state.map.invalidateSize(), 50);
  }

  // Clear previous render.
  state.mapLayers.markers.clearLayers();
  state.mapLayers.polygons.clearLayers();

  // Polygons: one per selected neighborhood, when available.
  const neighborhoods = state.analysis?.neighborhoods || state.neighborhoods || [];
  const polygonBounds = [];
  for (const nid of neighborhoods) {
    const b = await loadBoundary(nid);
    if (!b?.geometry) continue;
    const layer = L.geoJSON(b.geometry, {
      style: {
        color: '#475569',     // slate-600 outline
        weight: 2,
        fillColor: '#475569',
        fillOpacity: 0.08,
      },
    }).addTo(state.mapLayers.polygons);
    layer.bindTooltip(b.display, { sticky: true, direction: 'top' });
    polygonBounds.push(layer.getBounds());
  }

  // Markers: each property with lat/lng gets a price-label pill.
  const items = applyRankingView(state.rankingItems).filter(
    (it) => Number.isFinite(it.lat) && Number.isFinite(it.lng),
  );
  const markerBounds = [];

  // Build the marker's DivIcon. Extracted so the popup's "mark viewed"
  // click can rebuild it without duplicating the HTML template.
  //
  // Sizing: `iconSize` + `iconAnchor` are REQUIRED for Leaflet to know
  // where clicks land. With `iconSize: null` the click hitbox collapses
  // to a point and the visible pill (CSS-translated up-left) becomes
  // effectively unclickable. We approximate the pill's rendered size from
  // the label length — good enough for click detection since browsers
  // fuzz the target a few px anyway. Anchor is the pill's BOTTOM-CENTER
  // so the exact lat/lng sits right under the tail of the label.
  function buildMarkerIcon(it) {
    const color = markerColor(it);
    const label = fmtPriceShort(it.price_usd);
    const viewedCls = state.viewedListings.has(it.id) ? ' viewed' : '';
    const prefix = viewedCls ? '✓ ' : '';
    const text = prefix + label;
    // Rough pill dims: ~7px/char at 12px font-weight-600 tabular, plus
    // horizontal padding (16). Height is fixed by the CSS pill.
    const w = Math.max(56, Math.round(text.length * 7 + 16));
    const h = 22;
    return L.divIcon({
      className: 'price-marker',
      html: `<span class="price-marker-pill${viewedCls}" style="background:${color}">${text}</span>`,
      iconSize: [w, h],
      iconAnchor: [w / 2, h], // bottom-center of the pill sits on the coord
    });
  }

  for (const it of items) {
    const label = fmtPriceShort(it.price_usd);
    const m = L.marker([it.lat, it.lng], { icon: buildMarkerIcon(it) });
    const yieldText =
      it.rental_yield_pct != null
        ? `${(it.rental_yield_pct * 100).toFixed(1)}% alq`
        : it.build_yield_pct != null
          ? `${(it.build_yield_pct * 100).toFixed(1)}% build`
          : '—';
    // Hover tooltip — carries the full listing detail (price, dims, yield,
    // address) so the user doesn't have to click to compare pins side by
    // side. Click on the marker opens the listing URL directly (see below).
    const addr = escapeHtml(it.address || it.neighborhood_raw || '');
    const tooltipHtml = `
      <div class="map-hover-price">${escapeHtml(label)}</div>
      <div class="map-hover-line">${it.rooms ?? '?'} amb · ${it.homogenized_m2 ?? '?'} m² · ${yieldText}</div>
      ${addr ? `<div class="map-hover-addr">${addr}</div>` : ''}
      <div class="map-hover-hint">click para abrir el listing ↗</div>
    `;
    m.bindTooltip(tooltipHtml, {
      direction: 'top',
      offset: [0, -6],
      sticky: false,
      className: 'map-hover-tip',
    });
    // Click opens the listing URL directly in a new tab (window.open is
    // safer than a synthetic <a>.click() because it inherits the "noopener"
    // rel behavior via the 'noopener' feature string, and Leaflet's own
    // click handling doesn't stomp on it). Marking-as-viewed happens in
    // the same handler so the marker's style updates immediately.
    m.on('click', () => {
      if (!it.url) return;
      window.open(it.url, '_blank', 'noopener,noreferrer');
      if (markListingViewed(it.id)) {
        m.setIcon(buildMarkerIcon(it));
      }
    });
    m.addTo(state.mapLayers.markers);
    markerBounds.push([it.lat, it.lng]);
  }

  // Fit to whatever we have: polygons union if present, otherwise markers.
  if (polygonBounds.length) {
    let merged = polygonBounds[0];
    for (let i = 1; i < polygonBounds.length; i++) merged = merged.extend(polygonBounds[i]);
    state.map.fitBounds(merged, { padding: [20, 20] });
  } else if (markerBounds.length) {
    state.map.fitBounds(markerBounds, { padding: [20, 20] });
  }
}

// Re-render the map whenever the ranking changes — but only when the user
// is actually looking at it (no point burning CPU when the table is shown).
const origRenderRankingTable = renderRankingTable;
renderRankingTable = function (...args) {
  origRenderRankingTable.apply(this, args);
  if (state.rankingView.mode === 'map') renderRankingMap();
};
