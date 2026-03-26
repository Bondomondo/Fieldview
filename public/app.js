/* ═══════════════════════════════════════════════════════════
   FieldView – Farm Field Mapper  |  app.js
   ═══════════════════════════════════════════════════════════ */

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
  layers: [],      // { id, name, type, color, visible, leafletLayer, featureCount,
                   //   wfsConfig?: { baseUrl, typeName }, wmsConfig?: { baseUrl, layerName } }
  capsLayers: [],  // from WFS/WMS GetCapabilities
  serviceType: 'WFS',
  currentUser: null,
  firebaseReady: false,
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
basemaps.osm.addTo(map);

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

function openReport() {
  const labels = state.layers.filter(l => l.type === 'Label');
  const body = document.getElementById('report-body');

  if (!labels.length) {
    body.innerHTML = '<p class="report-empty">No label layers yet. Click a feature and assign a label to get started.</p>';
    document.getElementById('report-backdrop').hidden = false;
    return;
  }

  body.innerHTML = labels.map(label => {
    const features = label.leafletLayer.toGeoJSON().features;
    // Collect all unique property keys across features
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

  document.getElementById('report-backdrop').hidden = false;
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
function addLayer({ name, type, color, leafletLayer, featureCount, wfsConfig }) {
  const id = `layer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = { id, name, type, color, visible: true, leafletLayer, featureCount, wfsConfig };
  state.layers.push(entry);
  leafletLayer.addTo(map);
  renderLayerList();
  updateLayerCount();
  return entry;
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

function renderLayerList() {
  const ul = document.getElementById('layer-list');
  if (state.layers.length === 0) {
    ul.innerHTML = '<li class="layer-list-empty">No layers loaded yet</li>';
    return;
  }
  ul.innerHTML = state.layers.map(l => `
    <li class="layer-item" data-id="${l.id}">
      ${layerSwatchHtml(l)}
      <div class="layer-item-info">
        <div class="layer-item-name" title="${l.name}">${l.name}</div>
        <div class="layer-item-meta">${l.featureCount != null ? l.featureCount + ' features · ' : ''}${l.type}${l.wfsConfig ? ' · live' : ''}</div>
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
    </li>
  `).join('');
}

function layerSwatchHtml(l) {
  if (l.type === 'KMZ/KML') {
    return `<svg width="20" height="12" viewBox="0 0 20 12" style="flex-shrink:0" aria-hidden="true">
      <line x1="1" y1="6" x2="19" y2="6" stroke="${l.color}" stroke-width="2.5" stroke-dasharray="4 3" stroke-linecap="round"/>
    </svg>`;
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
  populateLabelSelect();
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

// ── Drop zone ────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => /\.(kmz|kml)$/i.test(f.name));
  if (!files.length) { toast('Please drop a .kmz or .kml file', 'warning'); return; }
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
    geojson = await parseKmzFile(file);
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
  const name  = file.name.replace(/\.(kmz|kml)$/i, '');
  const leafletLayer = L.geoJSON(geojson, {
    style: () => ({
      color,
      weight: 2,
      opacity: 0.9,
      dashArray: '6 6',
      fillOpacity: 0,
    }),
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: 6, color, weight: 2, dashArray: '4 4', fillOpacity: 0,
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
  const saveable = state.layers.filter(l => l.type === 'Label' || l.type === 'KMZ/KML');
  if (!saveable.length) { toast('No label or KMZ/KML layers to save', 'warning'); return; }
  const data = saveable.map(l => ({
    type: l.type,
    name: l.name,
    color: l.color,
    features: l.leafletLayer.toGeoJSON().features,
  }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fieldview-labels-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  const labelCount = saveable.filter(l => l.type === 'Label').length;
  const kmzCount   = saveable.filter(l => l.type === 'KMZ/KML').length;
  const parts = [];
  if (labelCount) parts.push(`${labelCount} label layer${labelCount !== 1 ? 's' : ''}`);
  if (kmzCount)   parts.push(`${kmzCount} KMZ/KML layer${kmzCount !== 1 ? 's' : ''}`);
  toast(`Saved ${parts.join(' and ')}`, 'success');
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
  const counts = { label: 0, kmz: 0, wfs: 0, wms: 0 };
  for (const item of items) {
    if (!item.name || !item.color) continue;
    const type = item.type || 'Label';

    if (type === 'WFS' && item.wfsConfig) {
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
          style: () => ({ color, weight: 2, opacity: 0.9, dashArray: '6 6', fillOpacity: 0 }),
          pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 6, color, weight: 2, dashArray: '4 4', fillOpacity: 0 }),
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
  // Label / KMZ/KML — embed GeoJSON
  return { type: l.type, name: l.name, color: l.color, features: l.leafletLayer.toGeoJSON().features };
}

function describeLayerCounts({ label = 0, kmz = 0, wfs = 0, wms = 0 }) {
  const parts = [];
  if (label) parts.push(`${label} label layer${label !== 1 ? 's' : ''}`);
  if (kmz)   parts.push(`${kmz} KMZ/KML layer${kmz !== 1 ? 's' : ''}`);
  if (wfs)   parts.push(`${wfs} WFS layer${wfs !== 1 ? 's' : ''}`);
  if (wms)   parts.push(`${wms} WMS layer${wms !== 1 ? 's' : ''}`);
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
  } catch (e) {
    console.warn('[firebase] not configured:', e.message);
  }
}

function handleAuthChange(user) {
  state.currentUser = user;
  document.getElementById('btn-signin').hidden          = !!user;
  document.getElementById('user-chip').hidden           = !user;
  document.getElementById('btn-open-workspaces').hidden = !user;
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
}

function closeWorkspacesModal() {
  document.getElementById('workspaces-backdrop').hidden = true;
}

async function handleSaveWorkspace() {
  const name = document.getElementById('workspace-name-input').value.trim();
  if (!name) { toast('Enter a workspace name', 'warning'); return; }
  if (!state.currentUser) { toast('Sign in first', 'warning'); return; }
  if (!state.layers.length) { toast('No layers to save', 'warning'); return; }

  const btn = document.getElementById('btn-save-workspace');
  btn.disabled = true;
  try {
    await saveWorkspace(name);
    document.getElementById('workspace-name-input').value = '';
    toast(`Saved workspace "${name}"`, 'success');
    refreshWorkspaceList();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error', 6000);
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

async function saveWorkspace(name) {
  const layers = state.layers.map(serializeLayer).filter(Boolean);
  // Firestore doesn't support nested arrays (present in GeoJSON coordinates).
  // Store the whole payload as a JSON string to avoid this limitation.
  await firebase.firestore()
    .collection('users').doc(state.currentUser.uid)
    .collection('workspaces')
    .add({ name, savedAt: firebase.firestore.FieldValue.serverTimestamp(), layersJson: JSON.stringify(layers) });
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
    if (total) toast(`Loaded "${name}": ${describeLayerCounts(counts)}`, 'success');
    else toast('Workspace had no valid layers', 'warning');
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

// Kick off Firebase init
initFirebase();

