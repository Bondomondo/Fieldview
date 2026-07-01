/* ═══════════════════════════════════════════════════════════
   FieldView – Forest import  |  forest-import.js
   ═══════════════════════════════════════════════════════════

   Merges two sources describing the same forest:

     1. A shapefile  (.zip / .shp)  — polygon geometry + a `.dbf` with
        forestry attributes. Parsed elsewhere with shpjs, which already
        reprojects SWEREF99 TM → WGS84 via the `.prj`.
     2. A Forestand XML  (SS 637009 / skogforsk standard) — rich
        per-stand data: species mix, volume, site index, treatments.

   The two are joined on stand number: the shapefile's `AVDNR` column
   matches the XML `Place_Compartment` `placeId` (compared as strings,
   so sub-stands like "13.2" / "39:1" join correctly).
   ─────────────────────────────────────────────────────────── */

// Swedish tree-species names for the codes that appear in the data.
// Unknown codes degrade gracefully to the raw code (never dropped).
export const SPECIES_NAMES = {
  // SS 637009 volume-distribution codes (E1 = conifer, E2 = deciduous)
  E1_1_1: 'Tall',            // pine
  E1_2_1: 'Gran',            // spruce
  E1_3_1: 'Contorta',
  E2_10_1: 'Björk',          // birch
  E2_11_2: 'Asp',            // aspen
  E2_5_1:  'Ek',             // oak
  E2_1_1:  'Bok',            // beech
  // treeSpecies_ref href tails
  inhemskbjork: 'Björk',
  inhemsktriviallov: 'Triviallöv', inhemskttriviallov: 'Triviallöv',
  inhemskadellov: 'Ädellöv', inhemskek: 'Ek', inhemskbok: 'Bok',
  tall: 'Tall', gran: 'Gran', bjork: 'Björk',
  // single-letter site / maturity species codes
  T: 'Tall', G: 'Gran', B: 'Björk', C: 'Contorta',
  L: 'Lärk', E: 'Ek', A: 'Asp', O: 'Övrigt löv',
};

export function speciesName(code) {
  if (!code) return 'Okänt';
  if (SPECIES_NAMES[code]) return SPECIES_NAMES[code];
  // E2_* codes we don't recognise are still deciduous ("löv")
  if (/^E2_/.test(code)) return `Löv (${code})`;
  if (/^E1_/.test(code)) return `Barr (${code})`;
  return code;
}

