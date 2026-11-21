// The CUPS endpoint Basics Station talks to: POST /update-info over HTTPS.
import https from 'node:https';
import { query } from '../db.js';
import { normalizeEui, formatEui } from './eui.js';
import { encodeUpdateInfo } from './protocol.js';
import { findGateway, targetState } from '../gateways.js';
import { getCa, getGeneral, ensureServerCert, settingsEvents } from '../settings.js';

const MAX_BODY = 64 * 1024;

const state = { server: null, running: false, port: null, error: null, startedAt: null };

export const cupsStatus = () => ({
  running: state.running,
  port: state.port,
  error: state.error,
  startedAt: state.startedAt,
});

async function tlsOptions() {
  const ca = await getCa();
  if (!ca) return null;
  const cert = await ensureServerCert();
  return {
    key: cert.keyPem,
    cert: cert.certPem,
    ca: [ca.certPem],
    // Ask for a client cert but decide in the handler, so rejected attempts are logged.
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
  };
}

export async function startCupsServer(port) {
  state.port = port;
  const opts = await tlsOptions();
  if (!opts) {
    state.error = 'No CA configured — set up the CUPS CA to start the CUPS endpoint';
    console.log(`[cups] ${state.error}`);
  } else {
    await listen(port, opts);
  }
  settingsEvents.on('tls-changed', () => reload().catch((e) => console.error('[cups] reload failed', e)));
}

