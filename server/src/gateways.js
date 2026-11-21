// Gateway provisioning and the "desired state" served over CUPS.
import { query } from './db.js';
import { normalizeEui, formatEui } from './cups/eui.js';
import { buildCredential, crc32 } from './cups/protocol.js';
import { assertKeyMatchesCert, certInfo, isIssuedBy, issueCertificate, parseCert, PkiError } from './pki.js';
import { getCa, getGeneral, parseUrl } from './settings.js';

export class NotFound extends Error {
  constructor(m) {
    super(m);
    this.status = 404;
  }
}

const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() + (v.trim().startsWith('-----') ? '\n' : '') : null);

function eui(input) {
  try {
    return normalizeEui(input);
  } catch (e) {
    throw new PkiError(e.message);
  }
}

async function issueGatewayCupsCert(gwEui) {
  const ca = await getCa();
  if (!ca) throw new PkiError('No CUPS CA configured yet — set one up in Setup first');
  return issueCertificate({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, commonName: formatEui(gwEui), purpose: 'client', validityDays: 825 });
}

/** Long-lived bootstrap client cert (CN = "<EUI> boot"), capped at the CA's lifetime. */
async function bootCertColumns(gwEui) {
  const ca = await getCa();
  if (!ca) throw new PkiError('No CUPS CA configured yet — set one up in Setup first');
  const { certPem, keyPem } = await issueCertificate({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, commonName: `${formatEui(gwEui)} boot`, purpose: 'client', validityDays: 3650 });
  const c = parseCert(certPem);
  return { cups_boot_cert_pem: certPem, cups_boot_key_pem: keyPem, cups_boot_cert_fingerprint: c.fingerprint256, cups_boot_cert_not_after: new Date(c.validTo) };
}

export async function issueBootCert(euiParam) {
  const gwEui = eui(euiParam);
  await getGatewayRow(gwEui);
  const cols = await bootCertColumns(gwEui);
  const keys = Object.keys(cols);
  await query(`UPDATE gateways SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE eui = $1`, [gwEui, ...keys.map((k) => cols[k])]);
  return getGateway(gwEui);
}

/** Validate & normalise the credential-related fields of a create/update body. */
async function credentialFields(body, existing, gwEui) {
  const out = {};

  // --- CUPS client credentials -------------------------------------------
  const cupsCert = clean(body.cupsCertPem);
  const cupsKey = clean(body.cupsKeyPem);
  if (cupsCert || cupsKey) {
    if (!cupsCert || !cupsKey) throw new PkiError('cupsCertPem and cupsKeyPem must be given together');
    assertKeyMatchesCert(cupsCert, cupsKey);
    const ca = await getCa();
    if (ca && !isIssuedBy(cupsCert, ca.certPem)) {
      throw new PkiError('cupsCertPem is not signed by the configured CUPS CA — the TLS handshake would reject it');
    }
    Object.assign(out, { cups_cert_pem: cupsCert, cups_key_pem: cupsKey, cups_cert_generated: false });
  } else if (!existing && body.generateCupsCert !== false) {
    const { certPem, keyPem } = await issueGatewayCupsCert(gwEui);
    Object.assign(out, { cups_cert_pem: certPem, cups_key_pem: keyPem, cups_cert_generated: true });
  }
  if (out.cups_cert_pem) {
    const c = parseCert(out.cups_cert_pem);
    out.cups_cert_fingerprint = c.fingerprint256;
    out.cups_cert_not_after = new Date(c.validTo);
    // Keep the cert the gateway actually holds (the oldest not yet replaced on the device).
    if (existing?.cups_cert_fingerprint && existing.cups_cert_fingerprint !== c.fingerprint256 && !existing.cups_prev_cert_fingerprint) {
      out.cups_prev_cert_fingerprint = existing.cups_cert_fingerprint;
    }
  }

  // --- CUPS bootstrap credentials (Station cups-boot.*) ---------------------
  // Immutable on the device; the server always accepts this cert so the gateway can
  // recover when its regular and backup credentials fail. Key is optional (only
  // needed to produce the cups-boot.* files here).
  if (body.bootCertPem !== undefined) {
    const bootCert = clean(body.bootCertPem);
    const bootKey = clean(body.bootKeyPem);
    if (bootCert) {
      if (bootKey) assertKeyMatchesCert(bootCert, bootKey);
      const ca = await getCa();
      if (ca && !isIssuedBy(bootCert, ca.certPem)) throw new PkiError('bootCertPem is not signed by the configured CUPS CA');
      const c = parseCert(bootCert);
      Object.assign(out, { cups_boot_cert_pem: bootCert, cups_boot_key_pem: bootKey, cups_boot_cert_fingerprint: c.fingerprint256, cups_boot_cert_not_after: new Date(c.validTo) });
    } else {
      Object.assign(out, { cups_boot_cert_pem: null, cups_boot_key_pem: null, cups_boot_cert_fingerprint: null, cups_boot_cert_not_after: null });
    }
  } else if (!existing && body.generateBootCert === true) {
    Object.assign(out, await bootCertColumns(gwEui));
  }

  // --- LNS (TC) credentials ----------------------------------------------
  if (body.tcTrustPem !== undefined) {
    const t = clean(body.tcTrustPem);
    if (t) parseCert(t);
    out.tc_trust_pem = t;
  }
  const tcCert = body.tcCertPem !== undefined ? clean(body.tcCertPem) : undefined;
  const tcKey = body.tcKeyPem !== undefined ? clean(body.tcKeyPem) : undefined;
  if (tcCert !== undefined || tcKey !== undefined) {
    const cert = tcCert !== undefined ? tcCert : existing?.tc_cert_pem;
    const key = tcKey !== undefined ? tcKey : existing?.tc_key_pem;
    if (cert && !key) throw new PkiError('tcKeyPem is required with tcCertPem');
    if (cert) assertKeyMatchesCert(cert, key);
    out.tc_cert_pem = cert || null;
    out.tc_key_pem = cert ? key : null;
    out.tc_cert_not_after = cert ? new Date(parseCert(cert).validTo) : null;
  }
  if (body.tcToken !== undefined) {
    const tok = typeof body.tcToken === 'string' ? body.tcToken.trim() : '';
    if (/[\r\n]/.test(tok)) throw new PkiError('tcToken must be a single line');
    out.tc_token = tok || null;
  }
  return out;
}

