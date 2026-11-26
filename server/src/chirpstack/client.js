// ChirpStack v4 gRPC API client.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { normalizeEui } from '../cups/eui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = protoLoader.loadSync(path.join(here, 'gateway.proto'), {
  keepCase: false, longs: Number, enums: Number, defaults: true, oneofs: true,
});
const { GatewayService } = grpc.loadPackageDefinition(pkg).api;

export class ChirpStackError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const PAGE = 100;
const MAX_GATEWAYS = 10_000;
const TIMEOUT_MS = 15_000;

/** "host:port" (a leading http(s):// and trailing path are tolerated). */
export function parseServer(value) {
  const s = String(value ?? '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  if (!s) throw new ChirpStackError('server is required', 400);
  if (!/^(\[[0-9a-f:]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/i.test(s)) throw new ChirpStackError('server must be host:port', 400);
  return s;
}

const ts = (t) => (t && Number(t.seconds) ? new Date(Number(t.seconds) * 1000 + Math.floor(t.nanos / 1e6)).toISOString() : null);

const describeGrpc = (e) => {
  switch (e.code) {
    case grpc.status.UNAUTHENTICATED: return 'ChirpStack rejected the API key (unauthenticated)';
    case grpc.status.PERMISSION_DENIED: return 'ChirpStack denied access — does the API key belong to this tenant?';
    case grpc.status.UNAVAILABLE: return `Cannot reach ChirpStack (${e.details || 'unavailable'}) — check server address and TLS setting`;
    case grpc.status.DEADLINE_EXCEEDED: return 'ChirpStack request timed out';
    default: return `ChirpStack error: ${e.details || e.message}`;
  }
};

function listPage(client, md, req) {
  return new Promise((resolve, reject) => {
    client.List(req, md, { deadline: Date.now() + TIMEOUT_MS }, (err, res) => {
      if (err) return reject(new ChirpStackError(describeGrpc(err), err.code === grpc.status.UNAUTHENTICATED || err.code === grpc.status.PERMISSION_DENIED ? 400 : 502));
      resolve(res);
    });
  });
}

/** Lists all gateways of a tenant. cfg: {server, tls, tenantId, apiKey}. */
export async function listGateways({ server, tls, tenantId, apiKey }) {
  const creds = tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  const client = new GatewayService(parseServer(server), creds);
  const md = new grpc.Metadata();
  md.set('authorization', `Bearer ${apiKey}`);
  try {
    const out = [];
    for (let offset = 0; offset < MAX_GATEWAYS; offset += PAGE) {
      const res = await listPage(client, md, { limit: PAGE, offset, tenantId });
      for (const g of res.result) {
        let eui;
        try {
          eui = normalizeEui(g.gatewayId);
        } catch {
          continue; // not a valid EUI-64: cannot be a Station gateway
        }
        out.push({
          eui, gatewayId: g.gatewayId, name: g.name, description: g.description, tenantId: g.tenantId,
          lastSeenAt: ts(g.lastSeenAt), createdAt: ts(g.createdAt),
        });
      }
      if (offset + PAGE >= res.totalCount || !res.result.length) break;
    }
    return out;
  } finally {
    client.close();
  }
}

/** Issue credentials for a gateway belonging to the configured tenant. */
export async function generateClientCertificate(cfg, eui) {
  const gateway = (await listGateways(cfg)).find((g) => g.eui === eui);
  if (!gateway) throw new ChirpStackError('Gateway is not in the configured ChirpStack tenant', 400);
  const client = new GatewayService(parseServer(cfg.server), cfg.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure());
  const md = new grpc.Metadata();
  md.set('authorization', `Bearer ${cfg.apiKey}`);
  try {
    const result = await new Promise((resolve, reject) => {
      client.GenerateClientCertificate({ gatewayId: gateway.gatewayId }, md, { deadline: Date.now() + TIMEOUT_MS }, (err, res) => {
        if (err) return reject(new ChirpStackError(describeGrpc(err), err.code === grpc.status.UNAUTHENTICATED || err.code === grpc.status.PERMISSION_DENIED ? 400 : 502));
        resolve(res);
      });
    });
    if (!result.tlsCert || !result.tlsKey) throw new ChirpStackError('ChirpStack did not return a client certificate and key');
    return { certPem: result.tlsCert, keyPem: result.tlsKey };
  } finally {
    client.close();
  }
}