// ── XML helpers ──────────────────────────────────────────────
function nsTags(el, tag) {
  return Array.from(el.getElementsByTagNameNS('*', tag));
}
function firstTagText(el, tag) {
  const found = nsTags(el, tag)[0];
  return found ? found.textContent.trim() : '';
}
// Element (nodeType 1) children — portable across DOM implementations.
function elementChildren(el) {
  return Array.from(el.childNodes).filter(n => n.nodeType === 1);
}
function directChild(el, tag) {
  return elementChildren(el).find(c => c.localName === tag) || null;
}
function directChildText(el, tag) {
  const c = directChild(el, tag);
  return c ? c.textContent.trim() : '';
}
function num(str) {
  if (str === '' || str == null) return null;
  const n = Number(String(str).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
// Clean a raw dbf value to a trimmed string or null (blank numeric dbf
// fields decode to NaN, which `?? ''` would not catch).
function str(v) {
  if (v == null || (typeof v === 'number' && Number.isNaN(v))) return null;
  const s = String(v).trim();
  return s && s !== 'NaN' ? s : null;
}

/**
 * Parse a Forestand XML document.
 * @returns {{ standMap: Map<string, object>, propertyName: string|null, propertyId: string|null }}
 */
export function parseForestandXml(xmlText) {
  // Strip a leading UTF-8 BOM / whitespace before the XML declaration.
  const clean = String(xmlText).replace(/^﻿/, '').replace(/^\s+(?=<\?xml)/, '');
  const doc = new DOMParser().parseFromString(clean, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid Forestand XML');

  // Property metadata (first Place_Plan placeName)
  const planName = firstTagText(doc.documentElement, 'placeName') || null;

  const standMap = new Map();
  for (const comp of nsTags(doc.documentElement, 'Place_Compartment')) {
    const standNo = directChildText(comp, 'placeId');
    if (!standNo) continue;

    // Direct-child area of the compartment = productive area (ha)
    const areaEl = directChild(comp, 'area');
    const productiveAreaHa = areaEl ? num(areaEl.textContent) : null;

    // Production tree layer (prefer "produktionsskikt", else first population)
    const populations = nsTags(comp, 'Object_Population');
    const pop = populations.find(p => /produktionsskikt/i.test(firstTagText(p, 'treeLayer')))
      || populations[0] || null;

    const attrs = {
      standNo,
      productiveAreaHa,
      meanAgeYr:          null,
      dominantHeightM:    null,
      stemsPerHa:         null,
      basalAreaM2Ha:      null,
      volumeM3PerHa:      null,
      weightedDiameterCm: null,
      managementClass:    '',
      maturityClass:      '',
      siteIndex:          '',
      soilMoisture:       '',
      species:            [],
      treatments:         [],
    };

    if (pop) {
      attrs.meanAgeYr          = num(obsResult(pop, 'ObsP_MeanAge'));
      const domHeightDm        = num(obsResult(pop, 'ObsP_DominantHeight'));
      attrs.dominantHeightM    = domHeightDm != null ? +(domHeightDm / 10).toFixed(1) : null;
      attrs.stemsPerHa         = num(obsResult(pop, 'ObsP_AreaStemNumber'));
      attrs.basalAreaM2Ha      = num(obsResult(pop, 'ObsP_StandBasalArea'));
      attrs.volumeM3PerHa      = num(obsResult(pop, 'ObsP_AreaStandVolume'));
      attrs.weightedDiameterCm = num(obsResult(pop, 'ObsP_WeightedDiameter'));
      attrs.species            = parseSpecies(pop);
    }

    const site = nsTags(comp, 'Object_Site')[0];
    if (site) {
      attrs.managementClass = firstTagText(site, 'class') || firstTagText(nsTags(site, 'ObsS_ManagementClass')[0] || site, 'result');
      attrs.maturityClass   = obsResult(site, 'ObsS_MaturityClass');
      attrs.soilMoisture    = obsResult(site, 'ObsS_SoilMoisture');
      attrs.siteIndex       = parseSiteIndex(site);
    }

    attrs.treatments = parseTreatments(comp);
    standMap.set(standNo, attrs);
  }

  return { standMap, propertyName: planName, propertyId: planName };
}

function obsResult(scope, obsTag) {
  const obs = nsTags(scope, obsTag)[0];
  return obs ? firstTagText(obs, 'result') : '';
}

function parseSpecies(pop) {
  const dist = nsTags(pop, 'ObsP_SpeciesDistributionVolume')[0];
  if (!dist) return [];
  const out = [];
  for (const amt of nsTags(dist, 'SpeciesAmount')) {
    let code = firstTagText(amt, 'species');
    if (!code) {
      const ref = nsTags(amt, 'treeSpecies_ref')[0];
      const href = ref?.getAttribute('n2:href') || ref?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || ref?.getAttribute('href') || '';
      code = href.split('/').pop() || '';
    }
    const amount = num(firstTagText(amt, 'amount'));
    if (code && amount != null) {
      out.push({ code, name: speciesName(code), pct: +(amount * 100).toFixed(1) });
    }
  }
  return out.sort((a, b) => b.pct - a.pct);
}

function parseSiteIndex(site) {
  const sis = nsTags(site, 'ObsS_SIS')[0];
  if (!sis) return '';
  const age     = firstTagText(sis, 'age');       // e.g. H100
  const species = firstTagText(sis, 'species');   // e.g. G
  const value   = obsResult(site, 'ObsS_SIS');    // e.g. 34
  if (!value) return '';
  return `${species || ''}${value}${age ? ` (${age})` : ''}`.trim();
}

function parseTreatments(comp) {
  const out = [];
  for (const occ of nsTags(comp, 'Occasion')) {
    const status = firstTagText(occ, 'status');
    const date   = firstTagText(occ, 'date');
    const span   = firstTagText(occ, 'span');
    // Treatment type = local name of the Activity_* element, if present
    let type = '';
    const activity = nsTags(occ, 'activity')[0];
    if (activity) {
      const actEl = elementChildren(activity).find(c => /^Activity_/.test(c.localName));
      if (actEl) type = actEl.localName.replace(/^Activity_/, '').replace(/_/g, ' ');
    }
    if (status || date) out.push({ status, date, span, type });
  }
  return out;
}

/**
 * Join shapefile GeoJSON with parsed XML stand attributes.
 * Mutates each feature's `properties` to a clean, structured stand record.
 * @returns {{ features: object[], propertyName, propertyId,
 *             matched:number, unmatched:{noAttrs:string[], noGeom:string[]},
 *             summary:{ standCount, areaHa, volumeM3sk } }}
 */
export function joinForest(geojson, xmlResult, turf) {
  const standMap    = xmlResult?.standMap || new Map();
  const seenStandNo = new Set();
  const features    = [];
  const noAttrs     = [];
  let totalAreaHa = 0, totalVolume = 0;

  for (const f of (geojson.features || [])) {
    const raw = f.properties || {};
    const standNo = str(raw.AVDNR ?? raw.avdnr ?? raw.Avdnr) || '';
    const attrs = standNo ? standMap.get(standNo) : null;
    if (standNo) seenStandNo.add(standNo);
    if (standNo && !attrs) noAttrs.push(standNo);

    const areaHa = +(turf.area(f) / 10_000).toFixed(2);
    const productiveAreaHa = attrs?.productiveAreaHa ?? areaHa;
    const volumeM3PerHa = attrs?.volumeM3PerHa ?? num(raw.VOLYM);
    const totalVolumeM3sk = volumeM3PerHa != null
      ? +(volumeM3PerHa * productiveAreaHa).toFixed(1) : null;

    const props = {
      _kind: 'forestStand',
      standNo: standNo || null,
      skifte: str(raw.SKIFTE),
      landUse: str(raw.AGOSLAG),
      goalClass: str(raw.MALKLASS),
      cuttingClass: str(raw.HKL),
      areaHa,
      productiveAreaHa: productiveAreaHa != null ? +productiveAreaHa.toFixed(2) : null,
      meanAgeYr: attrs?.meanAgeYr ?? num(raw.ALDER),
      dominantHeightM: attrs?.dominantHeightM ?? num(raw.MEDELHOJD),
      stemsPerHa: attrs?.stemsPerHa ?? null,
      basalAreaM2Ha: attrs?.basalAreaM2Ha ?? num(raw.GRUNDYTA),
      volumeM3PerHa: volumeM3PerHa ?? null,
      totalVolumeM3sk,
      weightedDiameterCm: attrs?.weightedDiameterCm ?? num(raw.DGV),
      managementClass: attrs?.managementClass || null,
      maturityClass: attrs?.maturityClass || null,
      siteIndex: attrs?.siteIndex || (raw.STANDORTSI != null ? String(raw.STANDORTSI) : null),
      soilMoisture: attrs?.soilMoisture || null,
      species: attrs?.species || [],
      treatments: attrs?.treatments || [],
    };

    totalAreaHa += areaHa;
    if (totalVolumeM3sk) totalVolume += totalVolumeM3sk;

    features.push({ type: 'Feature', geometry: f.geometry, properties: props });
  }

  // Stands present in the XML but with no matching geometry
  const noGeom = [...standMap.keys()].filter(k => !seenStandNo.has(k));

  return {
    features,
    propertyName: xmlResult?.propertyName || null,
    propertyId: xmlResult?.propertyId || null,
    matched: features.length - noAttrs.length,
    unmatched: { noAttrs, noGeom },
    summary: {
      standCount: features.length,
      areaHa: +totalAreaHa.toFixed(1),
      volumeM3sk: Math.round(totalVolume),
    },
  };
}

// ── Colour scale by cutting class (huggningsklass) ───────────
// The dbf codes HKL numerically (1 = bare land … 8/9 = mature stand
// ready for final felling); a young→old green ramp reads intuitively.
// Letter codes (K/R/G/S) are also handled for other data sources.
const HKL_RAMP = ['#d9c8a3', '#cfe0a8', '#a9d38a', '#7cc069',
                  '#4fa955', '#2f8f49', '#1f7a3e', '#155f30', '#0e4a25'];

export function cuttingClassColor(hkl) {
  const c = String(hkl ?? '').trim().toUpperCase();
  if (!c || c === 'NAN') return '#6f9c7d';
  const n = Number(c);
  if (Number.isFinite(n)) {
    return HKL_RAMP[Math.max(0, Math.min(HKL_RAMP.length - 1, Math.round(n) - 1))];
  }
  if (c.startsWith('K')) return '#d9c8a3';  // kalmark
  if (c.startsWith('R')) return '#9ad07a';  // röjningsskog
  if (c.startsWith('G')) return '#3f9e5a';  // gallringsskog
  if (c.startsWith('S')) return '#1f6b3b';  // slutavverkning
  return '#6f9c7d';
}

/** Representative colour for a whole forest layer (medium green). */
export const FOREST_LAYER_COLOR = '#3f9e5a';
