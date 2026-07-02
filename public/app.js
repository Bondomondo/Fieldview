/* ═══════════════════════════════════════════════════════════
   FieldView – Property Digital Twin  |  app.js
   ═══════════════════════════════════════════════════════════ */

import { createProperty, layerKind, FOREST_TYPE } from './model.js';
import {
  parseForestandXml, joinForest, speciesName,
  cuttingClassColor, FOREST_LAYER_COLOR,
} from './forest-import.js';
import { analyze, listSkiften, DIMENSIONS, MEASURES } from './analysis.js';

// ── Constants ────────────────────────────────────────────────
const PROXY_BASE       = '/proxy?url=';
const SCALE_THRESHOLD  = 10000;   // only fetch WFS below 1:10 000
const MOVEEND_DEBOUNCE = 600;     // ms to wait after map stops moving

// ── Layer colour palette ─────────────────────────────────────
const PALETTE = [
  '#4caf71', '#4a8fe8', '#e87b4a', '#c44ae8',
  '#e8e44a', '#4ae8d8', '#e84a7b', '#8ae84a',
];
let paletteIdx = 0;
function nextColor() { return PALETTE[paletteIdx++ % PALETTE.length]; }

// ── State ────────────────────────────────────────────────────
const state = {
  layers: [],      // { id, name, type, color, kind, visible, leafletLayer, featureCount,
                   //   wfsConfig?, wmsConfig?, forestSummary? }
  capsLayers: [],  // from WFS/WMS GetCapabilities
  serviceType: 'WFS',
  currentUser: null,
  firebaseReady: false,
  property: createProperty(),   // digital-twin metadata (name, propertyId, …)
};

// ── Map setup ────────────────────────────────────────────────
const map = L.map('map', {
  center: [62.0, 15.0],  // Sweden
  zoom: 5,
  zoomControl: true,
});
map.zoomControl.setPosition('bottomright');

const basemaps = {
  osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }),
  satellite: L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: '© Esri, Maxar, Earthstar Geographics', maxZoom: 19 }
  ),
  topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenTopoMap contributors',
    maxZoom: 17,
  }),
};
basemaps.satellite.addTo(map);

// ── Scale calculation ─────────────────────────────────────────
// Returns the current map scale denominator (e.g. 10000 = 1:10 000)
function getMapScale() {
  const zoom   = map.getZoom();
  const lat    = map.getCenter().lat;
  const metersPerPx = (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom);
  // 1 CSS pixel ≈ 0.00026458 m  (96 dpi standard)
  return metersPerPx / 0.00026458;
}

function isScaleSufficientForWFS() {
  return getMapScale() <= SCALE_THRESHOLD;
}

function formatScale(s) {
  return '1 : ' + Math.round(s).toLocaleString();
}

// ── Scale indicator ───────────────────────────────────────────
function updateScaleIndicator() {
  const scale     = getMapScale();
  const el        = document.getElementById('scale-indicator');
  const zoomHint  = document.getElementById('zoom-hint');
  el.textContent  = formatScale(scale);

  const sufficient = scale <= SCALE_THRESHOLD;
  el.classList.toggle('scale-ok',  sufficient);
  el.classList.toggle('scale-far', !sufficient);
  zoomHint.hidden = sufficient;
}

map.on('zoomend moveend', updateScaleIndicator);
updateScaleIndicator();

// ── Basemap switcher ─────────────────────────────────────────
document.querySelectorAll('.basemap-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.basemap;
    Object.values(basemaps).forEach(l => map.removeLayer(l));
    basemaps[name].addTo(map);
    state.layers.forEach(l => { if (l.visible) l.leafletLayer.addTo(map); });
    applyLayerOrder();
    document.querySelectorAll('.basemap-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ── Sidebar toggle ───────────────────────────────────────────
document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
  const sidebar = document.getElementById('sidebar');
  const isMobile = window.innerWidth <= 700;
  if (isMobile) {
    sidebar.classList.toggle('mobile-open');
  } else {
    sidebar.classList.toggle('collapsed');
  }
  setTimeout(() => map.invalidateSize(), 200);
});

// ── Report modal ─────────────────────────────────────────────
document.getElementById('btn-report').addEventListener('click', openReport);
document.getElementById('close-report').addEventListener('click', () => {
  document.getElementById('report-backdrop').hidden = true;
});
document.getElementById('btn-print-report').addEventListener('click', () => window.print());
document.getElementById('report-backdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
});
// Clicking a label-area bar zooms to that label on the map.
document.getElementById('report-body').addEventListener('click', e => {
  const row = e.target.closest('[data-zoom-layer]');
  if (!row) return;
  document.getElementById('report-backdrop').hidden = true;
  zoomToLayer(row.dataset.zoomLayer);
});

// ── Analysis modal ───────────────────────────────────────────
(function initAnalysisControls() {
  const dimSel = document.getElementById('analysis-dimension');
  const meaSel = document.getElementById('analysis-measure');
  dimSel.innerHTML = DIMENSIONS.map(d => `<option value="${d.key}">${d.label}</option>`).join('');
  meaSel.innerHTML = MEASURES.map(m => `<option value="${m.key}">${m.label}</option>`).join('');
  dimSel.addEventListener('change', renderAnalysis);
  meaSel.addEventListener('change', renderAnalysis);
  document.getElementById('analysis-skifte').addEventListener('change', renderAnalysis);
})();

document.getElementById('btn-analysis').addEventListener('click', openAnalysis);
document.getElementById('close-analysis').addEventListener('click', () => {
  document.getElementById('analysis-backdrop').hidden = true;
});
document.getElementById('btn-print-analysis').addEventListener('click', () => window.print());
document.getElementById('analysis-backdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
});
// Clicking a bar highlights the matching stands on the map.
document.getElementById('analysis-body').addEventListener('click', e => {
  const row = e.target.closest('[data-stands]');
  if (!row) return;
  const stands = row.dataset.stands ? row.dataset.stands.split(',').filter(Boolean) : [];
  if (!stands.length) return;
  highlightStands(stands, row.dataset.label);
  document.getElementById('analysis-backdrop').hidden = true;
  toast(`Markerade ${stands.length} bestånd på kartan`, 'info');
});

function openAnalysis() {
  const feats = forestFeatures();
  if (!feats.length) {
    toast('Importera skogsdata först för att analysera', 'warning');
    return;
  }
  // Refresh the skifte filter to what's currently loaded.
  const skiften = listSkiften(feats);
  document.getElementById('analysis-skifte').innerHTML =
    `<option value="">Alla skiften</option>` +
    skiften.map(s => `<option value="${escHtml(s)}">Skifte ${escHtml(s)}</option>`).join('');

  renderAnalysis();
  document.getElementById('analysis-backdrop').hidden = false;
}

function renderAnalysis() {
  const feats = forestFeatures();
  const dimension = document.getElementById('analysis-dimension').value;
  const measure   = document.getElementById('analysis-measure').value;
  const skifte    = document.getElementById('analysis-skifte').value || null;
  const measureMeta = MEASURES.find(m => m.key === measure);
  const unit = measureMeta.unit;

  const res = analyze(feats, dimension, measure, skifte);
  const max = Math.max(1, ...res.rows.map(r => r.value));

  const fmt = v => v.toLocaleString(undefined, { maximumFractionDigits: measure === 'count' ? 0 : 1 });

  const cards = `
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${res.standCount}</div><div class="stat-label">Bestånd</div></div>
      <div class="stat-card"><div class="stat-value">${res.areaHa.toLocaleString()} ha</div><div class="stat-label">Areal</div></div>
      <div class="stat-card"><div class="stat-value">${res.volumeM3sk.toLocaleString()}</div><div class="stat-label">m³sk</div></div>
    </div>`;

  const bars = res.rows.map(r => `
    <div class="analysis-bar-row" data-stands="${escHtml(r.standNos.join(','))}" data-label="${escHtml(r.label)}" title="Visa ${escHtml(r.label)} på kartan">
      <div class="analysis-bar-label">${escHtml(r.label)}</div>
      <div class="analysis-bar-track">
        <div class="analysis-bar-fill" style="width:${(r.value / max) * 100}%;background:${r.color}"></div>
      </div>
      <div class="analysis-bar-value">${fmt(r.value)} ${unit}</div>
      <div class="analysis-bar-pct">${r.pct}%</div>
    </div>`).join('');

  document.getElementById('analysis-body').innerHTML = `
    ${cards}
    <p class="analysis-hint">Klicka på en stapel för att markera bestånden på kartan.</p>
    <div class="analysis-bars">${bars || '<p class="report-empty">Ingen data för detta urval.</p>'}</div>`;
}

