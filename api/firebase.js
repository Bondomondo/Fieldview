/**
 * FieldView API – Firebase Admin SDK initialisation
 *
 * Initialises the Admin SDK from the FIREBASE_SERVICE_ACCOUNT env var (a
 * JSON service-account key, set in Vercel project settings). The whole app
 * still boots without it — the /api data routes then return 503 — so the
 * proxy and static site keep working.
 */

const admin = require('firebase-admin');

let adminReady = false;
try {
  if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  adminReady = !!admin.apps.length;
  if (adminReady) console.log('[firebase-admin] initialised');
  else console.warn('[firebase-admin] FIREBASE_SERVICE_ACCOUNT not set — data API disabled');
} catch (e) {
  console.error('[firebase-admin] init failed:', e.message);
}

module.exports = {
  admin,
  adminReady,
  db:   adminReady ? admin.firestore() : null,
  auth: adminReady ? admin.auth() : null,
  FieldValue: admin.firestore.FieldValue,
};
