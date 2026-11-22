/**
 * FieldView API – versioned REST routes (mounted at /api)
 *
 * Key management is authenticated with the signed-in user's Google ID
 * token (Authorization: Bearer <idToken>); data endpoints are
 * authenticated with a personal API key (X-API-Key header).
 *
 * Data is read from the same Firestore the app already writes to
 * (users/{uid}/workspaces), so it reflects the user's latest cloud save.
 */

const express = require('express');
const { adminReady, db, auth } = require('./firebase');
const shape = require('./shape');
const keys = require('./keys');

const router = express.Router();
router.use(express.json());

function adminGuard(res) {
  if (!adminReady) {
    res.status(503).json({ error: 'API not configured — set FIREBASE_SERVICE_ACCOUNT in the server environment.' });
    return true;
  }
  return false;
}

// Auth: signed-in owner (for managing their own keys)
async function requireGoogleAuth(req, res, next) {
  if (adminGuard(res)) return;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    req.uid = (await auth.verifyIdToken(m[1])).uid;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Auth: API key (for programmatic data access)
async function requireApiKey(req, res, next) {
  if (adminGuard(res)) return;
  const key = req.headers['x-api-key'] || req.query.api_key;
  const v = await keys.verifyKey(db, key);
  if (!v) return res.status(401).json({ error: 'Invalid or missing API key (send it in the X-API-Key header).' });
  req.uid = v.uid;
  next();
}

// Resolve a workspace by id, by name, or the most recent one.
async function loadWorkspace(uid, wsQuery) {
  const col = db.collection('users').doc(uid).collection('workspaces');
  if (wsQuery) {
    const byId = await col.doc(wsQuery).get();
    if (byId.exists) return { id: byId.id, data: byId.data() };
    const byName = await col.where('name', '==', wsQuery).limit(1).get();
    if (!byName.empty) return { id: byName.docs[0].id, data: byName.docs[0].data() };
    return null;
  }
  const snap = await col.orderBy('savedAt', 'desc').limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() };
}

// ── Key management (Google ID token) ─────────────────────────
router.post('/keys', requireGoogleAuth, async (req, res) => {
  const result = await keys.createKey(db, req.uid, req.body?.label);
  res.json(result);  // { id, key } — key shown once
});
router.get('/keys', requireGoogleAuth, async (req, res) => {
  res.json({ keys: await keys.listKeys(db, req.uid) });
});
router.delete('/keys/:id', requireGoogleAuth, async (req, res) => {
  const ok = await keys.revokeKey(db, req.uid, req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

// ── Data (API key) ───────────────────────────────────────────
router.get('/workspaces', requireApiKey, async (req, res) => {
  const snap = await db.collection('users').doc(req.uid).collection('workspaces')
    .orderBy('savedAt', 'desc').limit(50).get();
  res.json({
    workspaces: snap.docs.map(d => ({
      id: d.id,
      name: d.data().name,
      savedAt: d.data().savedAt?.toDate?.()?.toISOString?.() ?? null,
    })),
  });
});

// List the labels (brukare) only — names, colour, area, field count.
router.get('/labels/names', requireApiKey, async (req, res) => {
  const ws = await loadWorkspace(req.uid, req.query.workspace);
  if (!ws) return res.status(404).json({ error: 'No saved workspace found. Save a workspace to the cloud first.' });
  const layers = shape.parseLayers(ws.data);
  const filter = shape.parseLabelFilter(req.query.label);
  const { labels, totalAreaHa, totalFields } = shape.extractLabels(layers, filter);
  res.json({
    workspace: { id: ws.id, name: ws.data.name },
    generatedAt: new Date().toISOString(),
    totalAreaHa, totalFields,
    labels: labels.map(({ fields, ...rest }) => rest),   // drop per-field detail
  });
});

// Who farms what — structured JSON. Optional ?label=Name or ?label=A,B
router.get('/labels', requireApiKey, async (req, res) => {
  const ws = await loadWorkspace(req.uid, req.query.workspace);
  if (!ws) return res.status(404).json({ error: 'No saved workspace found. Save a workspace to the cloud first.' });
  const layers = shape.parseLayers(ws.data);
  const filter = shape.parseLabelFilter(req.query.label);
  const { labels, totalAreaHa, totalFields } = shape.extractLabels(layers, filter);
  res.json({
    workspace: { id: ws.id, name: ws.data.name },
    generatedAt: new Date().toISOString(),
    filter: filter || null,
    totalAreaHa, totalFields,
    labels,
  });
});

// Who farms what — GeoJSON (one feature per field). Optional ?label=A,B
router.get('/labels.geojson', requireApiKey, async (req, res) => {
  const ws = await loadWorkspace(req.uid, req.query.workspace);
  if (!ws) return res.status(404).json({ error: 'No saved workspace found. Save a workspace to the cloud first.' });
  const layers = shape.parseLayers(ws.data);
  const filter = shape.parseLabelFilter(req.query.label);
  res.setHeader('Content-Type', 'application/geo+json');
  res.json(shape.toGeoJSON(layers, filter));
});

// Simple health/capability probe (no auth) — handy for integration setup.
router.get('/status', (req, res) => {
  res.json({ ok: true, apiConfigured: adminReady });
});

module.exports = router;