function openReport() {
  const labels  = state.layers.filter(l => l.type === 'Label');
  const kmzLayers = state.layers.filter(l => l.type === 'KMZ/KML');
  const forestLayers = state.layers.filter(l => l.type === FOREST_TYPE);
  const body = document.getElementById('report-body');

  if (!labels.length && !kmzLayers.length && !forestLayers.length) {
    body.innerHTML = '<p class="report-empty">Nothing to report yet. Upload fields or import forest data to get started.</p>';
    document.getElementById('report-backdrop').hidden = false;
    return;
  }

  const summaryHtml = propertySummaryHtml();

  // ── KMZ/KML area summary ──────────────────────────────────
  const kmzHtml = kmzLayers.map(layer => {
    const features  = layer.leafletLayer.toGeoJSON().features;
    const polygons  = features.filter(f => f.geometry &&
      (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));
    const totalM2   = polygons.reduce((sum, f) => sum + turf.area(f), 0);
    const areaStr   = formatArea(totalM2);

    return `
      <div class="report-group">
        <div class="report-group-header">
          <svg width="20" height="12" viewBox="0 0 20 12" style="flex-shrink:0">
            <line x1="1" y1="6" x2="19" y2="6" stroke="${layer.color}" stroke-width="2.5" stroke-dasharray="4 3" stroke-linecap="round"/>
          </svg>
          <span class="report-group-name">${escHtml(layer.name)}</span>
          <span class="report-group-count">${features.length} feature${features.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="report-area-row">
          <span class="report-area-label">Total area</span>
          <span class="report-area-value">${areaStr}</span>
        </div>
      </div>`;
  }).join('');

  // ── Label feature tables ──────────────────────────────────
  const labelsHtml = labels.map(label => {
    const features = label.leafletLayer.toGeoJSON().features;
    const keys = [...new Set(features.flatMap(f => Object.keys(f.properties || {})).filter(k => !k.startsWith('@')))];

    const thead = keys.length
      ? `<tr>${keys.map(k => `<th>${escHtml(k)}</th>`).join('')}</tr>`
      : '<tr><th>(no properties)</th></tr>';

    const tbody = features.map(f => {
      const props = f.properties || {};
      return keys.length
        ? `<tr>${keys.map(k => `<td>${escHtml(String(props[k] ?? ''))}</td>`).join('')}</tr>`
        : '<tr><td>—</td></tr>';
    }).join('');

    return `
      <div class="report-group">
        <div class="report-group-header">
          <div class="report-group-dot" style="background:${label.color}"></div>
          <span class="report-group-name">${escHtml(label.name)}</span>
          <span class="report-group-count">${features.length} feature${features.length !== 1 ? 's' : ''}</span>
        </div>
        <table class="report-table">
          <thead>${thead}</thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;
  }).join('');

  body.innerHTML = summaryHtml + labelAreaSummaryHtml() + kmzHtml + labelsHtml;
  document.getElementById('report-backdrop').hidden = false;
}

// Area assigned to each label (e.g. who farms which fields).
function labelAreaSummaryHtml() {
  const labels = state.layers.filter(l => l.type === 'Label');
  if (!labels.length) return '';

  const rows = labels.map(l => {
    const polys = l.leafletLayer.toGeoJSON().features
      .filter(f => f.geometry && /Polygon/.test(f.geometry.type));
    const ha = polys.reduce((s, f) => s + turf.area(f), 0) / 10_000;
    return { id: l.id, name: l.name, color: l.color, ha, count: polys.length };
  }).sort((a, b) => b.ha - a.ha);

  const total = rows.reduce((s, r) => s + r.ha, 0);
  const max = Math.max(1, ...rows.map(r => r.ha));

  return `
    <div class="report-subtitle">Areal per label</div>
    <div class="analysis-bars">
      ${rows.map(r => `
        <div class="analysis-bar-row" data-zoom-layer="${r.id}" title="Zooma till ${escHtml(r.name)}">
          <div class="analysis-bar-label">
            <span class="label-dot" style="background:${r.color}"></span>${escHtml(r.name)}
            <span class="label-count">${r.count} fält</span>
          </div>
          <div class="analysis-bar-track"><div class="analysis-bar-fill" style="width:${(r.ha / max) * 100}%;background:${r.color}"></div></div>
          <div class="analysis-bar-value">${r.ha.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha</div>
          <div class="analysis-bar-pct">${total ? Math.round((r.ha / total) * 100) : 0}%</div>
        </div>`).join('')}
    </div>
    <div class="report-area-row">
      <span class="report-area-label">Totalt tilldelat</span>
      <span class="report-area-value">${formatArea(total * 10_000)}</span>
    </div>`;
}

// Property-wide summary block (fields + forest statistics).
function propertySummaryHtml() {
  const s = computePropertyStats();
  const f = s.forest;

  const card = (label, value) => `
    <div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;

  const cards = [
    card('Field area', formatArea(s.fieldAreaM2)),
    ...(f.standCount ? [
      card('Forest area', `${f.areaHa.toLocaleString()} ha`),
      card('Productive', `${f.productiveAreaHa.toLocaleString()} ha`),
      card('Standing volume', `${f.volumeM3sk.toLocaleString()} m³sk`),
      card('Stands', f.standCount),
      card('Mean age', `${f.meanAge} yr`),
    ] : []),
  ].join('');

  const distTable = (title, map, unit, total) => {
    if (!map.size) return '';
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => {
      const pct = total ? Math.round((v / total) * 100) : 0;
      return `<tr><td>${escHtml(k)}</td><td class="num">${(+v).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}</td><td class="num">${pct}%</td></tr>`;
    }).join('');
    return `<div class="report-subtitle">${title}</div>
      <table class="report-table"><tbody>${rows}</tbody></table>`;
  };

  const speciesTotal = [...f.species.values()].reduce((a, b) => a + b, 0);
  const speciesTable = distTable('Species (by volume)', f.species, ' m³sk', speciesTotal);
  const ageTable     = distTable('Age classes (by area)', f.ageClasses, ' ha', f.areaHa);
  const cutTable     = distTable('Cutting classes (by area)', f.cutClasses, ' ha', f.areaHa);

  const proposed = f.treatments.filter(t => /propos/i.test(t.status));
  const treatmentsTable = proposed.length ? `
    <div class="report-subtitle">Planned treatments (${proposed.length})</div>
    <table class="report-table">
      <thead><tr><th>Stand</th><th>Type</th><th>When</th><th class="num">Area</th></tr></thead>
      <tbody>${proposed.map(t => `<tr>
        <td>${escHtml(t.standNo || '—')}</td>
        <td>${escHtml(t.type || '—')}</td>
        <td>${escHtml(t.date || '')}${t.span ? ' · ' + escHtml(t.span) : ''}</td>
        <td class="num">${t.areaHa} ha</td>
      </tr>`).join('')}</tbody>
    </table>` : '';

  return `
    <div class="report-property-header">
      <h3>${escHtml(state.property.name)}</h3>
      ${state.property.propertyId ? `<span class="report-property-id">${escHtml(state.property.propertyId)}</span>` : ''}
    </div>
    <div class="stat-cards">${cards}</div>
    ${speciesTable}${ageTable}${cutTable}${treatmentsTable}`;
}

function formatArea(m2) {
  return (m2 / 10_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ha';
}

// ── Property statistics ──────────────────────────────────────
function fieldFeatures() {
  return state.layers
    .filter(l => (l.kind || layerKind(l.type)) === 'field')
    .flatMap(l => { try { return l.leafletLayer.toGeoJSON().features; } catch { return []; } });
}
function forestFeatures() {
  return state.layers
    .filter(l => l.type === FOREST_TYPE)
    .flatMap(l => { try { return l.leafletLayer.toGeoJSON().features; } catch { return []; } });
}
function ageBucket(age) {
  if (age <= 20) return '0–20';
  if (age <= 40) return '21–40';
  if (age <= 60) return '41–60';
  if (age <= 80) return '61–80';
  if (age <= 100) return '81–100';
  return '100+';
}

/** Aggregate property-wide numbers from the live layers. */
function computePropertyStats() {
  const fieldPolys = fieldFeatures().filter(f => f.geometry && /Polygon/.test(f.geometry.type));
  const fieldAreaM2 = fieldPolys.reduce((s, f) => s + turf.area(f), 0);

  const feats = forestFeatures();
  let areaHa = 0, prodAreaHa = 0, volume = 0, ageAreaSum = 0, ageWeight = 0;
  const species = new Map(), ageClasses = new Map(), cutClasses = new Map();
  const treatments = [];
  for (const f of feats) {
    const p = f.properties || {};
    const a = p.areaHa || 0;
    areaHa += a;
    prodAreaHa += p.productiveAreaHa || a;
    const vol = p.totalVolumeM3sk || 0;
    volume += vol;
    if (p.meanAgeYr != null) {
      ageAreaSum += p.meanAgeYr * a; ageWeight += a;
      ageClasses.set(ageBucket(p.meanAgeYr), (ageClasses.get(ageBucket(p.meanAgeYr)) || 0) + a);
    }
    if (p.cuttingClass) cutClasses.set(p.cuttingClass, (cutClasses.get(p.cuttingClass) || 0) + a);
    for (const s of (p.species || [])) species.set(s.name, (species.get(s.name) || 0) + vol * (s.pct / 100));
    for (const t of (p.treatments || [])) treatments.push({ ...t, standNo: p.standNo, areaHa: a });
  }

  return {
    fieldAreaM2, fieldCount: fieldPolys.length,
    forest: {
      areaHa: +areaHa.toFixed(1), productiveAreaHa: +prodAreaHa.toFixed(1),
      volumeM3sk: Math.round(volume), standCount: feats.length,
      meanAge: ageWeight ? Math.round(ageAreaSum / ageWeight) : 0,
      species, ageClasses, cutClasses, treatments,
    },
  };
}

// ── Fit all ──────────────────────────────────────────────────
document.getElementById('btn-fit-all').addEventListener('click', fitAll);

function fitAll() {
  const bounds = L.latLngBounds([]);
  state.layers.forEach(l => {
    if (l.visible && l.leafletLayer.getBounds) {
      try { bounds.extend(l.leafletLayer.getBounds()); } catch {}
    }
  });
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [40, 40] });
  } else {
    toast('No layers to fit', 'info');
  }
}

