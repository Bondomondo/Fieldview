/* ═══════════════════════════════════════════════════════════
   FieldView – Farm Field Mapper  |  app.js
   ═══════════════════════════════════════════════════════════ */

// ── Layer colour palette ─────────────────────────────────────
const PALETTE = [
  '#4caf71', '#4a8fe8', '#e87b4a', '#c44ae8',
  '#e8e44a', '#4ae8d8', '#e84a7b', '#8ae84a',
];
let paletteIdx = 0;
function nextColor() { return PALETTE[paletteIdx++ % PALETTE.length]; }

// ── State ────────────────────────────────────────────────────
const state = {
  layers: [],   // { id, name, type, color, visible, leafletLayer, featureCount }
  capsLayers: [],  // from WFS GetCapabilities
};

// ── Map setup ────────────────────────────────────────────────
const map = L.map('map', {
  center: [62.0, 15.0],   // Sweden
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

// ── Basemap switcher ─────────────────────────────────────────
document.querySelectorAll('.basemap-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.basemap;
    Object.values(basemaps).forEach(l => map.removeLayer(l));
    basemaps[name].addTo(map);
    map.eachLayer(l => { if (l !== basemaps[name]) { /* keep others */ } });
    // re-add user layers on top
    state.layers.forEach(l => { if (l.visible) { l.leafletLayer.addTo(map); } });
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

// ── Helpers: Loading overlay ─────────────────────────────────
function showLoading(text = 'Loading…') {
  const el = document.getElementById('loading-overlay');
  document.getElementById('loading-text').textContent = text;
  el.hidden = false;
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
function addLayer({ name, type, color, leafletLayer, featureCount }) {
  const id = `layer-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const entry = { id, name, type, color, visible: true, leafletLayer, featureCount };
  state.layers.push(entry);
  leafletLayer.addTo(map);
  renderLayerList();
  updateLayerCount();
  return entry;
}

function removeLayer(id) {
  const idx = state.layers.findIndex(l => l.id === id);
  if (idx === -1) return;
  const entry = state.layers[idx];
  map.removeLayer(entry.leafletLayer);
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
    try {
      map.fitBounds(entry.leafletLayer.getBounds(), { padding: [40, 40] });
    } catch { toast('Cannot zoom to empty layer', 'warning'); }
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
        <div class="layer-item-meta">${l.featureCount} features · ${l.type}</div>
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
  const panel = document.getElementById('feature-info');
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
  panel.hidden = false;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
      radius: 6,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.8,
    }),
    onEachFeature: (feature, layer) => {
      layer.on('click', () => {
        showFeatureInfo(feature.properties, layerName);
      });
      layer.on('mouseover', function() {
        if (feature.geometry?.type !== 'Point') {
          this.setStyle({ fillOpacity: 0.5, weight: 3 });
        }
      });
      layer.on('mouseout', function() {
        if (feature.geometry?.type !== 'Point') {
          this.setStyle({ fillOpacity: 0.25, weight: 2 });
        }
      });
    },
  });
}

// ── KMZ / KML parsing ───────────────────────────────────────
async function parseKmzFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'kml') {
    const text = await file.text();
    return kmlTextToGeojson(text, file.name);
  }

  if (ext === 'kmz') {
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    // Find the root KML file
    const kmlFile = Object.values(zip.files).find(f =>
      f.name.endsWith('.kml') && !f.dir
    );
    if (!kmlFile) throw new Error('No KML file found inside KMZ');
    const text = await kmlFile.async('text');
    return kmlTextToGeojson(text, file.name);
  }

  throw new Error('Unsupported file type: .' + ext);
}

function kmlTextToGeojson(kmlText, fileName) {
  const parser = new DOMParser();
  const kmlDoc = parser.parseFromString(kmlText, 'application/xml');
  const parseErr = kmlDoc.querySelector('parsererror');
  if (parseErr) throw new Error('Invalid KML/XML: ' + parseErr.textContent.slice(0, 120));

  const geojson = toGeoJSON.kml(kmlDoc);
  if (!geojson || !geojson.features) throw new Error('Could not convert KML to GeoJSON');
  return geojson;
}

// ── Drop zone ────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f =>
    f.name.endsWith('.kmz') || f.name.endsWith('.kml')
  );
  if (files.length === 0) { toast('Please drop a .kmz or .kml file', 'warning'); return; }
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
    if (count === 0) {
      hideLoading();
      toast(`No features found in ${file.name}`, 'warning');
      return;
    }
    const color = nextColor();
    const displayName = file.name.replace(/\.(kmz|kml)$/i, '');
    const leafletLayer = buildGeoJsonLayer(geojson, color, displayName);
    addLayer({ name: displayName, type: 'KMZ/KML', color, leafletLayer, featureCount: count });

    // Zoom to layer
    try { map.fitBounds(leafletLayer.getBounds(), { padding: [40, 40] }); } catch {}

    // Add badge in drop zone
    addUploadedFileBadge(displayName, color, count);
    toast(`Loaded "${displayName}" — ${count} features`, 'success');
  } catch (err) {
    toast(`Error reading file: ${err.message}`, 'error', 5000);
    console.error(err);
  } finally {
    hideLoading();
  }
}

function addUploadedFileBadge(name, color, count) {
  const container = document.getElementById('uploaded-files');
  const el = document.createElement('div');
  el.className = 'uploaded-file-item';
  el.innerHTML = `
    <div class="file-dot" style="background:${color}"></div>
    <span class="file-name" title="${escHtml(name)}">${escHtml(name)}</span>
    <span class="file-count">${count} ft</span>
  `;
  container.appendChild(el);
}

// ── WFS GetCapabilities ──────────────────────────────────────
document.getElementById('btn-load-caps').addEventListener('click', loadCapabilities);
document.getElementById('wfs-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadCapabilities();
});

async function loadCapabilities() {
  const rawUrl = document.getElementById('wfs-url').value.trim();
  if (!rawUrl) { setStatus('caps-status', 'Please enter a WFS URL', 'error'); return; }

  const capsUrl = buildCapsUrl(rawUrl);
  setStatus('caps-status', 'Fetching capabilities…', 'loading');
  document.getElementById('layer-selector-wrap').hidden = true;
  showLoading('Fetching WFS capabilities…');

  try {
    const resp = await fetch(capsUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const text = await resp.text();
    parseCapsXml(text, rawUrl);
  } catch (err) {
    setStatus('caps-status', `Failed to load capabilities: ${err.message}`, 'error');
    toast('WFS capabilities failed — check URL or CORS', 'error', 6000);
    console.error(err);
  } finally {
    hideLoading();
  }
}

function buildCapsUrl(base) {
  const url = new URL(base.includes('://') ? base : 'https://' + base);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('request', 'GetCapabilities');
  return url.toString();
}

function parseCapsXml(xmlText, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  // Handle XML parse errors
  if (doc.querySelector('parsererror')) {
    // Maybe it's JSON-wrapped? Try JSON
    try {
      const json = JSON.parse(xmlText);
      if (json.code) throw new Error(json.message || json.code);
    } catch {}
    setStatus('caps-status', 'Server returned invalid XML', 'error');
    return;
  }

  // WFS 2.0 uses FeatureType; WFS 1.x uses FeatureType too
  const ns = { wfs: 'http://www.opengis.net/wfs/2.0', wfs1: 'http://www.opengis.net/wfs' };
  let featureTypes = Array.from(doc.querySelectorAll('FeatureType'));

  if (featureTypes.length === 0) {
    setStatus('caps-status', 'No layers found in this WFS service', 'error');
    return;
  }

  state.capsLayers = featureTypes.map(ft => {
    const getName   = sel => ft.querySelector(sel)?.textContent?.trim() ?? '';
    const name      = getName('Name') || getName('name');
    const title     = getName('Title') || getName('title');
    const abstract  = getName('Abstract') || getName('abstract');
    return { name, title, abstract, baseUrl };
  }).filter(l => l.name);

  // Populate select
  const sel = document.getElementById('layer-select');
  sel.innerHTML = state.capsLayers.map(l =>
    `<option value="${escHtml(l.name)}">${escHtml(l.title || l.name)}</option>`
  ).join('');

  setStatus('caps-status', `Found ${state.capsLayers.length} layer(s)`, 'success');
  document.getElementById('layer-selector-wrap').hidden = false;
  updateLayerDescription();
}

// Update description when selection changes
document.getElementById('layer-select').addEventListener('change', updateLayerDescription);

function updateLayerDescription() {
  const sel  = document.getElementById('layer-select');
  const name = sel.value;
  const info = state.capsLayers.find(l => l.name === name);
  const desc = document.getElementById('layer-description');
  if (info?.abstract) {
    desc.textContent = info.abstract;
    desc.hidden = false;
  } else {
    desc.hidden = true;
  }
}

// ── WFS GetFeature ───────────────────────────────────────────
document.getElementById('btn-add-layer').addEventListener('click', loadWfsLayer);

async function loadWfsLayer() {
  const sel       = document.getElementById('layer-select');
  const typeName  = sel.value;
  const rawUrl    = document.getElementById('wfs-url').value.trim();
  const limit     = parseInt(document.getElementById('feature-limit').value, 10) || 2000;
  if (!typeName) { toast('Select a layer first', 'warning'); return; }

  const info = state.capsLayers.find(l => l.name === typeName);
  const displayName = (info?.title || typeName).replace(/^[^:]+:/, '');

  showLoading(`Loading "${displayName}"…`);
  setStatus('caps-status', `Fetching "${displayName}"…`, 'loading');

  const url = buildFeatureUrl(rawUrl, typeName, limit);

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

    const contentType = resp.headers.get('content-type') || '';
    let geojson;

    if (contentType.includes('json')) {
      geojson = await resp.json();
    } else {
      // GML/XML response — try to parse as GML
      const text = await resp.text();
      geojson = gmlToGeojson(text, typeName);
    }

    if (!geojson || !geojson.features) throw new Error('Unexpected response format');

    const count = geojson.features.length;
    if (count === 0) {
      setStatus('caps-status', `Layer "${displayName}" returned 0 features`, 'info');
      toast(`No features returned for "${displayName}"`, 'warning');
      hideLoading();
      return;
    }

    const color = nextColor();
    const leafletLayer = buildGeoJsonLayer(geojson, color, displayName);
    addLayer({ name: displayName, type: 'WFS', color, leafletLayer, featureCount: count });
    try { map.fitBounds(leafletLayer.getBounds(), { padding: [40, 40] }); } catch {}

    setStatus('caps-status', `Loaded "${displayName}" — ${count} features`, 'success');
    toast(`Loaded "${displayName}" — ${count} features`, 'success');
  } catch (err) {
    setStatus('caps-status', `Error loading layer: ${err.message}`, 'error');
    toast(`Failed to load layer: ${err.message}`, 'error', 6000);
    console.error(err);
  } finally {
    hideLoading();
  }
}

function buildFeatureUrl(base, typeName, count) {
  const url = new URL(base.includes('://') ? base : 'https://' + base);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('request', 'GetFeature');
  url.searchParams.set('typeName', typeName);
  url.searchParams.set('outputFormat', 'application/json');
  url.searchParams.set('count', String(count));
  url.searchParams.set('maxFeatures', String(count));  // WFS 1.x compat
  return url.toString();
}

// ── GML → GeoJSON fallback ────────────────────────────────────
// Minimal WFS 2.0 GML3 feature extraction when server doesn't return JSON
function gmlToGeojson(xmlText, typeName) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('ExceptionReport, ows\\:ExceptionReport')) {
    const msg = doc.querySelector('ExceptionText, ows\\:ExceptionText')?.textContent;
    throw new Error(msg || 'WFS exception');
  }

  const features = [];
  const localName = typeName.split(':').pop();

  // Try to find member elements
  const members = doc.querySelectorAll(`member > *, featureMember > *, featureMembers > *`);
  members.forEach(member => {
    const props = {};
    const geom  = extractGmlGeometry(member);

    Array.from(member.children).forEach(child => {
      const tag = child.localName;
      if (['boundedBy','location'].includes(tag)) return;
      const text = child.textContent?.trim();
      if (text && !child.children.length) props[tag] = text;
    });

    if (geom) {
      features.push({ type: 'Feature', geometry: geom, properties: props });
    }
  });

  return { type: 'FeatureCollection', features };
}

function extractGmlGeometry(elem) {
  // Look for polygon / point / linestring in GML namespace
  const poly    = elem.querySelector('*|Polygon, *|MultiPolygon');
  const point   = elem.querySelector('*|Point');
  const line    = elem.querySelector('*|LineString, *|MultiLineString, *|MultiCurve');

  if (poly)  return gmlPolygonToGeojson(poly);
  if (line)  return gmlLineToGeojson(line);
  if (point) return gmlPointToGeojson(point);
  return null;
}

function parsePosList(el) {
  const posList = el.querySelector('*|posList, *|coordinates');
  if (!posList) return [];
  const raw = posList.textContent.trim();
  // GML posList: x y x y … or lon lat lon lat
  const nums = raw.split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
  const coords = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    // GML uses lon,lat (x,y) — WGS84
    coords.push([nums[i], nums[i+1]]);
  }
  // Swap if likely lat,lon (values outside ±90 in first position = lon)
  if (coords.length && Math.abs(coords[0][0]) > 90) return coords.map(c => [c[1], c[0]]);
  return coords;
}

function gmlPolygonToGeojson(el) {
  const rings = Array.from(el.querySelectorAll('*|LinearRing, *|Ring > *|Curve'));
  if (rings.length === 0) {
    // Try exterior/interior approach
    const ext = el.querySelector('*|exterior');
    const ints = Array.from(el.querySelectorAll('*|interior'));
    const outer = ext ? parsePosList(ext) : [];
    const holes  = ints.map(i => parsePosList(i));
    if (outer.length < 3) return null;
    return { type: 'Polygon', coordinates: [outer, ...holes] };
  }
  const outer = parsePosList(rings[0]);
  const holes = rings.slice(1).map(r => parsePosList(r));
  if (outer.length < 3) return null;
  return { type: 'Polygon', coordinates: [outer, ...holes] };
}

function gmlLineToGeojson(el) {
  const coords = parsePosList(el);
  if (coords.length < 2) return null;
  return { type: 'LineString', coordinates: coords };
}

function gmlPointToGeojson(el) {
  const pos = el.querySelector('*|pos, *|coordinates');
  if (!pos) return null;
  const nums = pos.textContent.trim().split(/[\s,]+/).map(Number);
  if (nums.length < 2) return null;
  const [x, y] = nums;
  // Swap if lat,lon
  if (Math.abs(x) > 90) return { type: 'Point', coordinates: [y, x] };
  return { type: 'Point', coordinates: [x, y] };
}

// ── Pre-populate with the Jordbruksverket WFS ─────────────────
// Auto-load capabilities if URL is pre-filled
(async () => {
  const urlInput = document.getElementById('wfs-url');
  if (urlInput.value.trim()) {
    // small delay so UI renders first
    await new Promise(r => setTimeout(r, 400));
    await loadCapabilities();
  }
})();
