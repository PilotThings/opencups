// CUPS protocol encoding — a port of basicstation/pysys/tcutils.py (class Cups).
// See https://doc.sm.tc/station/cupsproto.html
//
// Response body layout (all little-endian):
//   u8  cupsUriLen  + cupsUri
//   u8  tcUriLen    + tcUri
//   u16 cupsCredLen + cupsCred
//   u16 tcCredLen   + tcCred
//   u32 sigLen      + (u32 keyCRC + sig)
//   u32 updLen      + upd
//
// A credential set is trust + cert + key, each DER encoded (or 4 zero bytes
// when absent). When there is no client cert the key slot carries an ASCII
// auth token terminated by CRLF (e.g. "Authorization: Bearer ...\r\n").
// Station identifies credential sets by their CRC32, so the encoding must be
// byte-for-byte reproducible.

import zlib from 'node:zlib';

const ABSENT = Buffer.alloc(4);

// Same normalisation as Cups.PEM_REX / normalizePEM in the Python example.
const PEM_REX = /-+BEGIN ([^-]+)-+\s*\r?\n((?:[0-9A-Za-z+/= ]+\s*\r?\n)+)-+END \1-+\s*\r?\n?/g;

/** All PEM blocks in text: [{label, der}] */
export function pemBlocks(text) {
  if (!text) return [];
  const src = text.endsWith('\n') ? text : text + '\n';
  const out = [];
  for (const m of src.matchAll(PEM_REX)) {
    out.push({ label: m[1].trim(), der: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') });
  }
  return out;
}

/** DER of the first PEM block whose label matches, or 4 zero bytes. */
export function pemToDer(text, labelMatch) {
  const block = pemBlocks(text).find((b) => labelMatch.test(b.label));
  return block ? block.der : ABSENT;
}

const CERT = /CERTIFICATE$/;
const KEY = /PRIVATE KEY$/;

export function tokenBytes(token) {
  if (!token || !token.trim()) return ABSENT;
  return Buffer.from(token.trim() + '\r\n', 'ascii');
}

/** trust + cert + key (or token) — exactly like readCupsCred / readTcCred. */
export function buildCredential({ trustPem, certPem, keyPem, token }) {
  const trust = pemToDer(trustPem, CERT);
  const cert = pemToDer(certPem, CERT);
  const key = cert === ABSENT ? tokenBytes(token) : pemToDer(keyPem, KEY);
  return Buffer.concat([trust, cert, key]);
}

export const crc32 = (buf) => zlib.crc32(buf) >>> 0;

function encodeUri(reqUri, cfgUri) {
  if (!cfgUri || reqUri === cfgUri) return Buffer.from([0]);
  const s = Buffer.from(cfgUri, 'ascii');
  if (s.length > 255) throw new Error(`URI too long: ${cfgUri}`);
  return Buffer.concat([Buffer.from([s.length]), s]);
}

function encodeCred(reqCrc, cred, force = false) {
  if (!cred || (!force && Number(reqCrc) === crc32(cred))) return Buffer.alloc(2);
  if (cred.length > 0xffff) throw new Error('Credential set too large');
  const len = Buffer.alloc(2);
  len.writeUInt16LE(cred.length);
  return Buffer.concat([len, cred]);
}

/**
 * Build the binary /update-info response.
 *
 * @param req    Station request JSON ({cupsUri, tcUri, cupsCredCrc, tcCredCrc, package, keys})
 * @param target Desired state: {cupsUri, tcUri, cupsCred: Buffer|null, tcCred: Buffer|null}
 * @param opts   {forceCupsCred}: send cupsCred even if the reported CRC matches — used when the
 *               gateway authenticated with backup/bootstrap creds, where the reported CRC may not
 *               describe the set it is actually running on.
 * @returns {{body: Buffer, updates: string[]}}
 */
export function encodeUpdateInfo(req, target, { forceCupsCred = false } = {}) {
  const parts = {
    cupsUri: encodeUri(req.cupsUri, target.cupsUri),
    tcUri: encodeUri(req.tcUri, target.tcUri),
    cupsCred: encodeCred(req.cupsCredCrc, target.cupsCred, forceCupsCred),
    tcCred: encodeCred(req.tcCredCrc, target.tcCred),
    // Firmware updates are not served: empty signature and update segments.
    sig: Buffer.alloc(4),
    fw: Buffer.alloc(4),
  };
  const updates = [];
  if (parts.cupsUri.length > 1) updates.push('cupsUri');
  if (parts.tcUri.length > 1) updates.push('tcUri');
  if (parts.cupsCred.length > 2) updates.push('cupsCred');
  if (parts.tcCred.length > 2) updates.push('tcCred');
  const body = Buffer.concat([parts.cupsUri, parts.tcUri, parts.cupsCred, parts.tcCred, parts.sig, parts.fw]);
  return { body, updates };
}
