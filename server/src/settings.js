// CUPS server configuration: CA, CUPS TLS server certificate, URLs.
import { getSetting, setSetting, query } from './db.js';
import { config } from './config.js';
import { certInfo, createSelfSignedCa, issueCertificate, validateUploadedCa, parseCert, PkiError } from './pki.js';
import { EventEmitter } from 'node:events';
import { ChirpStackError, listGateways as csListGateways, parseServer } from './chirpstack/client.js';

/** Emits 'tls-changed' whenever the CUPS server certificate or CA changes. */
export const settingsEvents = new EventEmitter();

const DEFAULT_GENERAL = () => ({
  cupsPublicUrl: `https://localhost:${config.cupsPort}`,
  lnsUrl: '',
  lnsTrustPem: '',
  requireClientCert: true,
});

export async function getGeneral() {
  return { ...DEFAULT_GENERAL(), ...(await getSetting('general', {})) };
}

export async function getCa() {
  return getSetting('ca'); // {certPem, keyPem, source, createdAt} | null
}

export async function getServerCert() {
  return getSetting('cups_server_cert'); // {certPem, keyPem, hosts} | null
}

function hostsFor(cupsPublicUrl) {
  const hosts = ['localhost', '127.0.0.1', '::1'];
  try {
    const h = new URL(cupsPublicUrl).hostname.replace(/^\[|\]$/g, '');
    if (h) hosts.unshift(h);
  } catch { /* validated elsewhere */ }
  return [...new Set(hosts)];
}

/** (Re)issue the CUPS HTTPS server certificate from the current CA. */
async function issueServerCert() {
  const ca = await getCa();
  if (!ca) return null;
  const { cupsPublicUrl } = await getGeneral();
  const hosts = hostsFor(cupsPublicUrl);
  const { certPem, keyPem } = await issueCertificate({
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    commonName: hosts[0],
    purpose: 'server',
    hosts,
    validityDays: 825,
  });
  const value = { certPem, keyPem, hosts, issuedAt: new Date().toISOString() };
  await setSetting('cups_server_cert', value);
  settingsEvents.emit('tls-changed');
  return value;
}

/** Make sure the server certificate exists, matches the CA/hosts and is not about to expire. */
export async function ensureServerCert() {
  const ca = await getCa();
  if (!ca) return null;
  const cur = await getServerCert();
  const { cupsPublicUrl } = await getGeneral();
  if (cur) {
    const c = parseCert(cur.certPem);
    const sameCa = c.checkIssued(parseCert(ca.certPem)) && c.verify(parseCert(ca.certPem).publicKey);
    const sameHosts = JSON.stringify(cur.hosts) === JSON.stringify(hostsFor(cupsPublicUrl));
    const fresh = new Date(c.validTo).getTime() - Date.now() > 30 * 86_400_000;
    if (sameCa && sameHosts && fresh) return cur;
  }
  return issueServerCert();
}

export async function uploadCa({ certPem, keyPem }) {
  if (!certPem || !keyPem) throw new PkiError('certPem and keyPem are required');
  validateUploadedCa(certPem, keyPem);
  await setSetting('ca', { certPem, keyPem, source: 'uploaded', createdAt: new Date().toISOString() });
  await issueServerCert();
}

export async function generateCa(opts) {
  const validityDays = Number(opts?.validityDays) || 3650;
  if (validityDays < 30 || validityDays > 36500) throw new PkiError('validityDays must be between 30 and 36500');
  const keyType = opts?.keyType === 'rsa-2048' ? 'rsa-2048' : 'ec-p256';
  const { certPem, keyPem } = await createSelfSignedCa({
    commonName: opts?.commonName || 'OpenCUPS Root CA',
    organization: opts?.organization ?? 'OpenCUPS',
    validityDays,
    keyType,
  });
  await setSetting('ca', { certPem, keyPem, source: 'self-signed', createdAt: new Date().toISOString() });
  await issueServerCert();
}

