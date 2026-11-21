// Certificate handling: CA creation/import, leaf issuance, inspection.
import crypto, { webcrypto } from 'node:crypto';
import net from 'node:net';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto);

const DAY = 86_400_000;

export class PkiError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// ---- key helpers ----------------------------------------------------------

function keyObject(keyPem) {
  try {
    return crypto.createPrivateKey(keyPem);
  } catch (e) {
    throw new PkiError(`Cannot parse private key: ${e.message}`);
  }
}

const CURVES = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' };

/** WebCrypto algorithm matching a Node KeyObject. */
function algorithmFor(key) {
  if (key.asymmetricKeyType === 'ec') {
    const namedCurve = CURVES[key.asymmetricKeyDetails.namedCurve];
    if (!namedCurve) throw new PkiError(`Unsupported EC curve ${key.asymmetricKeyDetails.namedCurve}`);
    const hash = namedCurve === 'P-256' ? 'SHA-256' : 'SHA-384';
    return { name: 'ECDSA', namedCurve, hash };
  }
  if (key.asymmetricKeyType === 'rsa') {
    return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: key.asymmetricKeyDetails.modulusLength };
  }
  throw new PkiError(`Unsupported key type ${key.asymmetricKeyType}`);
}

async function toWebCrypto(key) {
  const alg = algorithmFor(key);
  const priv = await webcrypto.subtle.importKey('pkcs8', key.export({ type: 'pkcs8', format: 'der' }), alg, true, ['sign']);
  const pubObj = crypto.createPublicKey(key);
  const pub = await webcrypto.subtle.importKey('spki', pubObj.export({ type: 'spki', format: 'der' }), alg, true, ['verify']);
  return { alg, privateKey: priv, publicKey: pub };
}

function generateKey(keyType = 'ec-p256') {
  const key =
    keyType === 'rsa-2048'
      ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      : crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  // EC keys as SEC1 ("EC PRIVATE KEY") like `openssl ec`, RSA as PKCS#1 — both parse in mbedTLS.
  const keyPem = key.export({ type: key.asymmetricKeyType === 'ec' ? 'sec1' : 'pkcs1', format: 'pem' });
  return { key, keyPem };
}

const serial = () => {
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f; // positive
  return b.toString('hex');
};

const dnEscape = (s) => String(s).replace(/([,+"\\<>;=])/g, '\\$1');

// ---- inspection -----------------------------------------------------------

export function parseCert(certPem) {
  try {
    return new crypto.X509Certificate(certPem);
  } catch (e) {
    throw new PkiError(`Cannot parse certificate: ${e.message}`);
  }
}

/** JSON-friendly description of a certificate. */
export function certInfo(certPem) {
  if (!certPem) return null;
  const c = parseCert(certPem);
  const notAfter = new Date(c.validTo);
  return {
    subject: c.subject.replace(/\n/g, ', '),
    issuer: c.issuer.replace(/\n/g, ', '),
    serialNumber: c.serialNumber,
    notBefore: new Date(c.validFrom).toISOString(),
    notAfter: notAfter.toISOString(),
    daysLeft: Math.floor((notAfter.getTime() - Date.now()) / DAY),
    fingerprint256: c.fingerprint256,
    isCA: c.ca,
    keyType: c.publicKey.asymmetricKeyType + (c.publicKey.asymmetricKeyDetails?.namedCurve ? ` (${c.publicKey.asymmetricKeyDetails.namedCurve})` : c.publicKey.asymmetricKeyDetails?.modulusLength ? ` (${c.publicKey.asymmetricKeyDetails.modulusLength} bit)` : ''),
    subjectAltName: c.subjectAltName || null,
    selfSigned: c.subject === c.issuer,
  };
}

export function assertKeyMatchesCert(certPem, keyPem) {
  const cert = parseCert(certPem);
  if (!cert.checkPrivateKey(keyObject(keyPem))) {
    throw new PkiError('Private key does not match the certificate');
  }
}

export function isIssuedBy(certPem, caPem) {
  const cert = parseCert(certPem);
  const ca = parseCert(caPem);
  return cert.checkIssued(ca) && cert.verify(ca.publicKey);
}

// ---- CA -------------------------------------------------------------------

export function validateUploadedCa(certPem, keyPem) {
  const cert = parseCert(certPem);
  if (!cert.ca) throw new PkiError('Certificate is not a CA (basicConstraints CA:TRUE missing)');
  assertKeyMatchesCert(certPem, keyPem);
  if (new Date(cert.validTo) < new Date()) throw new PkiError('CA certificate has expired');
  algorithmFor(keyObject(keyPem)); // supported key type?
}

export async function createSelfSignedCa({ commonName = 'OpenCUPS Root CA', organization = 'OpenCUPS', validityDays = 3650, keyType = 'ec-p256' } = {}) {
  const { key, keyPem } = generateKey(keyType);
  const keys = await toWebCrypto(key);
  const now = new Date();
  const name = `CN=${dnEscape(commonName)}` + (organization ? `, O=${dnEscape(organization)}` : '');
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + validityDays * DAY),
    signingAlgorithm: keys.alg,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certPem: cert.toString('pem') + '\n', keyPem };
}

// ---- leaf certificates ----------------------------------------------------

/**
 * Issue a leaf certificate signed by the CA.
 * @param purpose 'server' | 'client'
 * @param hosts   SAN entries for server certs (DNS names or IPs)
 */
export async function issueCertificate({ caCertPem, caKeyPem, commonName, purpose, hosts = [], validityDays = 825, keyType }) {
  const caKey = keyObject(caKeyPem);
  const ca = await toWebCrypto(caKey);
  const caCert = new x509.X509Certificate(caCertPem);
  const leafType = keyType || (caKey.asymmetricKeyType === 'rsa' ? 'rsa-2048' : 'ec-p256');
  const { key, keyPem } = generateKey(leafType);
  const leaf = await toWebCrypto(key);

  const extensions = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(
      x509.KeyUsageFlags.digitalSignature | (key.asymmetricKeyType === 'rsa' ? x509.KeyUsageFlags.keyEncipherment : 0),
      true,
    ),
    new x509.ExtendedKeyUsageExtension([purpose === 'server' ? x509.ExtendedKeyUsage.serverAuth : x509.ExtendedKeyUsage.clientAuth]),
    await x509.SubjectKeyIdentifierExtension.create(leaf.publicKey),
    await x509.AuthorityKeyIdentifierExtension.create(caCert, false),
  ];
  if (hosts.length) {
    const names = [...new Set(hosts)].map((h) => ({ type: net.isIP(h) ? 'ip' : 'dns', value: h }));
    extensions.push(new x509.SubjectAlternativeNameExtension(names));
  }

  const now = new Date();
  const caNotAfter = new Date(new crypto.X509Certificate(caCertPem).validTo);
  const wanted = new Date(now.getTime() + validityDays * DAY);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${dnEscape(commonName)}`,
    issuer: caCert.subject,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: wanted < caNotAfter ? wanted : caNotAfter, // never outlive the CA
    signingAlgorithm: ca.alg,
    publicKey: leaf.publicKey,
    signingKey: ca.privateKey,
    extensions,
  });
  return { certPem: cert.toString('pem') + '\n', keyPem };
}