async function listen(port, opts) {
  const server = https.createServer(opts, (req, res) => {
    handle(req, res).catch((e) => {
      console.error('[cups] handler error', e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error');
    });
  });
  server.on('tlsClientError', (err, socket) => {
    logRequest({ remoteAddr: socket.remoteAddress, valid: false, statusCode: 0, reason: `TLS: ${err.code || err.message}` }).catch(() => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (e) => {
    state.error = e.message;
    state.running = false;
  });
  state.server = server;
  state.running = true;
  state.error = null;
  state.startedAt = new Date().toISOString();
  console.log(`[cups] listening on https://0.0.0.0:${port}/update-info`);
}

async function reload() {
  const opts = await tlsOptions();
  if (!opts) return;
  if (state.server && state.running) {
    state.server.setSecureContext(opts); // hot swap, existing listener keeps running
    console.log('[cups] TLS context reloaded');
  } else {
    try {
      await listen(state.port, opts);
    } catch (e) {
      state.error = e.message;
      state.running = false;
      console.error('[cups] failed to start', e.message);
    }
  }
}

export async function stopCupsServer() {
  if (state.server) await new Promise((r) => state.server.close(r));
  state.running = false;
}

// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function logRequest({ gatewayEui = null, routerRaw = null, remoteAddr, valid, statusCode, reason = null, updates = [], request = null, credSet = null }) {
  await query(
    `INSERT INTO cups_requests (gateway_eui, router_raw, remote_addr, valid, status_code, reason, updates, request, cred_set)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [gatewayEui, routerRaw, remoteAddr, valid, statusCode, reason, updates, request, credSet],
  );
  if (gatewayEui) {
    await query(
      `UPDATE gateways SET last_seen_at = now(), last_remote_addr = $2, last_valid = $3, last_reason = $4,
         last_package = coalesce($5, last_package), last_model = coalesce($6, last_model), last_station = coalesce($7, last_station)
       WHERE eui = $1`,
      [gatewayEui, remoteAddr, valid, reason, request?.package ?? null, request?.model ?? null, request?.station ?? null],
    );
  }
}

async function handle(req, res) {
  const remoteAddr = req.socket.remoteAddress;
  const reject = async (statusCode, reason, extra = {}) => {
    await logRequest({ remoteAddr, valid: false, statusCode, reason, ...extra });
    console.log(`[cups] x ${statusCode} ${reason} (${remoteAddr})`);
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(reason);
  };

  if (req.url.split('?')[0] !== '/update-info') return reject(404, `Unknown path ${req.url}`);
  if (req.method !== 'POST') return reject(405, `Method ${req.method} not allowed`);

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return reject(e.status || 400, e.status ? e.message : 'Malformed JSON body');
  }
  if (!body || typeof body !== 'object') return reject(400, 'Malformed request');

  const request = {
    router: body.router, model: body.model, package: body.package, station: body.station,
    cupsUri: body.cupsUri, tcUri: body.tcUri, cupsCredCrc: body.cupsCredCrc, tcCredCrc: body.tcCredCrc, keys: body.keys,
  };
  const routerRaw = typeof body.router === 'string' || typeof body.router === 'number' ? String(body.router) : null;

  let gwEui;
  try {
    gwEui = normalizeEui(body.router);
  } catch {
    return reject(400, `Invalid router id: ${routerRaw}`, { routerRaw, request });
  }

  const gw = await findGateway(gwEui);
  if (!gw) return reject(404, `Unknown gateway ${formatEui(gwEui)}`, { routerRaw, request });
  const ctx = { gatewayEui: gwEui, routerRaw, request };

  // --- client authentication ---------------------------------------------
  const { requireClientCert } = await getGeneral();
  const peer = req.socket.getPeerCertificate();
  const hasPeer = peer && Object.keys(peer).length > 0;
  // Which of the gateway's credential sets was used (Station falls back regular -> bak -> boot):
  //  - regular:   the current cert
  //  - previous:  the cert before a pending rotation (also what Station keeps in cups-bak.*)
  //  - bootstrap: the immutable factory cert (cups-boot.*), always accepted
  const sets = { regular: gw.cups_cert_fingerprint, previous: gw.cups_prev_cert_fingerprint, bootstrap: gw.cups_boot_cert_fingerprint };
  const known = Object.values(sets).filter(Boolean);
  const credSet = hasPeer ? Object.keys(sets).find((k) => sets[k] && sets[k] === peer.fingerprint256) || null : null;
  ctx.credSet = credSet;
  if (requireClientCert) {
    if (!hasPeer) return reject(403, 'Client certificate required', ctx);
    if (!req.socket.authorized) return reject(403, `Client certificate rejected: ${req.socket.authorizationError}`, ctx);
    if (!credSet) return reject(403, 'Client certificate does not belong to this gateway', ctx);
  } else if (hasPeer && req.socket.authorized && known.length && !credSet) {
    return reject(403, 'Client certificate belongs to another gateway', ctx);
  }

  if (!body.package) return reject(404, 'Nil/unknown firmware', ctx);
  for (const k of ['cupsCredCrc', 'tcCredCrc']) {
    if (body[k] !== undefined && !Number.isFinite(Number(body[k]))) return reject(400, `Invalid ${k}`, ctx);
  }

  const target = await targetState(gw);
  // Rotation done once the gateway authenticates with the new cert.
  if (gw.cups_prev_cert_fingerprint && hasPeer && peer.fingerprint256 === gw.cups_cert_fingerprint) {
    await query('UPDATE gateways SET cups_prev_cert_fingerprint = NULL WHERE eui = $1', [gwEui]);
  }
  // On a fallback set, always re-send the regular credentials: the reported CRC may not
  // describe the set Station is actually running on.
  const onFallback = credSet === 'previous' || credSet === 'bootstrap';
  const { body: out, updates } = encodeUpdateInfo(
    { cupsUri: body.cupsUri ?? '', tcUri: body.tcUri ?? '', cupsCredCrc: body.cupsCredCrc, tcCredCrc: body.tcCredCrc },
    target,
    { forceCupsCred: onFallback },
  );

  const via = onFallback ? ` (via ${credSet} cert)` : '';
  await logRequest({ ...ctx, remoteAddr, valid: true, statusCode: 200, updates, reason: (updates.length ? `update: ${updates.join(', ')}` : 'in sync') + via });
  console.log(`[cups] < ${formatEui(gwEui)} ${updates.length ? 'update ' + updates.join(',') : 'in sync'} (${out.length} bytes)`);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': out.length });
  res.end(out);
}