// ── Proxy helper ─────────────────────────────────────────────
function proxied(url) {
  return PROXY_BASE + encodeURIComponent(url);
}

// ── Helpers: Loading overlay ─────────────────────────────────
function showLoading(text = 'Loading…') {
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading-overlay').style.display = 'flex';
}
function hideLoading() {
  document.getElementById('loading-overlay').style.display = 'none';
}

// ── Helpers: Toast ───────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(10px) scale(.95)';
    t.style.transition = 'all .2s ease';
    setTimeout(() => t.remove(), 220);
  }, duration);
}

// ── Helpers: Status message ──────────────────────────────────
function setStatus(id, text, type = 'info') {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `status-msg ${type}`;
  el.hidden = !text;
}

// ── Layer management ─────────────────────────────────────────
// Default stacking priority: fields/labels on top, then forest, then data.
// Lower number = higher on the map = earlier in state.layers (index 0 = front).
function kindPriority(kind) {
  if (kind === 'field') return 0;
  if (kind === 'forestStand') return 1;
  return 2; // data
}

function addLayer({ name, type, color, leafletLayer, featureCount, wfsConfig, wmsConfig, kind, forestSummary }) {
  const id = `layer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const k = kind || layerKind(type);
  const entry = {
    id, name, type, color, visible: true, leafletLayer, featureCount,
    wfsConfig, wmsConfig, forestSummary, kind: k,
  };
  // Insert at the bottom of its priority band (keeps fields above forest
  // above data by default, while respecting any manual ordering).
  let idx = state.layers.findIndex(l => kindPriority(l.kind) > kindPriority(k));
  if (idx === -1) idx = state.layers.length;
  state.layers.splice(idx, 0, entry);
  leafletLayer.addTo(map);
  applyLayerOrder();
  renderLayerList();
  updateLayerCount();
  return entry;
}

// Re-apply map stacking so state.layers order (index 0 = front) is honoured.
function applyLayerOrder() {
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (l.visible && l.leafletLayer.bringToFront) l.leafletLayer.bringToFront();
  }
}

// Move a layer up (toward front) or down (toward back) in the stack.
function moveLayer(id, dir) {
  const i = state.layers.findIndex(l => l.id === id);
  if (i === -1) return;
  const j = i + dir;
  if (j < 0 || j >= state.layers.length) return;
  [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
  applyLayerOrder();
  renderLayerList();
}

function removeLayer(id) {
  const idx = state.layers.findIndex(l => l.id === id);
  if (idx === -1) return;
  map.removeLayer(state.layers[idx].leafletLayer);
  state.layers.splice(idx, 1);
  renderLayerList();
  updateLayerCount();
}

function toggleLayerVisibility(id) {
  const entry = state.layers.find(l => l.id === id);
  if (!entry) return;
  entry.visible = !entry.visible;
  if (entry.visible) {
    entry.leafletLayer.addTo(map);
    applyLayerOrder();
  } else {
    map.removeLayer(entry.leafletLayer);
  }
  renderLayerList();
}

function zoomToLayer(id) {
  const entry = state.layers.find(l => l.id === id);
  if (!entry) return;
  if (entry.leafletLayer.getBounds) {
    try { map.fitBounds(entry.leafletLayer.getBounds(), { padding: [40, 40] }); }
    catch { toast('Cannot zoom to empty layer', 'warning'); }
  }
}

function updateLayerCount() {
  document.getElementById('layer-count').textContent = state.layers.length;
}

// ── Property header ──────────────────────────────────────────
function renderPropertyHeader() {
  const nameEl = document.getElementById('property-name');
  const idEl   = document.getElementById('property-id');
  if (!nameEl) return;
  nameEl.textContent = state.property.name;
  idEl.textContent   = state.property.propertyId || '';
  idEl.hidden        = !state.property.propertyId;

  const stats = computePropertyStats();
  const parts = [];
  if (stats.fieldAreaM2 > 0) parts.push(`<span title="Total field area">🟩 ${formatArea(stats.fieldAreaM2)} fields</span>`);
  if (stats.forest.standCount > 0) {
    parts.push(`<span title="Forest">🌲 ${stats.forest.areaHa.toLocaleString()} ha · ${stats.forest.volumeM3sk.toLocaleString()} m³sk</span>`);
  }
  document.getElementById('property-totals').innerHTML =
    parts.join('') || '<span>No data yet — add fields or import forest</span>';
}

function renderLayerList() {
  renderPropertyHeader();
  const ul = document.getElementById('layer-list');
  if (state.layers.length === 0) {
    ul.innerHTML = '<li class="layer-list-empty">No layers loaded yet</li>';
    return;
  }
  // Flat, ordered list: top row = front on the map. Reorder with ▲/▼.
  ul.innerHTML = state.layers.map((l, i) =>
    layerItemHtml(l, i === 0, i === state.layers.length - 1)).join('');
}

function layerItemHtml(l, isFirst, isLast) {
  return `
    <li class="layer-item" data-id="${l.id}">
      <div class="layer-reorder">
        <button class="btn-reorder" data-action="up" data-id="${l.id}" title="Flytta uppåt (fram)" ${isFirst ? 'disabled' : ''}>▲</button>
        <button class="btn-reorder" data-action="down" data-id="${l.id}" title="Flytta nedåt (bak)" ${isLast ? 'disabled' : ''}>▼</button>
      </div>
      ${layerSwatchHtml(l)}
      <div class="layer-item-info">
        <div class="layer-item-name" title="${l.name}">${l.name}</div>
        <div class="layer-item-meta">${layerMetaText(l)}</div>
      </div>
      <div class="layer-item-actions">
        <button class="btn-layer-vis ${l.visible ? '' : 'hidden-layer'}" data-action="vis" data-id="${l.id}" title="${l.visible ? 'Hide' : 'Show'}">
          ${l.visible ? eyeOpenSvg() : eyeClosedSvg()}
        </button>
        <button class="btn-layer-zoom" data-action="zoom" data-id="${l.id}" title="Zoom to layer">
          ${zoomSvg()}
        </button>
        <button class="btn btn-danger btn-icon" data-action="remove" data-id="${l.id}" title="Remove layer">
          ${trashSvg()}
        </button>
      </div>
    </li>`;
}

function layerMetaText(l) {
  if (l.type === FOREST_TYPE && l.forestSummary) {
    const s = l.forestSummary;
    return `${s.standCount} stands · ${formatArea(s.areaHa * 10_000)} · ${s.volumeM3sk.toLocaleString()} m³sk`;
  }
  const count = l.featureCount != null ? l.featureCount + ' features · ' : '';
  return `${count}${l.type}${l.wfsConfig ? ' · live' : ''}`;
}

function layerSwatchHtml(l) {
  if (l.type === 'KMZ/KML') {
    return `<svg width="20" height="12" viewBox="0 0 20 12" style="flex-shrink:0" aria-hidden="true">
      <line x1="1" y1="6" x2="19" y2="6" stroke="${l.color}" stroke-width="2.5" stroke-dasharray="4 3" stroke-linecap="round"/>
    </svg>`;
  }
  if (l.type === FOREST_TYPE) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" style="flex-shrink:0" fill="${l.color}" aria-hidden="true">
      <path d="M12 2l4 6h-2l3 5h-2l3 5H9v3H7v-3H3l3-5H4l3-5H5z"/></svg>`;
  }
  return `<div class="layer-item-color" style="background:${l.color}"></div>`;
}

// SVG helpers
const eyeOpenSvg   = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const eyeClosedSvg = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const zoomSvg      = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`;
const trashSvg     = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;

// Layer list event delegation
document.getElementById('layer-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'vis')    toggleLayerVisibility(id);
  if (action === 'zoom')   zoomToLayer(id);
  if (action === 'remove') removeLayer(id);
  if (action === 'up')     moveLayer(id, -1);
  if (action === 'down')   moveLayer(id, +1);
});

// ── Feature info panel ───────────────────────────────────────
let _currentFeature = null;
let _selectedLabelColor = '#4caf71';

document.getElementById('close-feature-info').addEventListener('click', () => {
  document.getElementById('feature-info').hidden = true;
});

// Color swatch selection
document.getElementById('label-color-swatches').addEventListener('click', e => {
  const swatch = e.target.closest('.label-swatch');
  if (!swatch) return;
  document.querySelectorAll('.label-swatch').forEach(s => s.classList.remove('active'));
  swatch.classList.add('active');
  _selectedLabelColor = swatch.dataset.color;
});

// Toggle new-label fields based on dropdown selection
document.getElementById('label-select-assign').addEventListener('change', e => {
  const isNew = e.target.value === '__new__';
  document.getElementById('new-label-fields').hidden = !isNew;
  document.getElementById('btn-assign-label').textContent = isNew ? 'Create Label Layer' : 'Add to Label';
});

document.getElementById('btn-assign-label').addEventListener('click', () => {
  if (!_currentFeature) return;
  const sel = document.getElementById('label-select-assign');
  if (sel.value === '__new__') {
    const name = document.getElementById('label-name-input').value.trim();
    if (!name) { toast('Enter a label name', 'warning'); return; }
    const existing = state.layers.find(l => l.type === 'Label' && l.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      toast(`Label "${existing.name}" already exists — select it from the dropdown`, 'warning');
      return;
    }
    createLabelLayer(name, _selectedLabelColor, _currentFeature);
    document.getElementById('label-name-input').value = '';
  } else {
    addFeatureToLabel(sel.value, _currentFeature);
  }
  document.getElementById('feature-info').hidden = true;
});

function populateLabelSelect() {
  const sel = document.getElementById('label-select-assign');
  const labels = state.layers.filter(l => l.type === 'Label');
  sel.innerHTML = `<option value="__new__">— New label —</option>` +
    labels.map(l => `<option value="${l.id}">${escHtml(l.name)}</option>`).join('');
  const isNew = sel.value === '__new__';
  document.getElementById('new-label-fields').hidden = !isNew;
  document.getElementById('btn-assign-label').textContent = isNew ? 'Create Label Layer' : 'Add to Label';
}

function showFeatureInfo(feature, layerName) {
  _currentFeature = feature;
  const props = feature?.properties ?? feature;
  document.getElementById('feature-info-title').textContent = layerName || 'Feature Properties';
  const body = document.getElementById('feature-info-body');
  const entries = Object.entries(props || {}).filter(([k]) => !k.startsWith('@'));
  if (entries.length === 0) {
    body.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:8px">No properties</p>';
  } else {
    body.innerHTML = `<table class="prop-table"><tbody>
      ${entries.map(([k, v]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(String(v ?? ''))}</td></tr>`).join('')}
    </tbody></table>`;
  }
  document.querySelector('.label-assign-section').hidden = false;
  populateLabelSelect();
  document.getElementById('feature-info').hidden = false;
}