export async function updateGeneral(patch) {
  const cur = await getGeneral();
  const next = { ...cur };
  if (patch.cupsPublicUrl !== undefined) {
    const u = parseUrl(patch.cupsPublicUrl, ['https:'], 'cupsPublicUrl');
    next.cupsPublicUrl = u;
  }
  if (patch.lnsUrl !== undefined) {
    next.lnsUrl = patch.lnsUrl === '' ? '' : parseUrl(patch.lnsUrl, ['wss:', 'ws:'], 'lnsUrl');
  }
  if (patch.lnsTrustPem !== undefined) {
    if (patch.lnsTrustPem) parseCert(patch.lnsTrustPem);
    next.lnsTrustPem = patch.lnsTrustPem || '';
  }
  if (patch.requireClientCert !== undefined) next.requireClientCert = Boolean(patch.requireClientCert);
  await setSetting('general', next);
  if (next.cupsPublicUrl !== cur.cupsPublicUrl) await ensureServerCert();
  if (next.requireClientCert !== cur.requireClientCert) settingsEvents.emit('tls-changed');
  return next;
}

export function parseUrl(value, protocols, field) {
  let u;
  try {
    u = new URL(String(value).trim());
  } catch {
    throw new PkiError(`${field}: not a valid URL`);
  }
  if (!protocols.includes(u.protocol)) throw new PkiError(`${field}: protocol must be ${protocols.join(' or ')}`);
  // Station sends back exactly what it stored; keep it canonical (no trailing slash on bare origins).
  const s = u.pathname === '/' && !String(value).trim().endsWith('/') ? u.origin : u.toString();
  if (s.length > 255) throw new PkiError(`${field}: too long (max 255 characters)`);
  return s;
}

// --- ChirpStack v4 integration (gRPC API; the API key is the secret) -----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getChirpStack() {
  return getSetting('chirpstack'); // {server, tls, tenantId, apiKey} | null
}

/** Save the integration. An empty/omitted apiKey keeps the stored one. The connection is verified first. */
export async function setChirpStack(body) {
  const cur = await getChirpStack();
  const server = parseServer(body?.server);
  const tenantId = String(body?.tenantId ?? '').trim();
  if (!UUID.test(tenantId)) throw new ChirpStackError('tenantId must be a UUID', 400);
  const apiKey = (typeof body?.apiKey === 'string' && body.apiKey.trim()) || cur?.apiKey;
  if (!apiKey) throw new ChirpStackError('apiKey is required', 400);
  if (/[\r\n]/.test(apiKey)) throw new ChirpStackError('apiKey must be a single line', 400);
  const next = { server, tls: body?.tls !== false, tenantId: tenantId.toLowerCase(), apiKey };
  await csListGateways(next); // throws with a readable message when unreachable / unauthorised
  await setSetting('chirpstack', next);
  return next;
}

export async function clearChirpStack() {
  await query('DELETE FROM settings WHERE key = $1', ['chirpstack']);
}

/** ChirpStack gateways of the configured tenant that are not yet in the CUPS database. */
export async function availableChirpStackGateways() {
  const cfg = await getChirpStack();
  if (!cfg) throw new ChirpStackError('ChirpStack integration is not configured', 409);
  const [all, { rows }] = await Promise.all([csListGateways(cfg), query('SELECT eui FROM gateways')]);
  const known = new Set(rows.map((r) => r.eui));
  return all.filter((g) => !known.has(g.eui)).sort((a, b) => a.name.localeCompare(b.name) || a.eui.localeCompare(b.eui));
}

function describeChirpStack(cs) {
  return cs ? { server: cs.server, tls: cs.tls, tenantId: cs.tenantId, hasApiKey: true } : null;
}

/** Public view (no private keys). */
export async function describeSetup() {
  const [general, ca, server] = await Promise.all([getGeneral(), getCa(), getServerCert()]);
  return {
    ...general,
    chirpstack: describeChirpStack(await getChirpStack()),
    lnsTrust: general.lnsTrustPem ? certInfo(general.lnsTrustPem) : null,
    ca: ca ? { source: ca.source, createdAt: ca.createdAt, certPem: ca.certPem, ...certInfo(ca.certPem) } : null,
    serverCert: server ? { hosts: server.hosts, issuedAt: server.issuedAt, ...certInfo(server.certPem) } : null,
  };
}
