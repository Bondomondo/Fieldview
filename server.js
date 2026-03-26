/**
 * FieldView – WFS/WMS Proxy Server
 *
 * Serves the static frontend and proxies WFS/WMS requests to avoid
 * browser CORS restrictions.
 *
 * Basic-auth credentials for upstream services are configured via
 * environment variables (e.g. in Vercel project settings):
 *
 *   PROXY_CREDENTIALS – JSON array of per-host credentials:
 *     [{ "host": "example.com", "username": "user", "password": "pass" }]
 *
 * Usage:  node server.js          (default port 3000)
 *         PORT=8080 node server.js
 */

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Per-host credentials ──────────────────────────────────────
// Loaded once at startup from the PROXY_CREDENTIALS env var.
let proxyCredentials = [];
if (process.env.PROXY_CREDENTIALS) {
  try {
    proxyCredentials = JSON.parse(process.env.PROXY_CREDENTIALS);
    if (!Array.isArray(proxyCredentials)) throw new Error('Expected array');
    console.log(`[proxy] loaded credentials for: ${proxyCredentials.map(c => c.host).join(', ')}`);
  } catch (e) {
    console.error('[proxy] invalid PROXY_CREDENTIALS env var:', e.message);
  }
}

/**
 * Returns a Basic-Auth header value for the given hostname,
 * or null if no credentials are configured for it.
 */
function getBasicAuth(hostname) {
  const entry = proxyCredentials.find(c => c.host && hostname.endsWith(c.host));
  if (!entry || !entry.username) return null;
  return 'Basic ' + Buffer.from(`${entry.username}:${entry.password ?? ''}`).toString('base64');
}

// ── Static files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Proxy ────────────────────────────────────────────────────
// GET /proxy?url=<encoded-url>
const ALLOWED_SERVICES = new Set(['WFS', 'WMS']);

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Security: only proxy recognised OGC services
  const service = (parsed.searchParams.get('SERVICE') || parsed.searchParams.get('service') || '').toUpperCase();
  if (service && !ALLOWED_SERVICES.has(service)) {
    return res.status(403).json({ error: `Only ${[...ALLOWED_SERVICES].join('/')} service requests are allowed` });
  }

  const headers = {
    'User-Agent': 'FieldView/1.0 (+proxy)',
    'Accept': 'application/json, application/xml, text/xml, image/png, image/jpeg, */*',
  };

  const auth = getBasicAuth(parsed.hostname);
  if (auth) headers['Authorization'] = auth;

  try {
    const upstream = await fetch(targetUrl, { headers, timeout: 30000 });

    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);

    upstream.body.pipe(res);
  } catch (err) {
    console.error('[proxy error]', err.message);
    res.status(502).json({ error: `Upstream request failed: ${err.message}` });
  }
});

// ── Share email ──────────────────────────────────────────────
// POST /api/send-share-email  { to, shareUrl, shareName }
// Requires RESEND_API_KEY env var (https://resend.com).
// Optional: RESEND_FROM  (default: FieldView <onboarding@resend.dev>)
app.post('/api/send-share-email', express.json(), async (req, res) => {
  const { to, shareUrl, shareName } = req.body ?? {};
  if (!to || !shareUrl) {
    return res.status(400).json({ error: 'Missing to or shareUrl' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Email service not configured (RESEND_API_KEY missing)' });
  }

  const from = process.env.RESEND_FROM || 'FieldView <onboarding@resend.dev>';
  const subject = `FieldView map shared with you: ${shareName || 'Map'}`;
  const html = `
    <p>A FieldView map has been shared with you.</p>
    <p><strong>${shareName || 'View map'}</strong></p>
    <p><a href="${shareUrl}" style="background:#4caf71;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Open in FieldView</a></p>
    <p style="color:#888;font-size:12px">Or copy this link: ${shareUrl}</p>
  `;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Resend ${r.status}: ${body}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[send-share-email]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Firebase config ──────────────────────────────────────────
// Exposes public Firebase client config from env vars so the frontend
// can initialise Firebase without hard-coded credentials.
app.get('/api/config', (req, res) => {
  res.json({
    apiKey:            process.env.FIREBASE_API_KEY             ?? '',
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN         ?? '',
    projectId:         process.env.FIREBASE_PROJECT_ID          ?? '',
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET      ?? '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId:             process.env.FIREBASE_APP_ID              ?? '',
  });
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  FieldView running →  http://localhost:${PORT}\n`);
});
