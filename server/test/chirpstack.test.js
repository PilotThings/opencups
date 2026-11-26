import test from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { generateClientCertificate, parseServer } from '../src/chirpstack/client.js';

test('parseServer normalises host:port', () => {
  assert.equal(parseServer('cs.example.com:8080'), 'cs.example.com:8080');
  assert.equal(parseServer(' https://cs.example.com:443/ '), 'cs.example.com:443');
  assert.equal(parseServer('[::1]:8080'), '[::1]:8080');
  assert.throws(() => parseServer(''), /required/);
  assert.throws(() => parseServer('bad host:1'), /host:port/);
});

test('generates credentials only for a gateway in the configured tenant', async (t) => {
  const definition = protoLoader.loadSync(fileURLToPath(new URL('../src/chirpstack/gateway.proto', import.meta.url)), { defaults: true });
  const service = grpc.loadPackageDefinition(definition).api.GatewayService.service;
  const server = new grpc.Server();
  let calls = 0;
  server.addService(service, {
    List(call, callback) {
      assert.equal(call.request.tenantId, 'tenant');
      callback(null, { totalCount: 1, result: [{ gatewayId: '0123456789abcdef', name: 'Gateway' }] });
    },
    GenerateClientCertificate(call, callback) {
      calls += 1;
      assert.equal(call.request.gatewayId, '0123456789abcdef');
      assert.equal(call.metadata.get('authorization')[0], 'Bearer secret');
      callback(null, { tlsCert: 'certificate', tlsKey: 'private key', caCert: 'issuer' });
    },
  });
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, value) => err ? reject(err) : resolve(value)));
  t.after(() => server.forceShutdown());
  const cfg = { server: `127.0.0.1:${port}`, tls: false, tenantId: 'tenant', apiKey: 'secret' };
  assert.deepEqual(await generateClientCertificate(cfg, '0123456789ABCDEF'), { certPem: 'certificate', keyPem: 'private key' });
  await assert.rejects(generateClientCertificate(cfg, '1111111111111111'), /not in the configured ChirpStack tenant/);
  assert.equal(calls, 1);
});
