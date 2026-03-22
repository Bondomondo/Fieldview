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
  layers: [],     // { id, name, type, color, visible, leafletLayer, featureCount,
                  //   wfsConfig?: { baseUrl, typeName } }
  capsLayers: [], // from WFS GetCapabilities
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
  document.getElementById('loading-overlay').hidden = false;
}
function hideLoading() {
  document.getElementById('loading-overlay').hidden = true;
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
      <div class="layer-item-color" style="background:${l.color}"></div>
      <div class="layer-item-info">
        <div class="layer-item-name" title="${l.name}">${l.name}</div>
        <div class="layer-item-meta">${l.featureCount} features · ${l.type}${l.wfsConfig ? ' · live' : ''}</div>
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
document.getElementById('close-feature-info').addEventListener('click', () => {
  document.getElementById('feature-info').hidden = true;
});

function showFeatureInfo(props, layerName) {
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
  document.getElementById('feature-info').hidden = false;
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
      layer.on('click', () => showFeatureInfo(feature.properties, layerName));
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
  try {
    const geojson = await parseKmzFile(file);
    const count = geojson.features?.length ?? 0;
    if (!count) { toast(`No features found in ${file.name}`, 'warning'); return; }

    const color = nextColor();
    const name  = file.name.replace(/\.(kmz|kml)$/i, '');
    const leafletLayer = buildGeoJsonLayer(geojson, color, name);
    addLayer({ name, type: 'KMZ/KML', color, leafletLayer, featureCount: count });

    try { map.fitBounds(leafletLayer.getBounds(), { padding: [40, 40] }); } catch {}
    addUploadedFileBadge(name, color, count);
    toast(`Loaded "${name}" — ${count} features`, 'success');
  } catch (err) {
    toast(`Error reading file: ${err.message}`, 'error', 5000);
    console.error(err);
  } finally {
    hideLoading();
  }
}

function addUploadedFileBadge(name, color, count) {
  const el = document.createElement('div');
  el.className = 'uploaded-file-item';
  el.innerHTML = `
    <div class="file-dot" style="background:${color}"></div>
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
  if (!rawUrl) { setStatus('caps-status', 'Please enter a WFS URL', 'error'); return; }

  setStatus('caps-status', 'Fetching capabilities…', 'loading');
  document.getElementById('layer-selector-wrap').hidden = true;
  showLoading('Fetching WFS capabilities…');

  const capsUrl = buildCapsUrl(rawUrl);

  try {
    const resp = await fetchWithTimeout(proxied(capsUrl));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    parseCapsXml(await resp.text(), rawUrl);
  } catch (err) {
    setStatus('caps-status', `Failed to load capabilities: ${err.message}`, 'error');
    toast('WFS capabilities failed — check the URL', 'error', 6000);
    console.error(err);
  } finally {
    hideLoading();
  }
}

function buildCapsUrl(base) {
  const url = new URL(base.startsWith('http') ? base : 'https://' + base);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('request', 'GetCapabilities');
  return url.toString();
}

function parseCapsXml(xmlText, baseUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    setStatus('caps-status', 'Server returned invalid XML', 'error');
    return;
  }

  // querySelectorAll ignores namespace prefixes; use local-name matching via XPath-style
  // fallback so we handle both wfs:FeatureType and plain FeatureType.
  let featureTypes = Array.from(doc.querySelectorAll('FeatureType'));
  if (!featureTypes.length) {
    // Try namespace-aware lookup
    featureTypes = Array.from(doc.getElementsByTagNameNS('*', 'FeatureType'));
  }
  if (!featureTypes.length) {
    setStatus('caps-status', 'No layers found in this WFS service', 'error');
    return;
  }

  state.capsLayers = featureTypes.map(ft => {
    // getElementsByTagNameNS('*', tag) works regardless of prefix
    const getText = tag => ft.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim() ?? '';
    return {
      name:     getText('Name'),
      title:    getText('Title'),
      abstract: getText('Abstract'),
      baseUrl,
    };
  }).filter(l => l.name);

  const sel = document.getElementById('layer-select');
  sel.innerHTML = state.capsLayers.map(l =>
    `<option value="${escHtml(l.name)}">${escHtml(l.title || l.name)}</option>`
  ).join('');

  setStatus('caps-status', `Found ${state.capsLayers.length} layer(s)`, 'success');
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

// ── WFS GetFeature (viewport + scale gated) ───────────────────
document.getElementById('btn-add-layer').addEventListener('click', loadWfsLayer);

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

// ── Auto-load capabilities on startup ────────────────────────
(async () => {
  const urlInput = document.getElementById('wfs-url');
  if (urlInput.value.trim()) {
    await new Promise(r => setTimeout(r, 400));
    await loadCapabilities();
  }
})();
