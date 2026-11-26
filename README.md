# OpenCUPS

A CUPS server ([Configuration and Update Server](https://doc.sm.tc/station/cupsproto.html)) for
LoRa Basics Station gateways, with a management UI and REST API.

It is a Node.js port of the CUPS server in `basicstation/examples/cups` (`pysys/tcutils.py`,
class `Cups`). Responses are byte-compatible: credential sets are encoded and CRC32'd exactly like
the Python implementation. Firmware updates are **not** served (signature/update segments are always empty).

```
opencups/
├── docker-compose.yml          PostgreSQL (image copencups/postgresql)
├── docker/postgresql/          Dockerfile for copencups/postgresql
├── server/                     Node.js: CUPS endpoint (HTTPS) + REST API + serves the UI
└── web/                        React UI (Meta Astryx components, Vite)
```

## Quick start

Requirements: Node.js ≥ 22.2, Docker.

```bash
cp .env.example .env               # adjust ports / passwords if needed
docker compose up -d --build       # builds copencups/postgresql, listens on localhost:5434
npm run setup                      # npm install in server/ and web/, builds the UI
npm start                          # http://localhost:8080 (UI + API), CUPS on https://…:6040
```

Development with hot reload: `npm run dev` in `server/` and `npm run dev` in `web/`
(Vite on http://localhost:5173, proxies `/api` to :8080).
UI changes are not visible on :8080 until you rebuild with `npm run build`; use the Vite dev server for live reload.
If port 5173 is already in use, run Vite on another port:

```bash
npm --prefix web run dev -- --port 5180    # http://localhost:5180
```

Then in the UI:

1. **Setup**: generate a self-signed CUPS CA (or upload a CA cert + key), set the **CUPS public URL**
   (the host name goes into the server certificate), the **LNS URL** and, optionally, the default LNS trust.
   The CUPS endpoint starts as soon as a CA exists.
2. **Gateways → Add gateway**: EUI, LNS credentials (client cert + key, or auth token), optional overrides.
   A CUPS client certificate (CN = EUI) and, optionally, bootstrap credentials are issued by the CA.
   **Optional – ChirpStack v4**: in **Setup → ChirpStack** enter the gRPC API address (`host:port`), a tenant ID and an
   API key (stored server-side, never returned by the API). The connection is tested on save. Afterwards **Add gateway**
   offers a picker with the tenant's ChirpStack gateways that are not yet in OpenCUPS; choosing one fills in EUI and name,
   and the CUPS client certificate is issued as usual.
3. On the gateway page, **Provisioning files** downloads `cups.{uri,trust,crt,key}` (and `cups-boot.*`)
   for the Station home directory. On its next CUPS request the gateway receives its LNS URI and credentials.

## How requests are handled

`POST /update-info` (HTTPS, port `CUPS_PORT`):

1. The router id (Station id6, e.g. `b827:ebff:fe61:51b5`) is normalised to an EUI-64 and looked up.
2. With **Require gateway client certificate** on (default), the TLS client certificate must chain to the
   CUPS CA and be one of the gateway's certificates (see below). Otherwise the request is rejected and logged as invalid.
3. The desired state (CUPS URI, LNS URI, CUPS credentials, LNS credentials) is compared to what Station
   reports (`cupsUri`, `tcUri`, `cupsCredCrc`, `tcCredCrc`); only differing segments are sent. A gateway
   in sync gets the 14 zero byte answer.

Every request (including TLS failures) is stored in `cups_requests` and drives the dashboard
(chart, invalid request count). History older than `REQUEST_RETENTION_DAYS` is pruned.

### Credential sets, rotation and recovery

Station keeps three CUPS credential sets and falls back in this order
([docs](https://doc.sm.tc/station/credentials.html)): regular `cups.*` → backup `cups-bak.*`
(copy of the last set that connected successfully) → bootstrap `cups-boot.*` (immutable, from the system image).
The server accepts, per gateway:

| Certificate | Accepted | Notes |
|---|---|---|
| current CUPS client cert | always | `regular` |
| previous CUPS client cert | until the gateway connects with the new one | `previous`: covers `cups-bak.*` during a rotation |
| bootstrap cert | always | `bootstrap`: recovery path when regular and backup fail |

**Renew** issues a new client cert. It is delivered over CUPS on the next request (authenticated with the old
cert), and the old cert is dropped once the gateway authenticates with the new one. When a gateway connects with a
`previous` or `bootstrap` cert, the regular CUPS credentials are always re-sent, even if the reported CRC matches.
The docs don't say which set's CRC Station reports while running on a fallback set.

Limits:
- Replacing the **CA** cannot be rolled out over CUPS: the server certificate is re-issued from the new CA, so
  gateways that only trust the old CA (including in `cups-boot.trust`) must be re-provisioned.
- LNS (`tc-bak` / `tc-boot`) fallback is handled by Station itself; the server only serves the regular LNS set.

## REST API

All under `/api`. If `ADMIN_TOKEN` is set, send `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| GET | `/status` | CUPS status, URL, CA info, counters |
| GET | `/stats/requests?days=30` | Daily valid/invalid request counts |
| GET | `/requests?gateway=&valid=&limit=` | Request log |
| GET / PUT | `/setup` | Settings (`cupsPublicUrl`, `lnsUrl`, `lnsTrustPem`, `requireClientCert`) |
| POST | `/setup/ca/self-signed` | `{commonName, organization, validityDays, keyType: "ec-p256"\|"rsa-2048"}` |
| POST | `/setup/ca/upload` | `{certPem, keyPem}` |
| GET | `/setup/ca/certificate` | CA certificate (`cups.trust`) |
| GET | `/gateways` | List |
| POST | `/gateways` | Create (see below) |
| GET | `/gateways/:eui` | Detail (certificate info, effective config; no private keys) |
| PATCH | `/gateways/:eui` | Update (same fields as create, except `eui`) |
| DELETE | `/gateways/:eui` | Remove |
| POST | `/gateways/:eui/cups-cert/renew` | Issue a new CUPS client certificate (rotated over CUPS) |
| POST | `/gateways/:eui/boot-cert` | Issue (or re-issue) bootstrap credentials |
| GET | `/gateways/:eui/bootstrap` | Provisioning files `cups.*` / `cups-boot.*` (**includes private keys**) |

`:eui` accepts `B8-27-EB-FF-FE-61-51-B5`, `b827ebfffe6151b5` or id6 `b827:ebff:fe61:51b5`.

Create body (all PEM fields are strings):

```jsonc
{
  "eui": "B8-27-EB-FF-FE-61-51-B5",   // required
  "name": "Rooftop GW 1",
  "description": "",
  "tcUri": "wss://lns.example.com:8887",  // optional override of Setup's LNS URL
  "cupsUri": "https://other-cups:6040",   // optional: redirect the gateway to another CUPS
  "tcTrustPem": "-----BEGIN CERTIFICATE-----…",     // optional, else Setup's default LNS trust
  "tcCertPem": "…", "tcKeyPem": "…",                 // LNS mutual TLS, or:
  "tcToken": "Authorization: Bearer NNSXS…",        // LNS token auth (full header line)
  "cupsCertPem": "…", "cupsKeyPem": "…",             // optional; must be signed by the CUPS CA
  "generateCupsCert": true,                          // default: issue one when none is given
  "generateBootCert": true,                          // issue bootstrap credentials
  "bootCertPem": "…", "bootKeyPem": "…"              // or provide them (key optional)
}
```

Example:

```bash
curl -X POST localhost:8080/api/gateways -H 'content-type: application/json' \
  -d '{"eui":"b827:ebff:fe61:51b5","name":"GW1","tcToken":"Authorization: Bearer NNSXS.XXXX","generateBootCert":true}'
curl -X DELETE localhost:8080/api/gateways/B827EBFFFE6151B5
```

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `postgres://opencups:opencups@localhost:5434/opencups` | |
| `POSTGRES_PORT` | `5434` | host port of the container |
| `HTTP_PORT` | `8080` | UI + REST API |
| `CUPS_PORT` | `6040` | CUPS HTTPS endpoint |
| `ADMIN_TOKEN` | empty | protects `/api` when set |
| `REQUEST_RETENTION_DAYS` | `90` | |

The database schema is created and migrated by the server at startup (`server/src/db.js`).

## Security notes

- Private keys (CA, gateway CUPS and LNS keys) are stored in PostgreSQL in clear text. Protect the database
  and set `ADMIN_TOKEN`; the admin port should not be exposed publicly.
- The admin API is plain HTTP; put it behind a TLS reverse proxy if it leaves the host.

## Tests

```bash
cd server && npm test
```