function plainFields(body) {
  const out = {};
  if (body.name !== undefined) out.name = String(body.name).slice(0, 200);
  if (body.description !== undefined) out.description = String(body.description).slice(0, 2000);
  if (body.cupsUri !== undefined) out.cups_uri = body.cupsUri ? parseUrl(body.cupsUri, ['https:'], 'cupsUri') : null;
  if (body.tcUri !== undefined) out.tc_uri = body.tcUri ? parseUrl(body.tcUri, ['wss:', 'ws:'], 'tcUri') : null;
  return out;
}

export async function createGateway(body) {
  if (!body?.eui) throw new PkiError('eui is required');
  const gwEui = eui(body.eui);
  const exists = await query('SELECT 1 FROM gateways WHERE eui = $1', [gwEui]);
  if (exists.rowCount) {
    const e = new PkiError(`Gateway ${formatEui(gwEui)} already exists`);
    e.status = 409;
    throw e;
  }
  const fields = { eui: gwEui, ...plainFields(body), ...(await credentialFields(body, null, gwEui)) };
  const cols = Object.keys(fields);
  await query(
    `INSERT INTO gateways (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => fields[c]),
  );
  return getGateway(gwEui);
}

export async function updateGateway(euiParam, body) {
  const gwEui = eui(euiParam);
  const existing = await getGatewayRow(gwEui);
  const fields = { ...plainFields(body), ...(await credentialFields(body, existing, gwEui)) };
  const cols = Object.keys(fields);
  if (cols.length) {
    await query(
      `UPDATE gateways SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE eui = $1`,
      [gwEui, ...cols.map((c) => fields[c])],
    );
  }
  return getGateway(gwEui);
}

export async function renewCupsCert(euiParam) {
  const gwEui = eui(euiParam);
  const row = await getGatewayRow(gwEui);
  const { certPem, keyPem } = await issueGatewayCupsCert(gwEui);
  const c = parseCert(certPem);
  // The gateway still holds the old cert: accept it until it has fetched the new one over CUPS.
  await query(
    `UPDATE gateways SET cups_cert_pem = $2, cups_key_pem = $3, cups_cert_fingerprint = $4,
       cups_cert_not_after = $5, cups_cert_generated = true,
       cups_prev_cert_fingerprint = coalesce(cups_prev_cert_fingerprint, $6), updated_at = now() WHERE eui = $1`,
    [gwEui, certPem, keyPem, c.fingerprint256, new Date(c.validTo), row.cups_cert_fingerprint],
  );
  return getGateway(gwEui);
}

export async function deleteGateway(euiParam) {
  const gwEui = eui(euiParam);
  const r = await query('DELETE FROM gateways WHERE eui = $1', [gwEui]);
  if (!r.rowCount) throw new NotFound(`Gateway ${formatEui(gwEui)} not found`);
}

export async function getGatewayRow(gwEui) {
  const { rows } = await query('SELECT * FROM gateways WHERE eui = $1', [gwEui]);
  if (!rows.length) throw new NotFound(`Gateway ${formatEui(gwEui)} not found`);
  return rows[0];
}

export async function findGateway(gwEui) {
  const { rows } = await query('SELECT * FROM gateways WHERE eui = $1', [gwEui]);
  return rows[0] || null;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

function summary(row) {
  const expiries = [row.cups_cert_not_after, row.tc_cert_not_after, row.cups_boot_cert_not_after].filter(Boolean).map((d) => new Date(d));
  const next = expiries.length ? new Date(Math.min(...expiries)) : null;
  return {
    eui: row.eui,
    euiFormatted: formatEui(row.eui),
    name: row.name,
    description: row.description,
    cupsUri: row.cups_uri,
    tcUri: row.tc_uri,
    tcAuth: row.tc_cert_pem ? 'certificate' : row.tc_token ? 'token' : 'none',
    cupsCertNotAfter: iso(row.cups_cert_not_after),
    tcCertNotAfter: iso(row.tc_cert_not_after),
    nextExpiry: iso(next),
    daysToExpiry: next ? Math.floor((next.getTime() - Date.now()) / 86_400_000) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastSeenAt: iso(row.last_seen_at),
    lastRemoteAddr: row.last_remote_addr,
    lastPackage: row.last_package,
    lastModel: row.last_model,
    lastStation: row.last_station,
    lastValid: row.last_valid,
    lastReason: row.last_reason,
  };
}

export async function listGateways() {
  const { rows } = await query('SELECT * FROM gateways ORDER BY name, eui');
  return rows.map(summary);
}

/** Full detail without private keys. */
export async function getGateway(euiParam) {
  const row = await getGatewayRow(eui(euiParam));
  const target = await targetState(row);
  return {
    ...summary(row),
    cupsCert: row.cups_cert_pem ? { pem: row.cups_cert_pem, generated: row.cups_cert_generated, ...certInfo(row.cups_cert_pem) } : null,
    tcTrust: row.tc_trust_pem ? { pem: row.tc_trust_pem, ...certInfo(row.tc_trust_pem) } : null,
    tcCert: row.tc_cert_pem ? { pem: row.tc_cert_pem, ...certInfo(row.tc_cert_pem) } : null,
    hasTcToken: Boolean(row.tc_token),
    cupsCertRotationPending: Boolean(row.cups_prev_cert_fingerprint),
    bootCert: row.cups_boot_cert_pem ? { pem: row.cups_boot_cert_pem, hasKey: Boolean(row.cups_boot_key_pem), ...certInfo(row.cups_boot_cert_pem) } : null,
    effective: {
      cupsUri: target.cupsUri,
      tcUri: target.tcUri,
      cupsCredCrc: target.cupsCred ? crc32(target.cupsCred) : null,
      tcCredCrc: target.tcCred ? crc32(target.tcCred) : null,
      tcTrustSource: row.tc_trust_pem ? 'gateway' : target.tcTrustFromSetup ? 'setup' : 'none',
    },
  };
}

/** Desired state of a gateway, as encoded into CUPS responses. */
export async function targetState(row) {
  const [general, ca] = await Promise.all([getGeneral(), getCa()]);
  const tcTrustPem = row.tc_trust_pem || general.lnsTrustPem || null;
  const tcUri = row.tc_uri || general.lnsUrl || null;
  return {
    cupsUri: row.cups_uri || general.cupsPublicUrl,
    tcUri,
    cupsCred: ca ? buildCredential({ trustPem: ca.certPem, certPem: row.cups_cert_pem, keyPem: row.cups_key_pem }) : null,
    // Only push LNS credentials once there is an LNS to talk to.
    tcCred: tcUri ? buildCredential({ trustPem: tcTrustPem, certPem: row.tc_cert_pem, keyPem: row.tc_key_pem, token: row.tc_token }) : null,
    tcTrustFromSetup: !row.tc_trust_pem && Boolean(general.lnsTrustPem),
  };
}

/** Files to put in the Station home dir for first contact with this CUPS server. */
export async function bootstrapFiles(euiParam) {
  const row = await getGatewayRow(eui(euiParam));
  const [general, ca] = await Promise.all([getGeneral(), getCa()]);
  if (!ca) throw new PkiError('No CUPS CA configured');
  const uri = (row.cups_uri || general.cupsPublicUrl) + '\n';
  const files = { 'cups.uri': uri, 'cups.trust': ca.certPem };
  if (row.cups_cert_pem) {
    files['cups.crt'] = row.cups_cert_pem;
    files['cups.key'] = row.cups_key_pem;
  }
  // Immutable fallback set, to be baked into the system image (Station never modifies it).
  if (row.cups_boot_cert_pem && row.cups_boot_key_pem) {
    Object.assign(files, { 'cups-boot.uri': uri, 'cups-boot.trust': ca.certPem, 'cups-boot.crt': row.cups_boot_cert_pem, 'cups-boot.key': row.cups_boot_key_pem });
  }
  return files;
}
