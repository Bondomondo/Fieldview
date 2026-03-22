/**
 * FieldView – WFS Proxy Server
 *
 * Serves the static frontend and proxies WFS requests to avoid
 * browser CORS restrictions.
 *
 * Usage:  node server.js          (default port 3000)
 *         PORT=8080 node server.js
 */

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Static files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Add this BEFORE your /proxy route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── WFS Proxy ────────────────────────────────────────────────
// GET /proxy?url=<encoded-wfs-url>
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

  // Security: only proxy requests that look like WFS
  const service = (parsed.searchParams.get('service') || '').toUpperCase();
  if (service && service !== 'WFS') {
    return res.status(403).json({ error: 'Only WFS service requests are allowed' });
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'FieldView/1.0 (+WFS proxy)',
        'Accept': 'application/json, application/xml, text/xml, */*',
      },
      // Reasonable timeout: 30 s
      timeout: 30000,
    });

    // Forward content-type so the browser can tell JSON from XML
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);

    // Stream the body straight through
    upstream.body.pipe(res);
  } catch (err) {
    console.error('[proxy error]', err.message);
    res.status(502).json({ error: `Upstream request failed: ${err.message}` });
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  FieldView running →  http://localhost:${PORT}\n`);
});
