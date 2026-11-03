import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fundingPlan } from './plans.js';
import { Rpc } from './network.js';
import { prepareFundingReview, externalSigningPayload, verifySignedWireBatch } from './transactions.js';
import { exactKeys, requireSafe, shortError } from './security.js';

const ASSETS = Object.freeze({ '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/wallet.js': ['wallet.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] });
async function jsonBody(req) {
  requireSafe(req.headers['content-type'] === 'application/json', 'JSON_REQUIRED');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; requireSafe(size <= 16384, 'REQUEST_TOO_LARGE'); chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { requireSafe(false, 'INVALID_JSON'); }
}
// Starts only when explicitly invoked. Bind address and API routes are fixed.
export async function startWalletServer({ port = 8787 } = {}) {
  requireSafe(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'INVALID_PORT');
  const assets = new Map(Object.entries(ASSETS).map(([url, [name, mime]]) => [url, { mime, bytes: readFileSync(new URL('../web/' + name, import.meta.url)) }]));
  const token = randomBytes(32).toString('hex');
  let origin, active = null, busy = false, revision = 0;
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    try {
      requireSafe(req.headers.host === new URL(origin).host, 'INVALID_HOST');
      requireSafe(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'CROSS_ORIGIN_REQUEST');
      if (req.method === 'GET' && assets.has(req.url)) {
        const asset = assets.get(req.url); res.writeHead(200, { 'content-type': asset.mime + '; charset=utf-8' }); res.end(asset.bytes); return;
      }
      requireSafe(req.method === 'POST' && ['/api/review', '/api/verify', '/api/cancel'].includes(req.url), 'ROUTE_NOT_ALLOWED');
      const supplied = req.headers['x-launcher-session'];
      requireSafe(req.headers.origin === origin && typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied)
        && timingSafeEqual(Buffer.from(token), Buffer.from(supplied)), 'SESSION_OR_ORIGIN_REJECTED');
      const body = await jsonBody(req);
      if (req.url === '/api/cancel') {
        exactKeys(body, []); revision++; active = null; respond(200, { cancelled: true }); return;
      }
      requireSafe(!busy, 'REQUEST_IN_PROGRESS'); busy = true;
      try {
        if (req.url === '/api/review') {
          active = null; const current = ++revision;
          exactKeys(body, ['payerAddress', 'destinationAddress', 'lamports']);
          const envelope = fundingPlan({ payerAddress: body.payerAddress, wallets: [{ id: 'wallet-test', address: body.destinationAddress, lamports: body.lamports }] });
          const context = await new Rpc().getBlockhashContext();
          const review = await prepareFundingReview(envelope, envelope.digest, context);
          const payload = externalSigningPayload(review, review.digest, body.payerAddress);
          requireSafe(current === revision, 'REVIEW_CANCELLED');
          active = review; respond(200, payload);
        } else {
          exactKeys(body, ['reviewDigest', 'signedTransactions']);
          const review = active; active = null; // One attempt, including failed decoding/validation.
          requireSafe(review && review.digest === body.reviewDigest, 'REVIEW_NOT_ACTIVE');
          const result = await verifySignedWireBatch(review, body.reviewDigest, body.signedTransactions);
          respond(200, { verified: true, productionVerified: result.productionVerified,
            fingerprints: result.transactions.map(tx => tx.fingerprint), broadcast: false });
        }
      } finally { busy = false; }
    } catch (error) { respond(400, { error: shortError(error) }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.timeout = 20000;
  server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return Object.freeze({ origin, url: `${origin}/#session=${token}`, async close() {
    active = null; server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireSafe(process.argv.length === 2, 'INVALID_ARGUMENTS');
  startWalletServer().then(instance => {
    console.log('Open this session URL in a desktop browser with a Wallet Standard extension:');
    console.log(instance.url);
    console.log('Devnet signature verification only. Nothing is broadcast. Keep the session URL private.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { instance.close().catch(() => {}); });
  }).catch(error => { console.error(shortError(error)); process.exitCode = 1; });
}
