/**
 * FieldView API – API key management
 *
 * Per-user API keys for programmatic access. Only a SHA-256 hash of each
 * key is stored (collection `apiKeys`), and the plaintext key is returned
 * exactly once, at creation. Incoming requests send the key in the
 * `X-API-Key` header; it is hashed and looked up to resolve the owner uid.
 *
 * The `apiKeys` collection is only ever read/written via the Admin SDK
 * (which bypasses security rules), so client access to it should stay
 * denied by Firestore rules.
 */

const crypto = require('crypto');
const { FieldValue } = require('./firebase');

function generateKey() {
  return 'fv_' + crypto.randomBytes(24).toString('base64url');
}
function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

async function createKey(db, uid, label) {
  const key = generateKey();
  const ref = await db.collection('apiKeys').add({
    uid,
    hash: hashKey(key),
    label: (label || 'API key').slice(0, 80),
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: null,
  });
  return { id: ref.id, key };   // plaintext returned once, never stored
}

async function verifyKey(db, plaintext) {
  if (!plaintext) return null;
  const snap = await db.collection('apiKeys').where('hash', '==', hashKey(plaintext)).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  doc.ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => {});
  return { uid: doc.data().uid, id: doc.id };
}

async function listKeys(db, uid) {
  const snap = await db.collection('apiKeys').where('uid', '==', uid).get();
  return snap.docs
    .map(d => {
      const v = d.data();
      return {
        id: d.id,
        label: v.label,
        createdAt: v.createdAt?.toDate?.()?.toISOString?.() ?? null,
        lastUsedAt: v.lastUsedAt?.toDate?.()?.toISOString?.() ?? null,
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function revokeKey(db, uid, id) {
  const ref = db.collection('apiKeys').doc(id);
  const doc = await ref.get();
  if (!doc.exists || doc.data().uid !== uid) return false;
  await ref.delete();
  return true;
}

module.exports = { createKey, verifyKey, listKeys, revokeKey, hashKey };
