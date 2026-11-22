# FieldView Data API

Read **who farms what** (and more) from a saved FieldView workspace over HTTP.

Data is read from the same Firestore the app writes to, so it reflects your
**latest cloud save** — save a workspace in the app first.

## Setup (one-time)

The API needs the Firebase **Admin SDK**. In the Firebase console:
Project settings → Service accounts → *Generate new private key* → download the JSON.

In Vercel (Project → Settings → Environment Variables) add:

- `FIREBASE_SERVICE_ACCOUNT` = the **entire** service-account JSON, on one line.

Redeploy. Without this variable the site and proxy still work; the data API
returns `503`.

Lock the `apiKeys` Firestore collection to server-only (default-deny is fine —
the app never reads it; only the Admin SDK does).

## Authentication

- **Key management** (`/api/keys`) uses your Google sign-in. Manage keys in the
  app: sidebar → **API** (visible when signed in).
- **Data endpoints** use a personal API key sent in the `X-API-Key` header.
  The key is shown once, at creation.

## Endpoints

| Method | Path | Auth | Returns |
|--------|------|------|---------|
| `GET`  | `/api/status` | none | `{ ok, apiConfigured }` |
| `POST` | `/api/keys` | Google token | Create a key → `{ id, key }` (key shown once) |
| `GET`  | `/api/keys` | Google token | List your keys (no plaintext) |
| `DELETE` | `/api/keys/:id` | Google token | Revoke a key |
| `GET`  | `/api/workspaces` | API key | `{ workspaces: [{ id, name, savedAt }] }` |
| `GET`  | `/api/labels/names` | API key | List labels only (name, colour, area, field count) |
| `GET`  | `/api/labels` | API key | Who-farms-what as JSON (see below) |
| `GET`  | `/api/labels.geojson` | API key | Same data as GeoJSON (one feature per field) |

All three label endpoints accept:

- `?workspace=<id or name>` — defaults to the most recently saved workspace.
- `?label=<name>` or `?label=<a>,<b>` — keep only these labels (case-insensitive).

Examples:

```
/api/labels/names
/api/labels?label=Kopparfall
/api/labels.geojson?label=Kopparfall,Undsjö
```

### `GET /api/labels` response

```json
{
  "workspace": { "id": "…", "name": "Ugglebol" },
  "generatedAt": "2026-11-22T10:00:00.000Z",
  "totalAreaHa": 68.4,
  "totalFields": 33,
  "labels": [
    {
      "label": "Kopparfall",
      "color": "#ef5350",
      "fieldCount": 26,
      "areaHa": 60.0,
      "fields": [
        { "id": "…", "name": "…", "areaHa": 2.1, "properties": { … } }
      ]
    }
  ]
}
```

## Example

```bash
curl -H "X-API-Key: fv_xxxxxxxx" https://<your-app>/api/labels
curl -H "X-API-Key: fv_xxxxxxxx" https://<your-app>/api/labels.geojson
```