// Forest-stand variant: reuses the feature-info panel but renders a rich,
// forestry-specific body and hides the label-assign controls.
function showForestStandInfo(props) {
  _currentFeature = null;
  document.getElementById('feature-info-title').textContent =
    props.standNo ? `Stand ${props.standNo}` : 'Forest stand';

  const fmt = (v, unit = '') => (v == null || v === '' ? '—' : `${v}${unit}`);
  const rows = [
    ['Skifte', fmt(props.skifte)],
    ['Land use', fmt(props.landUse)],
    ['Area', `${fmt(props.areaHa, ' ha')}`],
    ['Productive area', fmt(props.productiveAreaHa, ' ha')],
    ['Cutting class (HKL)', fmt(props.cuttingClass)],
    ['Goal class', fmt(props.goalClass)],
    ['Mean age', fmt(props.meanAgeYr, ' yr')],
    ['Dominant height', fmt(props.dominantHeightM, ' m')],
    ['Basal area', fmt(props.basalAreaM2Ha, ' m²/ha')],
    ['Volume', fmt(props.volumeM3PerHa, ' m³sk/ha')],
    ['Total volume', props.totalVolumeM3sk != null ? `${props.totalVolumeM3sk.toLocaleString()} m³sk` : '—'],
    ['Site index', fmt(props.siteIndex)],
    ['Management class', fmt(props.managementClass)],
    ['Maturity class', fmt(props.maturityClass)],
    ['Soil moisture', fmt(props.soilMoisture)],
  ];

  const speciesHtml = (props.species || []).length
    ? `<div class="stand-section-title">Species mix (by volume)</div>
       ${props.species.map(s => `
         <div class="species-row">
           <span class="species-name">${escHtml(s.name)}</span>
           <span class="species-bar"><span style="width:${Math.min(100, s.pct)}%"></span></span>
           <span class="species-pct">${s.pct}%</span>
         </div>`).join('')}`
    : '';

  const treatmentsHtml = (props.treatments || []).length
    ? `<div class="stand-section-title">Treatments</div>
       <table class="prop-table"><tbody>
         ${props.treatments.map(t => `<tr>
           <td>${escHtml(t.status || '—')}</td>
           <td>${escHtml(t.type || '—')}</td>
           <td>${escHtml(t.date || '')}</td>
         </tr>`).join('')}
       </tbody></table>`
    : '';

  document.getElementById('feature-info-body').innerHTML = `
    <table class="prop-table"><tbody>
      ${rows.map(([k, v]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(String(v))}</td></tr>`).join('')}
    </tbody></table>
    ${speciesHtml}
    ${treatmentsHtml}`;

  document.querySelector('.label-assign-section').hidden = true;
  document.getElementById('feature-info').hidden = false;
}

function normalizeFeature(feature) {
  return feature.type === 'Feature'
    ? feature
    : { type: 'Feature', geometry: feature.geometry ?? null, properties: feature.properties ?? {} };
}

function createLabelLayer(labelName, color, feature) {
  const f = normalizeFeature(feature);
  const leafletLayer = L.geoJSON({ type: 'FeatureCollection', features: [f] }, {
    style: () => ({ color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.25 }),
    pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 6, color, weight: 2, fillColor: color, fillOpacity: 0.8 }),
    onEachFeature: (feat, layer) => { layer.on('click', () => showFeatureInfo(feat, labelName)); },
  });
  addLayer({ name: labelName, type: 'Label', color, leafletLayer, featureCount: 1 });
  toast(`Label "${labelName}" created`, 'success');
}

function addFeatureToLabel(layerId, feature) {
  const entry = state.layers.find(l => l.id === layerId);
  if (!entry) return;
  const f = normalizeFeature(feature);
  const geomStr = JSON.stringify(f.geometry);
  const isDuplicate = entry.leafletLayer.toGeoJSON().features
    .some(ef => JSON.stringify(ef.geometry) === geomStr);
  if (isDuplicate) {
    toast(`This feature is already in label "${entry.name}"`, 'warning');
    return;
  }
  entry.leafletLayer.addData(f);
  // Re-bind click on the newly added sub-layer
  entry.leafletLayer.eachLayer(sub => {
    if (!sub._labelClickBound) {
      sub._labelClickBound = true;
      sub.on('click', () => showFeatureInfo(sub.feature, entry.name));
    }
  });
  entry.featureCount += 1;
  renderLayerList();
  toast(`Added to label "${entry.name}"`, 'success');
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── GeoJSON layer builder ────────────────────────────────────
function buildGeoJsonLayer(geojson, color, layerName) {
  return L.geoJSON(geojson, {
    style: feature => {
      const type = feature.geometry?.type || '';
      const isPoint = type === 'Point' || type === 'MultiPoint';
      return {
        color,
        weight: 2,
        opacity: 0.9,
        fillColor: color,
        fillOpacity: isPoint ? 0.9 : 0.25,
      };
    },
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: 6, color, weight: 2, fillColor: color, fillOpacity: 0.8,
    }),
    onEachFeature: (feature, layer) => {
      layer.on('click', () => showFeatureInfo(feature, layerName));
      layer.on('mouseover', function () {
        if (!feature.geometry?.type.includes('Point')) this.setStyle({ fillOpacity: 0.5, weight: 3 });
      });
      layer.on('mouseout', function () {
        if (!feature.geometry?.type.includes('Point')) this.setStyle({ fillOpacity: 0.25, weight: 2 });
      });
    },
  });
}

// ── KMZ / KML parsing ────────────────────────────────────────
async function parseKmzFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'kml') {
    return kmlTextToGeojson(await file.text(), file.name);
  }
  if (ext === 'kmz') {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const kmlFile = Object.values(zip.files).find(f => f.name.endsWith('.kml') && !f.dir);
    if (!kmlFile) throw new Error('No KML file found inside KMZ');
    return kmlTextToGeojson(await kmlFile.async('text'), file.name);
  }
  throw new Error('Unsupported file type: .' + ext);
}

function kmlTextToGeojson(kmlText, fileName) {
  const kmlDoc = new DOMParser().parseFromString(kmlText, 'application/xml');
  if (kmlDoc.querySelector('parsererror')) throw new Error('Invalid KML/XML');
  const geojson = toGeoJSON.kml(kmlDoc);
  if (!geojson?.features) throw new Error('Could not convert KML to GeoJSON');
  return geojson;
}

async function parseShapefile(file) {
  if (typeof shp === 'undefined') throw new Error('shpjs library not loaded');
  const buf = await file.arrayBuffer();
  const result = await shp(buf);
  // shp() returns a single FeatureCollection or an array of them (multi-layer zip)
  if (Array.isArray(result)) {
    const features = result.flatMap(fc => fc.features ?? []);
    return { type: 'FeatureCollection', features };
  }
  if (!result?.features) throw new Error('Could not parse shapefile');
  return result;
}

// ── Drop zone ────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => /\.(kmz|kml|zip|shp)$/i.test(f.name));
  if (!files.length) { toast('Please drop a .kmz, .kml or shapefile (.zip/.shp)', 'warning'); return; }
  files.forEach(handleFileUpload);
});
fileInput.addEventListener('change', () => {
  Array.from(fileInput.files).forEach(handleFileUpload);
  fileInput.value = '';
});

async function handleFileUpload(file) {
  showLoading(`Parsing ${file.name}…`);
  let geojson;
  try {
    if (/\.(zip|shp)$/i.test(file.name)) {
      geojson = await parseShapefile(file);
    } else {
      geojson = await parseKmzFile(file);
    }
  } catch (err) {
    hideLoading();
    toast(`Error reading file: ${err.message}`, 'error', 5000);
    console.error(err);
    return;
  }

  // Dismiss the overlay before the heavy Leaflet rendering work so the
  // browser can clear the spinner before it gets busy drawing polygons.
  hideLoading();

  const count = geojson.features?.length ?? 0;
  if (!count) { toast(`No features found in ${file.name}`, 'warning'); return; }

  const color = '#ff0000';
  const name  = file.name.replace(/\.(kmz|kml|zip|shp)$/i, '');
  const leafletLayer = L.geoJSON(geojson, {
    style: () => ({
      color,
      weight: 2,
      opacity: 0.9,
      dashArray: '6 6',
      fill: false,
    }),
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: 6, color, weight: 2, dashArray: '4 4', fill: false,
    }),
    onEachFeature: (feature, layer) => {
      layer.on('click', () => showFeatureInfo(feature, name));
    },
  });
  addLayer({ name, type: 'KMZ/KML', color, leafletLayer, featureCount: count });

  try { map.fitBounds(leafletLayer.getBounds(), { padding: [40, 40] }); } catch {}
  addUploadedFileBadge(name, color, count);
  toast(`Loaded "${name}" — ${count} features`, 'success');
}

function addUploadedFileBadge(name, color, count) {
  const el = document.createElement('div');
  el.className = 'uploaded-file-item';
  el.innerHTML = `
    <svg width="16" height="10" viewBox="0 0 16 10" style="flex-shrink:0" aria-hidden="true">
      <line x1="1" y1="5" x2="15" y2="5" stroke="${color}" stroke-width="2" stroke-dasharray="4 3" stroke-linecap="round"/>
    </svg>
    <span class="file-name" title="${escHtml(name)}">${escHtml(name)}</span>
    <span class="file-count">${count} ft</span>
  `;
  document.getElementById('uploaded-files').appendChild(el);
}

// ── Forest import (shapefile + Forestand XML) ────────────────
document.getElementById('btn-import-forest').addEventListener('click', handleForestImport);
['forest-shp', 'forest-xml'].forEach(id =>
  document.getElementById(id).addEventListener('change', updateForestFilesLabel));

function updateForestFilesLabel() {
  const parts = [];
  const shp = document.getElementById('forest-shp').files[0];
  const xml = document.getElementById('forest-xml').files[0];
  if (shp) parts.push(`▪ ${shp.name}`);
  if (xml) parts.push(`▪ ${xml.name}`);
  document.getElementById('forest-import-files').textContent = parts.join('   ');
}

async function handleForestImport() {
  const shpFile = document.getElementById('forest-shp').files[0];
  const xmlFile = document.getElementById('forest-xml').files[0];
  if (!shpFile) { toast('Select a forest shapefile (.zip or .shp)', 'warning'); return; }

  showLoading('Importing forest data…');
  let result;
  try {
    const [geojson, xmlResult] = await Promise.all([
      parseShapefile(shpFile),
      xmlFile ? xmlFile.text().then(parseForestandXml) : Promise.resolve(null),
    ]);
    if (!geojson.features?.length) throw new Error('No polygons in shapefile');
    result = joinForest(geojson, xmlResult, turf);
  } catch (err) {
    hideLoading();
    toast(`Forest import failed: ${err.message}`, 'error', 6000);
    console.error(err);
    return;
  }
  hideLoading();

  // Adopt property metadata from the XML if we don't have a real name yet
  if (result.propertyName && state.property.name === 'My Property') {
    state.property.name = result.propertyName;
    state.property.propertyId = result.propertyId;
    renderPropertyHeader();
  }

  const name = result.propertyName ? `Forest — ${result.propertyName}` : 'Forest stands';
  const leafletLayer = buildForestStandLayer(result.features);
  addLayer({
    name, type: FOREST_TYPE, color: FOREST_LAYER_COLOR, kind: 'forestStand',
    leafletLayer, featureCount: result.summary.standCount, forestSummary: result.summary,
  });

  try { map.fitBounds(leafletLayer.getBounds(), { padding: [40, 40] }); } catch {}

  const u = result.unmatched;
  let msg = `Imported ${result.summary.standCount} stands · ${result.summary.areaHa} ha · ${result.summary.volumeM3sk.toLocaleString()} m³sk`;
  if (u.noAttrs.length) msg += ` · ${u.noAttrs.length} without XML data`;
  toast(msg, 'success', 6000);
  if (u.noGeom.length) console.warn('[forest] XML stands without geometry:', u.noGeom);

  document.getElementById('forest-shp').value = '';
  document.getElementById('forest-xml').value = '';
  document.getElementById('forest-import-files').textContent = '';
}

// Active analysis highlight: a Set of stand numbers, or null for none.
let _standHighlight = null;

function forestStandStyle(props) {
  const color = cuttingClassColor(props?.cuttingClass);
  if (_standHighlight) {
    if (_standHighlight.has(props?.standNo)) {
      return { color: '#ffd23f', weight: 3, opacity: 1, fillColor: color, fillOpacity: 0.75 };
    }
    return { color, weight: 0.5, opacity: 0.3, fillColor: color, fillOpacity: 0.08 };
  }
  return { color, weight: 1.5, opacity: 0.9, fillColor: color, fillOpacity: 0.45 };
}

function buildForestStandLayer(features) {
  return L.geoJSON({ type: 'FeatureCollection', features }, {
    style: feature => forestStandStyle(feature.properties),
    onEachFeature: (feature, layer) => {
      layer.on('click', () => showForestStandInfo(feature.properties));
      layer.on('mouseover', function () { this.setStyle({ weight: 3, fillOpacity: 0.7 }); this.bringToFront(); });
      layer.on('mouseout',  function () { this.setStyle(forestStandStyle(feature.properties)); });
    },
  });
}

// Re-apply styles to every forest layer (after a highlight change).
function restyleForest() {
  state.layers.filter(l => l.type === FOREST_TYPE)
    .forEach(l => l.leafletLayer.setStyle(f => forestStandStyle(f.properties)));
}

function highlightStands(standNos, label) {
  _standHighlight = new Set(standNos);
  restyleForest();
  const btn = document.getElementById('clear-highlight');
  document.getElementById('clear-highlight-label').textContent =
    label ? `${label} (${standNos.length})` : `Markerade (${standNos.length})`;
  btn.hidden = false;
  // Zoom to the highlighted stands
  const bounds = L.latLngBounds([]);
  state.layers.filter(l => l.type === FOREST_TYPE).forEach(l =>
    l.leafletLayer.eachLayer(sub => {
      if (_standHighlight.has(sub.feature?.properties?.standNo) && sub.getBounds) {
        try { bounds.extend(sub.getBounds()); } catch {}
      }
    }));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50] });
}

function clearHighlight() {
  _standHighlight = null;
  restyleForest();
  document.getElementById('clear-highlight').hidden = true;
}

document.getElementById('clear-highlight').addEventListener('click', clearHighlight);

// ── WFS GetCapabilities ──────────────────────────────────────
document.getElementById('btn-load-caps').addEventListener('click', loadCapabilities);
document.getElementById('wfs-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadCapabilities();
});

async function loadCapabilities() {
  const rawUrl = document.getElementById('wfs-url').value.trim();
  if (!rawUrl) { setStatus('caps-status', 'Please enter a WFS or WMS URL', 'error'); return; }

  const serviceType = detectServiceType(rawUrl);
  state.serviceType = serviceType;

  setStatus('caps-status', `Fetching ${serviceType} capabilities…`, 'loading');
  document.getElementById('layer-selector-wrap').hidden = true;
  showLoading(`Fetching ${serviceType} capabilities…`);

  const capsUrl = buildCapsUrl(rawUrl, serviceType);

  try {
    const resp = await fetchWithTimeout(proxied(capsUrl));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    parseCapsXml(await resp.text(), rawUrl, serviceType);
  } catch (err) {
    setStatus('caps-status', `Failed to load capabilities: ${err.message}`, 'error');
    toast(`${serviceType} capabilities failed — check the URL`, 'error', 6000);
    console.error(err);
  } finally {
    hideLoading();
  }
}

function detectServiceType(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    const svc = (u.searchParams.get('SERVICE') || u.searchParams.get('service') || '').toUpperCase();
    if (svc === 'WMS') return 'WMS';
    if (svc === 'WFS') return 'WFS';
    // Guess from path (e.g. ArcGIS WmsServer / WFSServer)
    if (/wmsserver|\/wms/i.test(u.pathname)) return 'WMS';
    if (/wfsserver|\/wfs/i.test(u.pathname)) return 'WFS';
  } catch {}
  return 'WFS'; // safe default
}

function buildCapsUrl(base, serviceType = 'WFS') {
  const url = new URL(base.startsWith('http') ? base : 'https://' + base);
  url.searchParams.set('SERVICE', serviceType);
  url.searchParams.set('REQUEST', 'GetCapabilities');
  return url.toString();
}

function parseCapsXml(xmlText, baseUrl, serviceType) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    setStatus('caps-status', 'Server returned invalid XML', 'error');
    return;
  }

  if (serviceType === 'WMS') {
    parseCapsXmlWms(doc, baseUrl);
  } else {
    parseCapsXmlWfs(doc, baseUrl);
  }
}

function getDirectChildText(el, tag) {
  for (const child of el.children) {
    if (child.localName === tag) return child.textContent.trim();
  }
  return '';
}

function parseCapsXmlWms(doc, baseUrl) {
  // Collect all <Layer> elements that have a direct <Name> child (named/leaf layers)
  const allLayers = Array.from(doc.getElementsByTagNameNS('*', 'Layer'));
  const namedLayers = allLayers.filter(l => getDirectChildText(l, 'Name'));

  if (!namedLayers.length) {
    setStatus('caps-status', 'No layers found in this WMS service', 'error');
    return;
  }

  state.capsLayers = namedLayers.map(l => ({
    name:        getDirectChildText(l, 'Name'),
    title:       getDirectChildText(l, 'Title'),
    abstract:    getDirectChildText(l, 'Abstract'),
    baseUrl,
    serviceType: 'WMS',
  }));

  renderCapsSelect();
  document.getElementById('feature-limit-row').hidden = true;
  setStatus('caps-status', `Found ${state.capsLayers.length} WMS layer(s)`, 'success');
}

function parseCapsXmlWfs(doc, baseUrl) {
  let featureTypes = Array.from(doc.querySelectorAll('FeatureType'));
  if (!featureTypes.length) {
    featureTypes = Array.from(doc.getElementsByTagNameNS('*', 'FeatureType'));
  }
  if (!featureTypes.length) {
    setStatus('caps-status', 'No layers found in this WFS service', 'error');
    return;
  }

  state.capsLayers = featureTypes.map(ft => {
    const getText = tag => ft.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim() ?? '';
    return {
      name:        getText('Name'),
      title:       getText('Title'),
      abstract:    getText('Abstract'),
      baseUrl,
      serviceType: 'WFS',
    };
  }).filter(l => l.name);

  renderCapsSelect();
  document.getElementById('feature-limit-row').hidden = false;
  setStatus('caps-status', `Found ${state.capsLayers.length} WFS layer(s)`, 'success');
}

function renderCapsSelect() {
  const sel = document.getElementById('layer-select');
  sel.innerHTML = state.capsLayers.map(l =>
    `<option value="${escHtml(l.name)}">${escHtml(l.title || l.name)}</option>`
  ).join('');
  document.getElementById('layer-selector-wrap').hidden = false;
  updateLayerDescription();
}

document.getElementById('layer-select').addEventListener('change', updateLayerDescription);

function updateLayerDescription() {
  const name = document.getElementById('layer-select').value;
  const info = state.capsLayers.find(l => l.name === name);
  const desc = document.getElementById('layer-description');
  if (info?.abstract) { desc.textContent = info.abstract; desc.hidden = false; }
  else { desc.hidden = true; }
}

// ── WFS / WMS Add Layer ───────────────────────────────────────
document.getElementById('btn-add-layer').addEventListener('click', loadSelectedLayer);

function loadSelectedLayer() {
  if (state.serviceType === 'WMS') loadWmsLayer();
  else loadWfsLayer();
}

function loadWmsLayer() {
  const layerName = document.getElementById('layer-select').value;
  const rawUrl    = document.getElementById('wfs-url').value.trim();
  if (!layerName) { toast('Select a layer first', 'warning'); return; }

  const info        = state.capsLayers.find(l => l.name === layerName);
  const displayName = info?.title || layerName;

  // Strip query string — L.tileLayer.wms builds its own params
  let baseWmsUrl;
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl);
    u.search = '';
    baseWmsUrl = u.toString();
  } catch {
    baseWmsUrl = rawUrl.split('?')[0];
  }

  const leafletLayer = L.tileLayer.wms(baseWmsUrl, {
    layers:      layerName,
    format:      'image/png',
    transparent: true,
    version:     '1.3.0',
  });

  // Route every tile request through the proxy so Basic Auth is injected server-side
  const origGetTileUrl = leafletLayer.getTileUrl.bind(leafletLayer);
  leafletLayer.getTileUrl = coords => '/proxy?url=' + encodeURIComponent(origGetTileUrl(coords));

  const color = nextColor();
  addLayer({ name: displayName, type: 'WMS', color, leafletLayer, featureCount: null, wmsConfig: { baseUrl: baseWmsUrl, layerName } });

  setStatus('caps-status', `Loaded WMS layer "${displayName}"`, 'success');
  toast(`Loaded WMS layer "${displayName}"`, 'success');
}

// ── WFS GetFeature (viewport + scale gated) ───────────────────
async function loadWfsLayer() {
  if (!isScaleSufficientForWFS()) {
    toast(`Zoom in to at least 1:${SCALE_THRESHOLD.toLocaleString()} to load WFS features`, 'warning', 5000);
    return;
  }

  const typeName = document.getElementById('layer-select').value;
  const rawUrl   = document.getElementById('wfs-url').value.trim();
  const limit    = parseInt(document.getElementById('feature-limit').value, 10) || 2000;
  if (!typeName) { toast('Select a layer first', 'warning'); return; }

  const info        = state.capsLayers.find(l => l.name === typeName);
  const displayName = (info?.title || typeName).replace(/^[^:]+:/, '');

  showLoading(`Loading "${displayName}"…`);
  setStatus('caps-status', `Fetching "${displayName}"…`, 'loading');

  const wfsConfig = { baseUrl: rawUrl, typeName, limit };

  try {
    const geojson = await fetchWfsFeatures(wfsConfig);
    const count   = geojson.features.length;

    if (!count) {
      setStatus('caps-status', `No features in current view for "${displayName}"`, 'info');
      toast(`No features in current view for "${displayName}"`, 'warning');
      hideLoading();
      return;
    }

    const color        = nextColor();
    const leafletLayer = buildGeoJsonLayer(geojson, color, displayName);
    addLayer({ name: displayName, type: 'WFS', color, leafletLayer, featureCount: count, wfsConfig });

    setStatus('caps-status', `Loaded "${displayName}" — ${count} features (live viewport)`, 'success');
    toast(`Loaded "${displayName}" — ${count} features`, 'success');
  } catch (err) {
    setStatus('caps-status', `Error loading layer: ${err.message}`, 'error');
    toast(`Failed to load layer: ${err.message}`, 'error', 6000);
    console.error(err);
  } finally {
    hideLoading();
  }
}

// Build BBOX string from current map view.
// SRSNAME=CRS84 → lon,lat order; the BBOX coordinates must match.
function getViewportBbox() {
  const b = map.getBounds();
  const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
  // CRS84 axis order: lon,lat
  return `${w},${s},${e},${n},urn:ogc:def:crs:OGC::CRS84`;
}

function buildFeatureUrl(baseUrl, typeName, limit) {
  const url = new URL(baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('request', 'GetFeature');
  url.searchParams.set('typeName', typeName);
  url.searchParams.set('outputFormat', 'application/json');
  // SRSNAME forces the server to reproject to WGS84 lon/lat regardless of
  // the layer's native CRS (e.g. SWEREF99TM / EPSG:3006 for Swedish data).
  url.searchParams.set('SRSNAME', 'urn:ogc:def:crs:OGC::CRS84');
  url.searchParams.set('count', String(limit));
  url.searchParams.set('maxFeatures', String(limit));  // WFS 1.x compat
  url.searchParams.set('BBOX', getViewportBbox());
  return url.toString();
}

// Fetch with a hard timeout so the loading overlay can never get stuck.
async function fetchWithTimeout(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out after 30 s');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWfsFeatures(wfsConfig) {
  const { baseUrl, typeName, limit } = wfsConfig;
  const url  = buildFeatureUrl(baseUrl, typeName, limit);
  const resp = await fetchWithTimeout(proxied(url));
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

  const body = await resp.text();

  // Try JSON first (regardless of content-type — some servers lie)
  try {
    const geojson = JSON.parse(body);
    if (geojson?.features) return geojson;
    // WFS exception wrapped in JSON
    if (geojson?.exceptions || geojson?.code)
      throw new Error(geojson.exceptions?.[0]?.text || geojson.message || 'WFS exception');
  } catch (jsonErr) {
    // Not JSON — fall through to GML parser
    if (!(jsonErr.message.startsWith('WFS') || jsonErr instanceof SyntaxError)) throw jsonErr;
  }

  // GML fallback
  return gmlToGeojson(body, typeName);

  // GML fallback
  const text = await resp.text();
  return gmlToGeojson(text, typeName);
}

// ── Live viewport refetch on map move ─────────────────────────
let moveendTimer = null;

map.on('moveend', () => {
  clearTimeout(moveendTimer);
  moveendTimer = setTimeout(refetchWfsLayers, MOVEEND_DEBOUNCE);
});

async function refetchWfsLayers() {
  const wfsLayers = state.layers.filter(l => l.wfsConfig && l.visible);
  if (!wfsLayers.length) return;

  if (!isScaleSufficientForWFS()) {
    // Hide WFS features but don't remove the layer entry
    wfsLayers.forEach(l => {
      l.leafletLayer.clearLayers();
      l.featureCount = 0;
    });
    renderLayerList();
    return;
  }

  // Silently refresh each WFS layer in the background
  for (const entry of wfsLayers) {
    try {
      const geojson = await fetchWfsFeatures(entry.wfsConfig);
      entry.leafletLayer.clearLayers();
      entry.leafletLayer.addData(geojson);
      entry.featureCount = geojson.features.length;
    } catch (err) {
      console.warn('[moveend refetch]', entry.name, err.message);
    }
  }
  renderLayerList();
}

// ── Label save / load ─────────────────────────────────────────
document.getElementById('btn-save-labels').addEventListener('click', saveLabels);
document.getElementById('btn-load-labels').addEventListener('click', () => {
  document.getElementById('label-file-input').click();
});
document.getElementById('label-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadLabels(file);
  e.target.value = '';
});

function saveLabels() {
  const saveable = state.layers.filter(l =>
    l.type === 'Label' || l.type === 'KMZ/KML' || l.type === FOREST_TYPE);
  if (!saveable.length) { toast('No fields, forest or label layers to save', 'warning'); return; }
  const data = saveable.map(serializeLayer);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fieldview-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  const counts = {
    label:  saveable.filter(l => l.type === 'Label').length,
    kmz:    saveable.filter(l => l.type === 'KMZ/KML').length,
    forest: saveable.filter(l => l.type === FOREST_TYPE).length,
  };
  toast(`Saved ${describeLayerCounts(counts)}`, 'success');
}

async function loadLabels(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error('Expected an array');
  } catch (err) {
    toast(`Invalid label file: ${err.message}`, 'error', 5000);
    return;
  }
  const counts = restoreLayerArray(data);
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (total) {
    toast(`Loaded ${describeLayerCounts(counts)}`, 'success');
    fitAll();
  } else {
    toast('No valid layers found in file', 'warning');
  }
}

// ── Shared layer restore helpers ──────────────────────────────

/**
 * Restore an array of serialized layer objects onto the map.
 * Returns an object with counts by type: { label, kmz, wfs, wms }.
 */
function restoreLayerArray(items) {
  const counts = { label: 0, kmz: 0, wfs: 0, wms: 0, forest: 0 };
  for (const item of items) {
    if (!item.name || !item.color) continue;
    const type = item.type || 'Label';

    if (type === FOREST_TYPE && Array.isArray(item.features)) {
      const summary = item.forestSummary || {
        standCount: item.features.length,
        areaHa: +item.features.reduce((s, f) => s + (f.properties?.areaHa || 0), 0).toFixed(1),
        volumeM3sk: Math.round(item.features.reduce((s, f) => s + (f.properties?.totalVolumeM3sk || 0), 0)),
      };
      const leafletLayer = buildForestStandLayer(item.features);
      addLayer({ name: item.name, type: FOREST_TYPE, color: item.color, kind: 'forestStand',
        leafletLayer, featureCount: item.features.length, forestSummary: summary });
      counts.forest++;
    } else if (type === 'WFS' && item.wfsConfig) {
      // Re-add with saved config; live features will be fetched on the next moveend
      addLayer({ name: item.name, type: 'WFS', color: item.color,
        leafletLayer: L.geoJSON(), featureCount: 0, wfsConfig: item.wfsConfig });
      counts.wfs++;
    } else if (type === 'WMS' && item.wmsConfig) {
      const { baseUrl, layerName } = item.wmsConfig;
      const leafletLayer = L.tileLayer.wms(baseUrl, {
        layers: layerName, format: 'image/png', transparent: true, version: '1.3.0',
      });
      const orig = leafletLayer.getTileUrl.bind(leafletLayer);
      leafletLayer.getTileUrl = coords => '/proxy?url=' + encodeURIComponent(orig(coords));
      addLayer({ name: item.name, type: 'WMS', color: item.color,
        leafletLayer, featureCount: null, wmsConfig: item.wmsConfig });
      counts.wms++;
    } else if ((type === 'KMZ/KML' || type === 'Label') && Array.isArray(item.features)) {
      const color = item.color;
      const layerName = item.name;
      const geojson = { type: 'FeatureCollection', features: item.features };
      if (type === 'KMZ/KML') {
        const leafletLayer = L.geoJSON(geojson, {
          style: () => ({ color, weight: 2, opacity: 0.9, dashArray: '6 6', fill: false }),
          pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 6, color, weight: 2, dashArray: '4 4', fill: false }),
          onEachFeature: (feat, layer) => { layer.on('click', () => showFeatureInfo(feat, layerName)); },
        });
        addLayer({ name: layerName, type: 'KMZ/KML', color, leafletLayer, featureCount: item.features.length });
        counts.kmz++;
      } else {
        const leafletLayer = L.geoJSON(geojson, {
          style: () => ({ color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.25 }),
          pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 6, color, weight: 2, fillColor: color, fillOpacity: 0.8 }),
          onEachFeature: (feat, layer) => { layer.on('click', () => showFeatureInfo(feat, layerName)); },
        });
        addLayer({ name: layerName, type: 'Label', color, leafletLayer, featureCount: item.features.length });
        counts.label++;
      }
    }
  }
  return counts;
}

function serializeLayer(l) {
  if (l.type === 'WFS') {
    return { type: 'WFS', name: l.name, color: l.color, wfsConfig: l.wfsConfig };
  }
  if (l.type === 'WMS') {
    return { type: 'WMS', name: l.name, color: l.color, wmsConfig: l.wmsConfig };
  }
  if (l.type === FOREST_TYPE) {
    return { type: FOREST_TYPE, name: l.name, color: l.color,
      forestSummary: l.forestSummary, features: l.leafletLayer.toGeoJSON().features };
  }
  // Label / KMZ/KML — embed GeoJSON
  return { type: l.type, name: l.name, color: l.color, features: l.leafletLayer.toGeoJSON().features };
}

function describeLayerCounts({ label = 0, kmz = 0, wfs = 0, wms = 0, forest = 0 }) {
  const parts = [];
  if (label)  parts.push(`${label} label layer${label !== 1 ? 's' : ''}`);
  if (kmz)    parts.push(`${kmz} KMZ/KML layer${kmz !== 1 ? 's' : ''}`);
  if (forest) parts.push(`${forest} forest layer${forest !== 1 ? 's' : ''}`);
  if (wfs)    parts.push(`${wfs} WFS layer${wfs !== 1 ? 's' : ''}`);
  if (wms)    parts.push(`${wms} WMS layer${wms !== 1 ? 's' : ''}`);
  return parts.join(', ');
}

// ── GML → GeoJSON fallback ─────────────────────────────────────
function gmlToGeojson(xmlText, typeName) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const ex = doc.querySelector('ExceptionReport, ows\\:ExceptionReport');
  if (ex) {
    const msg = doc.querySelector('ExceptionText, ows\\:ExceptionText')?.textContent;
    throw new Error(msg || 'WFS exception');
  }

  const features = [];
  const members  = doc.querySelectorAll('member > *, featureMember > *, featureMembers > *');

  members.forEach(member => {
    const props = {};
    const geom  = extractGmlGeometry(member);
    Array.from(member.children).forEach(child => {
      const tag  = child.localName;
      if (['boundedBy', 'location'].includes(tag)) return;
      const text = child.textContent?.trim();
      if (text && !child.children.length) props[tag] = text;
    });
    if (geom) features.push({ type: 'Feature', geometry: geom, properties: props });
  });

  return { type: 'FeatureCollection', features };
}

function extractGmlGeometry(elem) {
  const poly  = elem.querySelector('*|Polygon, *|MultiPolygon');
  const point = elem.querySelector('*|Point');
  const line  = elem.querySelector('*|LineString, *|MultiLineString, *|MultiCurve');
  if (poly)  return gmlPolygonToGeojson(poly);
  if (line)  return gmlLineToGeojson(line);
  if (point) return gmlPointToGeojson(point);
  return null;
}

function parsePosList(el) {
  const raw  = el.querySelector('*|posList, *|coordinates')?.textContent?.trim() ?? '';
  const nums = raw.split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
  const coords = [];
  for (let i = 0; i + 1 < nums.length; i += 2) coords.push([nums[i], nums[i + 1]]);
  // If first coordinate looks like lat (|val| ≤ 90) swap assuming lon,lat already correct
  if (coords.length && Math.abs(coords[0][0]) > 90) return coords.map(c => [c[1], c[0]]);
  return coords;
}

function gmlPolygonToGeojson(el) {
  const ext   = el.querySelector('*|exterior');
  const ints  = Array.from(el.querySelectorAll('*|interior'));
  const outer = ext ? parsePosList(ext) : [];
  const holes = ints.map(i => parsePosList(i));
  if (outer.length < 3) return null;
  return { type: 'Polygon', coordinates: [outer, ...holes] };
}

function gmlLineToGeojson(el) {
  const coords = parsePosList(el);
  if (coords.length < 2) return null;
  return { type: 'LineString', coordinates: coords };
}

function gmlPointToGeojson(el) {
  const pos  = el.querySelector('*|pos, *|coordinates');
  if (!pos) return null;
  const nums = pos.textContent.trim().split(/[\s,]+/).map(Number);
  if (nums.length < 2) return null;
  const [x, y] = nums;
  if (Math.abs(x) > 90) return { type: 'Point', coordinates: [y, x] };
  return { type: 'Point', coordinates: [x, y] };
}

// ── Firebase / Google Auth ────────────────────────────────────

async function initFirebase() {
  try {
    const config = await fetch('/api/config').then(r => r.json());
    if (!config.apiKey) return; // env vars not set — auth silently disabled
    firebase.initializeApp(config);
    state.firebaseReady = true;
    firebase.auth().onAuthStateChanged(handleAuthChange);
    // Load a shared map if ?share= is present — works even without sign-in
    maybeLoadSharedMap();
  } catch (e) {
    console.warn('[firebase] not configured:', e.message);
  }
}

function handleAuthChange(user) {
  state.currentUser = user;
  document.getElementById('btn-signin').hidden          = !!user;
  document.getElementById('user-chip').hidden           = !user;
  document.getElementById('btn-open-workspaces').hidden = !user;
  document.getElementById('btn-open-share').hidden      = !user;
  if (user) {
    document.getElementById('user-name').textContent = user.displayName ?? user.email;
    document.getElementById('user-avatar').src       = user.photoURL ?? '';
    document.getElementById('user-avatar').hidden    = !user.photoURL;
  }
}

document.getElementById('btn-signin').addEventListener('click', () => {
  if (!state.firebaseReady) { toast('Firebase is not configured', 'error'); return; }
  firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider())
    .catch(err => toast(`Sign-in failed: ${err.message}`, 'error', 6000));
});

document.getElementById('btn-signout').addEventListener('click', () => {
  firebase.auth().signOut();
});

// ── Workspace modal ───────────────────────────────────────────

document.getElementById('btn-open-workspaces').addEventListener('click', openWorkspacesModal);
document.getElementById('btn-close-workspaces').addEventListener('click', closeWorkspacesModal);
document.getElementById('workspaces-backdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeWorkspacesModal();
});
document.getElementById('btn-save-workspace').addEventListener('click', handleSaveWorkspace);

function openWorkspacesModal() {
  document.getElementById('workspaces-backdrop').hidden = false;
  refreshWorkspaceList();
  refreshOverwriteSelect();
}

async function refreshOverwriteSelect() {
  const sel = document.getElementById('workspace-overwrite-select');
  sel.innerHTML = '<option value="">— New workspace —</option>';
  if (!state.currentUser) return;
  try {
    const workspaces = await loadWorkspaceList();
    workspaces.forEach(ws => {
      const opt = document.createElement('option');
      opt.value = ws.id;
      opt.textContent = ws.name;
      sel.appendChild(opt);
    });
  } catch {}
}

// When an existing workspace is selected, pre-fill the name input
document.getElementById('workspace-overwrite-select').addEventListener('change', e => {
  const sel = e.target;
  const name = sel.options[sel.selectedIndex]?.text;
  if (sel.value && name) {
    document.getElementById('workspace-name-input').value = name;
  } else {
    document.getElementById('workspace-name-input').value = '';
  }
});

function closeWorkspacesModal() {
  document.getElementById('workspaces-backdrop').hidden = true;
}

async function handleSaveWorkspace() {
  const name        = document.getElementById('workspace-name-input').value.trim();
  const overwriteId = document.getElementById('workspace-overwrite-select').value;
  if (!name) { toast('Enter a workspace name', 'warning'); return; }
  if (!state.currentUser) { toast('Sign in first', 'warning'); return; }
  if (!state.layers.length) { toast('No layers to save', 'warning'); return; }

  const btn = document.getElementById('btn-save-workspace');
  btn.disabled = true;
  try {
    await saveWorkspace(name, overwriteId || null);
    document.getElementById('workspace-name-input').value = '';
    document.getElementById('workspace-overwrite-select').value = '';
    toast(`Saved workspace "${name}"`, 'success');
    refreshWorkspaceList();
    refreshOverwriteSelect();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error', 6000);
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

async function saveWorkspace(name, overwriteId = null) {
  const layers = state.layers.map(serializeLayer).filter(Boolean);
  const payload = { name, savedAt: firebase.firestore.FieldValue.serverTimestamp(), layersJson: JSON.stringify(layers) };
  const col = firebase.firestore().collection('users').doc(state.currentUser.uid).collection('workspaces');
  if (overwriteId) {
    await col.doc(overwriteId).set(payload);
  } else {
    await col.add(payload);
  }
}

async function refreshWorkspaceList() {
  const el = document.getElementById('workspace-list');
  el.innerHTML = '<p class="workspace-empty">Loading…</p>';
  try {
    const workspaces = await loadWorkspaceList();
    if (!workspaces.length) {
      el.innerHTML = '<p class="workspace-empty">No saved workspaces yet.</p>';
      return;
    }
    el.innerHTML = workspaces.map(ws => {
      const date = ws.savedAt?.toDate ? ws.savedAt.toDate().toLocaleDateString() : '–';
      return `<div class="workspace-row" data-id="${escHtml(ws.id)}">
        <div class="workspace-info">
          <span class="workspace-name">${escHtml(ws.name)}</span>
          <span class="workspace-date">${date}</span>
        </div>
        <div class="workspace-actions">
          <button class="btn btn-accent btn-sm" data-action="load">Load</button>
          <button class="btn btn-danger btn-sm btn-icon" data-action="delete" title="Delete">
            ${trashSvg()}
          </button>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<p class="workspace-empty">Failed to load: ${escHtml(err.message)}</p>`;
  }
}

document.getElementById('workspace-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const row = btn.closest('[data-id]');
  const id  = row?.dataset.id;
  if (!id) return;
  if (btn.dataset.action === 'load') {
    await handleLoadWorkspace(id, row.querySelector('.workspace-name')?.textContent);
  } else if (btn.dataset.action === 'delete') {
    await handleDeleteWorkspace(id, row.querySelector('.workspace-name')?.textContent);
  }
});

async function handleLoadWorkspace(id, name) {
  if (state.layers.length) {
    const ok = confirm(`Loading "${name}" will clear all current layers. Continue?`);
    if (!ok) return;
  }
  try {
    const doc = await firebase.firestore()
      .collection('users').doc(state.currentUser.uid)
      .collection('workspaces').doc(id)
      .get();
    if (!doc.exists) { toast('Workspace not found', 'error'); return; }
    // Clear existing layers
    [...state.layers].forEach(l => removeLayer(l.id));
    const raw    = doc.data();
    const layers = raw.layersJson ? JSON.parse(raw.layersJson) : (raw.layers ?? []);
    const counts = restoreLayerArray(layers);
    const total  = Object.values(counts).reduce((s, n) => s + n, 0);
    if (total) {
      toast(`Loaded "${name}": ${describeLayerCounts(counts)}`, 'success');
      fitAll();
    } else {
      toast('Workspace had no valid layers', 'warning');
    }
    closeWorkspacesModal();
  } catch (err) {
    toast(`Load failed: ${err.message}`, 'error', 6000);
    console.error(err);
  }
}

async function handleDeleteWorkspace(id, name) {
  if (!confirm(`Delete workspace "${name}"?`)) return;
  try {
    await firebase.firestore()
      .collection('users').doc(state.currentUser.uid)
      .collection('workspaces').doc(id)
      .delete();
    toast(`Deleted "${name}"`, 'success');
    refreshWorkspaceList();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error', 6000);
  }
}

async function loadWorkspaceList() {
  const snap = await firebase.firestore()
    .collection('users').doc(state.currentUser.uid)
    .collection('workspaces')
    .orderBy('savedAt', 'desc')
    .limit(50)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Share map ─────────────────────────────────────────────────

document.getElementById('btn-open-share').addEventListener('click', () => {
  document.getElementById('share-link-row').hidden = true;
  document.getElementById('share-backdrop').hidden = false;
});
document.getElementById('btn-close-share').addEventListener('click', () => {
  document.getElementById('share-backdrop').hidden = true;
});
document.getElementById('share-backdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) document.getElementById('share-backdrop').hidden = true;
});

document.getElementById('btn-copy-link').addEventListener('click', () => {
  const input = document.getElementById('share-link-input');
  navigator.clipboard.writeText(input.value)
    .then(() => toast('Link copied', 'success'))
    .catch(() => { input.select(); document.execCommand('copy'); toast('Link copied', 'success'); });
});

document.getElementById('btn-send-share').addEventListener('click', async () => {
  if (!state.layers.length) { toast('No layers to share', 'warning'); return; }
  if (!state.currentUser) { toast('Sign in to share a map', 'warning'); return; }

  const name  = document.getElementById('share-name-input').value.trim() || 'Shared map';
  const email = document.getElementById('share-email-input').value.trim();
  if (!email) { toast('Enter a recipient email address', 'warning'); return; }

  const btn = document.getElementById('btn-send-share');
  btn.disabled = true;
  btn.textContent = 'Sharing…';
  try {
    // Save to public /shared collection so the link is readable without auth
    const layers = state.layers.map(serializeLayer).filter(Boolean);
    const ref = await firebase.firestore().collection('shared').add({
      name,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      layersJson: JSON.stringify(layers),
    });

    const shareUrl = `${window.location.origin}${window.location.pathname}?share=${ref.id}`;

    // Show the link immediately so user can copy it even if email fails
    document.getElementById('share-link-input').value = shareUrl;
    document.getElementById('share-link-row').hidden = false;

    // Send the email via the server
    const resp = await fetch('/api/send-share-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: email, shareUrl, shareName: name }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error ?? 'Email send failed');

    toast(`Map shared with ${email}`, 'success');
    document.getElementById('share-email-input').value = '';
  } catch (err) {
    toast(`Share failed: ${err.message}`, 'error', 6000);
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Share';
  }
});

// Load a shared map from ?share=<id> on page load (after Firebase is ready)
async function maybeLoadSharedMap() {
  const shareId = new URLSearchParams(window.location.search).get('share');
  if (!shareId) return;
  try {
    const doc = await firebase.firestore().collection('shared').doc(shareId).get();
    if (!doc.exists) { toast('Shared map not found', 'error'); return; }
    const data = doc.data();
    const layers = data.layersJson ? JSON.parse(data.layersJson) : [];
    const counts = restoreLayerArray(layers);
    const total  = Object.values(counts).reduce((s, n) => s + n, 0);
    if (total) {
      toast(`Loaded shared map "${data.name}": ${describeLayerCounts(counts)}`, 'success', 6000);
      fitAll();
    }
    // Remove share param from URL so refresh doesn't reload the shared map
    history.replaceState(null, '', window.location.pathname);
  } catch (err) {
    console.error('[shared map]', err);
  }
}

// Initial paint of the property header, then kick off Firebase init
renderPropertyHeader();
initFirebase();

