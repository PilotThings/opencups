import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEui } from '../src/cups/eui.js';
import { buildCredential, crc32, encodeUpdateInfo, pemBlocks } from '../src/cups/protocol.js';
import { createSelfSignedCa, issueCertificate, isIssuedBy, certInfo } from '../src/pki.js';

test('normalizeEui accepts station id6 and EUI notations', () => {
  assert.equal(normalizeEui('b827:ebff:fe61:51b5'), 'B827EBFFFE6151B5');
  assert.equal(normalizeEui('::1'), '0000000000000001');
  assert.equal(normalizeEui('1::'), '0001000000000000');
  assert.equal(normalizeEui('a:b::c'), '000A000B0000000C');
  assert.equal(normalizeEui('B8-27-EB-FF-FE-61-51-B5'), 'B827EBFFFE6151B5');
  assert.equal(normalizeEui('b8:27:eb:ff:fe:61:51:b5'), 'B827EBFFFE6151B5');
  assert.equal(normalizeEui('b827ebfffe6151b5'), 'B827EBFFFE6151B5');
  assert.equal(normalizeEui('0x1'), '0000000000000001');
  assert.throws(() => normalizeEui('1:2:3:4:5'));
  assert.throws(() => normalizeEui('::1::'));
  assert.throws(() => normalizeEui('hello'));
});

test('empty credential set matches the CRC documented in the example', () => {
  // README: an empty set is 12 zero bytes -> CRC32 0x7BD5C66F
  const cred = buildCredential({});
  assert.equal(cred.length, 12);
  assert.equal(crc32(cred), 0x7bd5c66f);
});

test('token credentials end with CRLF in the key slot', () => {
  const cred = buildCredential({ token: '  Authorization: Bearer abc  ' });
  assert.deepEqual(cred.subarray(0, 8), Buffer.alloc(8));
  assert.equal(cred.subarray(8).toString('ascii'), 'Authorization: Bearer abc\r\n');
});

test('PEM parsing tolerates CRLF and trailing spaces, skips EC PARAMETERS', async () => {
  const ca = await createSelfSignedCa({ commonName: 'T' });
  const mangled = ca.certPem.replace(/\n/g, '  \r\n');
  assert.deepEqual(pemBlocks(mangled)[0].der, pemBlocks(ca.certPem)[0].der);
  const withParams = '-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n' + ca.keyPem;
  const a = buildCredential({ trustPem: ca.certPem, certPem: ca.certPem, keyPem: withParams });
  const b = buildCredential({ trustPem: ca.certPem, certPem: ca.certPem, keyPem: ca.keyPem });
  assert.deepEqual(a, b);
});

test('encodeUpdateInfo: in-sync gateway gets the 14 zero byte answer', () => {
  const cred = buildCredential({ token: 'x' });
  const { body, updates } = encodeUpdateInfo(
    { cupsUri: 'https://c:6040', tcUri: 'wss://t:6038', cupsCredCrc: crc32(cred), tcCredCrc: crc32(cred) },
    { cupsUri: 'https://c:6040', tcUri: 'wss://t:6038', cupsCred: cred, tcCred: cred },
  );
  assert.deepEqual(body, Buffer.alloc(14));
  assert.deepEqual(updates, []);
});

test('encodeUpdateInfo: segment layout', () => {
  const cred = buildCredential({ token: 'tok' });
  const { body, updates } = encodeUpdateInfo(
    { cupsUri: 'https://c:6040', tcUri: '', cupsCredCrc: crc32(cred), tcCredCrc: 0x7bd5c66f },
    { cupsUri: 'https://c:6040', tcUri: 'wss://t:6038', cupsCred: cred, tcCred: cred },
  );
  assert.deepEqual(updates, ['tcUri', 'tcCred']);
  let o = 0;
  assert.equal(body[o++], 0); // cupsUri unchanged
  const tl = body[o++];
  assert.equal(body.subarray(o, o + tl).toString(), 'wss://t:6038');
  o += tl;
  assert.equal(body.readUInt16LE(o), 0); o += 2; // cupsCred unchanged
  const cl = body.readUInt16LE(o); o += 2;
  assert.deepEqual(body.subarray(o, o + cl), cred); o += cl;
  assert.equal(body.readUInt32LE(o), 0); o += 4; // sig
  assert.equal(body.readUInt32LE(o), 0); o += 4; // fw
  assert.equal(o, body.length);
});

test('PKI: CA issues server and client certificates', async () => {
  for (const keyType of ['ec-p256', 'rsa-2048']) {
    const ca = await createSelfSignedCa({ commonName: 'Test CA', keyType, validityDays: 100 });
    assert.equal(certInfo(ca.certPem).isCA, true);
    const srv = await issueCertificate({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, commonName: 'cups.example.com', purpose: 'server', hosts: ['cups.example.com', '10.0.0.1'] });
    assert.ok(isIssuedBy(srv.certPem, ca.certPem));
    assert.match(certInfo(srv.certPem).subjectAltName, /DNS:cups.example.com, IP Address:10.0.0.1/);
    // leaf may not outlive the CA
    assert.ok(new Date(certInfo(srv.certPem).notAfter) <= new Date(certInfo(ca.certPem).notAfter));
  }
});

test('encodeUpdateInfo: forceCupsCred re-sends credentials even when the CRC matches', () => {
  const cred = buildCredential({ token: 'x' });
  const req = { cupsUri: 'u', tcUri: 't', cupsCredCrc: crc32(cred), tcCredCrc: crc32(cred) };
  const target = { cupsUri: 'u', tcUri: 't', cupsCred: cred, tcCred: cred };
  assert.deepEqual(encodeUpdateInfo(req, target).updates, []);
  assert.deepEqual(encodeUpdateInfo(req, target, { forceCupsCred: true }).updates, ['cupsCred']);
});
