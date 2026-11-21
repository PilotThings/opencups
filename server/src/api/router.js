import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { normalizeEui } from '../cups/eui.js';
import { cupsStatus } from '../cups/server.js';
import * as gateways from '../gateways.js';
import { describeSetup, generateCa, getCa, getGeneral, updateGeneral, uploadCa } from '../settings.js';
import { certInfo } from '../pki.js';

export const api = express.Router();
api.use(express.json({ limit: '1mb' }));

// Optional bearer-token protection of the whole management API.
api.use((req, res, next) => {
  if (!config.adminToken) return next();
  const m = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  const ok = m && m[1].length === config.adminToken.length &&
    crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(config.adminToken));
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ---- status / dashboard ---------------------------------------------------

api.get('/status', wrap(async (req, res) => {
  const [general, ca] = await Promise.all([getGeneral(), getCa()]);
  const { rows: [c] } = await query(`
    SELECT
      (SELECT count(*) FROM gateways)::int AS gateways,
      (SELECT count(DISTINCT gateway_eui) FROM cups_requests
         WHERE valid AND ts > now() - interval '30 days')::int AS active_gateways,
      (SELECT count(*) FROM gateways
         WHERE least(cups_cert_not_after, tc_cert_not_after, cups_boot_cert_not_after) < now() + interval '30 days')::int AS certs_expiring,
      (SELECT count(*) FROM gateways
         WHERE least(cups_cert_not_after, tc_cert_not_after, cups_boot_cert_not_after) < now())::int AS certs_expired,
      (SELECT count(*) FROM cups_requests WHERE ts > now() - interval '30 days')::int AS requests_30d,
      (SELECT count(*) FROM cups_requests WHERE ts > now() - interval '30 days' AND NOT valid)::int AS invalid_30d
  `);
  res.json({
    cups: { ...cupsStatus(), url: general.cupsPublicUrl, endpoint: `${general.cupsPublicUrl}/update-info`, requireClientCert: general.requireClientCert },
    lnsUrl: general.lnsUrl,
    ca: ca ? { source: ca.source, ...certInfo(ca.certPem) } : null,
    counts: {
      gateways: c.gateways,
      activeGateways: c.active_gateways,
      certsExpiringSoon: c.certs_expiring,
      certsExpired: c.certs_expired,
      requests30d: c.requests_30d,
      invalidRequests30d: c.invalid_30d,
    },
  });
}));

api.get('/stats/requests', wrap(async (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 30, 1), 365);
  const { rows } = await query(`
    SELECT to_char(d, 'YYYY-MM-DD') AS date,
           count(r.id) FILTER (WHERE r.valid)::int     AS valid,
           count(r.id) FILTER (WHERE NOT r.valid)::int AS invalid
    FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') AS d
    LEFT JOIN cups_requests r ON r.ts >= d AND r.ts < d + interval '1 day'
    GROUP BY d ORDER BY d`, [days]);
  res.json(rows);
}));

api.get('/requests', wrap(async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 500);
  const where = [];
  const params = [];
  if (req.query.gateway) {
    params.push(normalizeEui(String(req.query.gateway)));
    where.push(`gateway_eui = $${params.length}`);
  }
  if (req.query.valid === 'true' || req.query.valid === 'false') {
    params.push(req.query.valid === 'true');
    where.push(`valid = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT id, ts, gateway_eui, router_raw, remote_addr, valid, status_code, reason, updates, request, cred_set
     FROM cups_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ts DESC LIMIT $${params.length}`, params);
  res.json(rows.map((r) => ({
    id: String(r.id), ts: r.ts, gatewayEui: r.gateway_eui, routerRaw: r.router_raw, remoteAddr: r.remote_addr,
    valid: r.valid, statusCode: r.status_code, reason: r.reason, updates: r.updates, request: r.request, credSet: r.cred_set,
  })));
}));

// ---- setup ----------------------------------------------------------------

api.get('/setup', wrap(async (req, res) => res.json(await describeSetup())));

api.put('/setup', wrap(async (req, res) => {
  await updateGeneral(req.body || {});
  res.json(await describeSetup());
}));

api.post('/setup/ca/upload', wrap(async (req, res) => {
  await uploadCa(req.body || {});
  res.json(await describeSetup());
}));

api.post('/setup/ca/self-signed', wrap(async (req, res) => {
  await generateCa(req.body || {});
  res.json(await describeSetup());
}));

api.get('/setup/ca/certificate', wrap(async (req, res) => {
  const ca = await getCa();
  if (!ca) return res.status(404).json({ error: 'No CA configured' });
  res.type('application/x-pem-file').attachment('cups.trust').send(ca.certPem);
}));

// ---- gateways -------------------------------------------------------------

api.get('/gateways', wrap(async (req, res) => res.json(await gateways.listGateways())));
api.post('/gateways', wrap(async (req, res) => res.status(201).json(await gateways.createGateway(req.body))));
api.get('/gateways/:eui', wrap(async (req, res) => res.json(await gateways.getGateway(req.params.eui))));
api.patch('/gateways/:eui', wrap(async (req, res) => res.json(await gateways.updateGateway(req.params.eui, req.body || {}))));
api.delete('/gateways/:eui', wrap(async (req, res) => {
  await gateways.deleteGateway(req.params.eui);
  res.status(204).end();
}));
api.post('/gateways/:eui/cups-cert/renew', wrap(async (req, res) => res.json(await gateways.renewCupsCert(req.params.eui))));
api.post('/gateways/:eui/boot-cert', wrap(async (req, res) => res.json(await gateways.issueBootCert(req.params.eui))));
api.get('/gateways/:eui/bootstrap', wrap(async (req, res) => res.json(await gateways.bootstrapFiles(req.params.eui))));

// ---- errors ---------------------------------------------------------------

api.use((req, res) => res.status(404).json({ error: `No route ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  const status = err.status || err.statusCode || (/Illegal (EUI|id6)/.test(err.message) ? 400 : 500);
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: err.type === 'entity.parse.failed' ? 'Malformed JSON body' : err.message });
});
