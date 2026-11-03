import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startWalletServer } from '../src/wallet-server.js';

test('wallet server serves only local assets and protects all API calls with origin and session', async t => {
  const server = await startWalletServer({ port: 0 }); t.after(() => server.close());
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get('session');
  const home = await fetch(server.origin);
  assert.equal(home.status, 200); assert.match(await home.text(), /Connect, review, sign/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  for (const p of ['/package.json', '/src/vault.js', '/api/verify', '/app.js?x=1']) assert.equal((await fetch(server.origin + p)).status, 400);
  const post = (body, headers = {}) => fetch(server.origin + '/api/cancel', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({}, { origin: 'https://evil.example', 'x-launcher-session': token })).status, 400);
  assert.equal((await post({}, { origin: server.origin, 'x-launcher-session': '0'.repeat(64) })).status, 400);
  const headers = { origin: server.origin, 'x-launcher-session': token };
  assert.deepEqual(await (await post({}, headers)).json(), { cancelled: true });
  const invalid = await fetch(server.origin + '/api/review', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ privateKey: 'do-not-forward' }) });
  assert.deepEqual(await invalid.json(), { error: 'INVALID_FIELDS' });
  const verify = await fetch(server.origin + '/api/verify', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ reviewDigest: '0'.repeat(64), signedTransactions: [] }) });
  assert.deepEqual(await verify.json(), { error: 'REVIEW_NOT_ACTIVE' });
  assert.equal(verify.headers.get('access-control-allow-origin'), null);
});
test('wallet server rejects DNS-rebinding hosts, cross-site requests and bad input without RPC access', async t => {
  const server = await startWalletServer({ port: 0 }); t.after(() => server.close());
  const rebound = await new Promise((resolve, reject) => {
    const req = http.get(server.origin, { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(rebound, 400);
  assert.equal((await fetch(server.origin, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 400);
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get('session');
  for (const body of ['not-json', JSON.stringify({ payerAddress: 'invalid', destinationAddress: 'invalid', lamports: '1' })]) {
    const res = await fetch(server.origin + '/api/review', { method: 'POST', headers: { origin: server.origin, 'x-launcher-session': token, 'content-type': 'application/json' }, body });
    assert.equal(res.status, 400); assert.ok(['INVALID_JSON', 'INVALID_ADDRESS'].includes((await res.json()).error));
  }
});
