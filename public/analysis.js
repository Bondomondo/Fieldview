/* ═══════════════════════════════════════════════════════════
   FieldView – Forest analysis  |  analysis.js
   ═══════════════════════════════════════════════════════════

   Pure aggregation of forest-stand features into cross-tabulations:
   pick a DIMENSION (species, age class, cutting class, goal class,
   site index, parcel) and a MEASURE (area / volume / stand count),
   optionally filtered to one parcel (skifte). Rendering lives in
   app.js; this module stays DOM-free so it can be unit-tested.
   ─────────────────────────────────────────────────────────── */

import { speciesName, cuttingClassColor } from './forest-import.js';

export const DIMENSIONS = [
  { key: 'species',         label: 'Trädslag' },
  { key: 'ageClass',        label: 'Åldersklass' },
  { key: 'cuttingClass',    label: 'Huggningsklass' },
  { key: 'managementClass', label: 'Målklass' },
  { key: 'siteIndex',       label: 'Ståndortsindex' },
  { key: 'skifte',          label: 'Skifte' },
];

export const MEASURES = [
  { key: 'area',   label: 'Areal (ha)',      unit: 'ha' },
  { key: 'volume', label: 'Volym (m³sk)',    unit: 'm³sk' },
  { key: 'count',  label: 'Antal bestånd',   unit: 'st' },
];

const UNKNOWN = 'Okänt';

// Cutting-class (huggningsklass) numeric codes → Swedish labels.
const HKL_LABELS = {
  1: 'Kalmark', 2: 'Plantskog', 3: 'Ungskog',
  4: 'Gallringsskog', 5: 'Gallringsskog (äldre)',
  6: 'Föryngringsavv.skog', 7: 'Föryngringsavv. (äldre)',
  8: 'Skog, äldre', 9: 'Överårig skog',
};
// Goal class (målklass) codes → labels.
const MGMT_LABELS = {
  PG: 'PG – Produktion',
  PF: 'PF – Prod. m. förstärkt hänsyn',
  NS: 'NS – Naturvård, skötsel',
  NO: 'NO – Naturvård, orört',
  K:  'K – Kombinerad',
};

// Fixed colours for the common species; others fall back to a palette.
const SPECIES_COLORS = {
  Tall: '#c99a3b', Gran: '#2f8f49', Björk: '#8ec63f',
  Asp: '#c8823b', Ek: '#7a5230', Bok: '#9c6b3f',
  Contorta: '#3f8f7a', Lärk: '#b0532f',
  Triviallöv: '#a7c957', Ädellöv: '#6a994e',
};
const PALETTE = [
  '#4a8fe8', '#e8a94a', '#c44ae8', '#4ae8d8',
  '#e84a7b', '#8ae84a', '#e8e44a', '#4caf71',
];
function paletteColor(i) { return PALETTE[i % PALETTE.length]; }

const AGE_ORDER = ['0–20', '21–40', '41–60', '61–80', '81–100', '100+', UNKNOWN];
function ageBucket(age) {
  if (age == null) return UNKNOWN;
  if (age <= 20) return '0–20';
  if (age <= 40) return '21–40';
  if (age <= 60) return '41–60';
  if (age <= 80) return '61–80';
  if (age <= 100) return '81–100';
  return '100+';
}

/** Distinct parcels (skiften) present, for the filter dropdown. */
export function listSkiften(features) {
  return [...new Set(features.map(f => f.properties?.skifte).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), 'sv', { numeric: true }));
}

function measureValue(p, measure) {
  if (measure === 'area')   return p.areaHa || 0;
  if (measure === 'volume') return p.totalVolumeM3sk || 0;
  return 1; // count
}

/**
 * Aggregate forest features.
 * @returns {{ rows, total, standCount, areaHa, volumeM3sk, measure, dimension }}
 *   rows: [{ key, label, color, value, pct, standNos:string[] }] sorted for display
 */
