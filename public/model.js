/* ═══════════════════════════════════════════════════════════
   FieldView – Property digital-twin domain model  |  model.js
   ═══════════════════════════════════════════════════════════

   A Property is the top-level container of a holding. It groups the
   live map layers into three "kinds":

     • field        – parcels / boundaries the owner manages
                      (uploaded KMZ/KML/shapefile + hand-drawn labels)
     • forestStand  – forest compartments imported from a shapefile
                      + Forestand (SS 637009) XML, joined on stand no.
     • data         – contextual WFS/WMS reference layers

   The live Leaflet registry (state.layers) stays the source of truth;
   forest-stand attributes are carried inside each GeoJSON feature's
   `properties`, so everything round-trips through the existing
   feature-embedding serialization for free.
   ─────────────────────────────────────────────────────────── */

export const FOREST_TYPE = 'Forest';

/** Create an empty Property with metadata only. */
export function createProperty(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: `prop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'My Property',
    propertyId: null,   // e.g. "UGGLEBOL 1:1"
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Classify a layer `type` into a digital-twin kind. */
export function layerKind(type) {
  if (type === 'WFS' || type === 'WMS') return 'data';
  if (type === FOREST_TYPE) return 'forestStand';
  return 'field';   // Label, KMZ/KML
}
