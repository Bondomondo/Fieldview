/**
 * FieldView API – data shaping
 *
 * Pure helpers that turn a stored workspace (an array of serialized layers,
 * exactly what the app saves to Firestore as `layersJson`) into clean
 * "who farms what" output: labels (e.g. tenants / brukare) with the total
 * area assigned to each, plus the individual fields.
 *
 * Kept free of Firebase so it can be unit-tested directly.
 */

const area = require('@turf/area').default || require('@turf/area');

function featureAreaHa(feature) {
  try {
    if (!feature.geometry || !/Polygon/.test(feature.geometry.type)) return 0;
    return area(feature) / 10_000;
  } catch {
    return 0;
  }
}

/** Parse a stored workspace document into an array of layers. */
function parseLayers(workspaceData) {
  if (!workspaceData) return [];
  if (typeof workspaceData.layersJson === 'string') {
    try { return JSON.parse(workspaceData.layersJson); } catch { return []; }
  }
  if (Array.isArray(workspaceData.layers)) return workspaceData.layers;
  return [];
}

function round2(n) { return Math.round(n * 100) / 100; }

/** Pick a human-readable field identifier from its properties. */
function fieldName(props) {
  return props.name ?? props.etikett ?? props.beteckning ?? props.block ?? null;
}
function fieldId(props) {
  return props.id ?? props.objektidentitet ?? props.objektid ?? null;
}

/**
 * Who-farms-what as structured JSON.
 * @returns {{ labels, totalAreaHa, totalFields }}
 */
function extractLabels(layers) {
  const labelLayers = (layers || []).filter(l => l && l.type === 'Label');

  const labels = labelLayers.map(l => {
    const fields = (l.features || [])
      .filter(f => f && f.geometry)
      .map(f => {
        const props = f.properties || {};
        return {
          id: fieldId(props),
          name: fieldName(props),
          areaHa: round2(featureAreaHa(f)),
          properties: props,
        };
      });
    const areaHa = round2(fields.reduce((s, f) => s + f.areaHa, 0));
    return { label: l.name, color: l.color || null, fieldCount: fields.length, areaHa, fields };
  }).sort((a, b) => b.areaHa - a.areaHa);

  return {
    labels,
    totalAreaHa: round2(labels.reduce((s, l) => s + l.areaHa, 0)),
    totalFields: labels.reduce((s, l) => s + l.fieldCount, 0),
  };
}

/**
 * Who-farms-what as a GeoJSON FeatureCollection — one feature per field,
 * tagged with its label (brukare), label colour and area.
 */
function toGeoJSON(layers) {
  const features = [];
  for (const l of (layers || []).filter(x => x && x.type === 'Label')) {
    for (const f of (l.features || [])) {
      if (!f || !f.geometry) continue;
      features.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          label: l.name,
          labelColor: l.color || null,
          areaHa: round2(featureAreaHa(f)),
          ...(f.properties || {}),
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

module.exports = { parseLayers, extractLabels, toGeoJSON, featureAreaHa };