export function analyze(features, dimension, measure, skifte = null) {
  const feats = (features || []).filter(f => !skifte || f.properties?.skifte === skifte);
  const groups = new Map(); // key -> { label, color, value, stands:Set }

  let standCount = 0, areaHa = 0, volumeM3sk = 0;

  const add = (key, label, color, value, standNo) => {
    if (!value) return;
    let g = groups.get(key);
    if (!g) { g = { key, label, color, value: 0, stands: new Set() }; groups.set(key, g); }
    g.value += value;
    if (standNo) g.stands.add(standNo);
  };

  feats.forEach((f, i) => {
    const p = f.properties || {};
    standCount += 1;
    areaHa += p.areaHa || 0;
    volumeM3sk += p.totalVolumeM3sk || 0;
    const m = measureValue(p, measure);
    const standNo = p.standNo;

    if (dimension === 'species') {
      const species = p.species || [];
      if (measure === 'count') {
        // Count each stand once, under its dominant species.
        const dom = species[0];
        const name = dom ? dom.name : UNKNOWN;
        add(name, name, speciesColorFor(name), 1, standNo);
      } else if (species.length) {
        // Distribute area / volume across the stand's species mix.
        for (const s of species) add(s.name, s.name, speciesColorFor(s.name), m * (s.pct / 100), standNo);
      } else {
        add(UNKNOWN, UNKNOWN, '#6f9c7d', m, standNo);
      }
    } else if (dimension === 'ageClass') {
      const b = ageBucket(p.meanAgeYr);
      add(b, b, ageColor(b), m, standNo);
    } else if (dimension === 'cuttingClass') {
      const code = p.cuttingClass ?? UNKNOWN;
      const label = HKL_LABELS[code] ? `${code} – ${HKL_LABELS[code]}` : (code === UNKNOWN ? UNKNOWN : `HKL ${code}`);
      add(String(code), label, cuttingClassColor(p.cuttingClass), m, standNo);
    } else if (dimension === 'managementClass') {
      const code = p.managementClass || UNKNOWN;
      add(code, MGMT_LABELS[code] || code, paletteColor(mgmtIndex(code)), m, standNo);
    } else if (dimension === 'siteIndex') {
      const si = p.siteIndex && p.siteIndex !== '0' ? p.siteIndex : UNKNOWN;
      add(si, si, si === UNKNOWN ? '#6f9c7d' : paletteColor(i), m, standNo);
    } else { // skifte
      const key = p.skifte || UNKNOWN;
      add(key, `Skifte ${key}`, paletteColor(i), m, standNo);
    }
  });

  let rows = [...groups.values()].map(g => ({
    key: g.key, label: g.label, color: g.color,
    value: +g.value.toFixed(measure === 'count' ? 0 : 1),
    standNos: [...g.stands],
  }));

  // Ordering: age & cutting class by natural order, else by value desc.
  if (dimension === 'ageClass') {
    rows.sort((a, b) => AGE_ORDER.indexOf(a.key) - AGE_ORDER.indexOf(b.key));
  } else if (dimension === 'cuttingClass') {
    rows.sort((a, b) => (parseFloat(a.key) || 999) - (parseFloat(b.key) || 999));
  } else {
    rows.sort((a, b) => b.value - a.value);
  }

  const total = rows.reduce((s, r) => s + r.value, 0);
  rows.forEach(r => { r.pct = total ? Math.round((r.value / total) * 100) : 0; });

  return {
    rows, total, standCount,
    areaHa: +areaHa.toFixed(1),
    volumeM3sk: Math.round(volumeM3sk),
    measure, dimension,
  };
}

function speciesColorFor(name) {
  if (SPECIES_COLORS[name]) return SPECIES_COLORS[name];
  if (/^Löv/.test(name)) return '#a7c957';
  if (/^Barr/.test(name)) return '#2f8f49';
  return '#6f9c7d';
}
function ageColor(bucket) {
  const ramp = { '0–20': '#cfe0a8', '21–40': '#9ad07a', '41–60': '#4fa955',
                 '61–80': '#2f8f49', '81–100': '#1f7a3e', '100+': '#0e4a25', [UNKNOWN]: '#6f9c7d' };
  return ramp[bucket] || '#6f9c7d';
}
function mgmtIndex(code) {
  const order = ['PG', 'PF', 'NS', 'NO', 'K'];
  const i = order.indexOf(code);
  return i === -1 ? 5 : i;
}
