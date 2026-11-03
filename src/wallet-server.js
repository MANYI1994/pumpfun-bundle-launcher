import { inspectCreatedMint } from './creation-outcome.js';
import { reviewTokenCreation } from './create-token.js';
import { simulateVerifiedTrade } from './buy-simulation.js';
import { PANEL_ROUTES, launcherPanel } from './launcher-panel.js';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, collectionPlan, fundingPlan } from './plans.js';
import { ExecutionJournal } from './journal.js';
import { NativeTransferExecutor } from './executor.js';
import { Rpc, assertDevnetContext } from './network.js';
import { prepareCreationExecution, prepareBuySigningReview, prepareSellSigningReview, prepareCleanupSigningReview, prepareFundingReview, prepareCollectionReview, externalSigningPayload, verifySignedWireBatch } from './transactions.js';
import { exactKeys, raw, requireSafe, shortError } from './security.js';

const ASSETS = Object.freeze({ '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/wallet.js': ['wallet.js', 'text/javascript'], '/launcher-panel.js': ['launcher-panel.js', 'text/javascript'], '/watchlist.js': ['watchlist.js', 'text/javascript'], '/metadata-package.js': ['metadata-package.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] });
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
export async function startWalletServer({ port = 8787, journalRoot } = {}) {
  requireSafe(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'INVALID_PORT');
  const assets = new Map(Object.entries(ASSETS).map(([url, [name, mime]]) => [url, { mime, bytes: readFileSync(new URL('../web/' + name, import.meta.url)) }]));
  const journal = journalRoot === undefined ? null : new ExecutionJournal(journalRoot);
  const executor = journal ? new NativeTransferExecutor(journal) : null;
  const token = randomBytes(32).toString('hex');
  let origin, active = null, verified = null, ticket = null, operationId = null, busy = false, revision = 0;
  let pendingCreation;
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
      requireSafe(req.method === 'POST' && ['/api/create-review', '/api/create-simulate', '/api/review', '/api/collection-review', '/api/batch-funding-review', '/api/buy-signing-review', '/api/sell-signing-review', '/api/cleanup-signing-review', '/api/verify', '/api/cancel', '/api/mode', '/api/simulate', '/api/submit', '/api/recover', '/api/operations', ...PANEL_ROUTES].includes(req.url), 'ROUTE_NOT_ALLOWED');
      const supplied = req.headers['x-launcher-session'];
      requireSafe(req.headers.origin === origin && typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied)
        && timingSafeEqual(Buffer.from(token), Buffer.from(supplied)), 'SESSION_OR_ORIGIN_REJECTED');
      const body = await jsonBody(req);
      if (req.url === '/api/mode') { exactKeys(body, []); respond(200, { executionEnabled: Boolean(executor), cluster: 'devnet' }); return; }
      if (req.url === '/api/cancel') {
        exactKeys(body, []); revision++; active = null; verified = null; ticket = null;
        if (operationId && executor) { try { await executor.recover(operationId); } catch { /* Durable record remains available for recovery. */ } }
        respond(200, { cancelled: true }); return;
      }
      requireSafe(!busy, 'REQUEST_IN_PROGRESS'); busy = true;
      try {
        if (req.url === '/api/create-review') {
          requireSafe(!ticket, 'EXISTING_EXECUTION_REQUIRES_RECOVERY');
          exactKeys(body, ['metadata', 'metadataUri', 'mintAddress', 'creatorAddress', 'maxDebitLamports']);
          const { maxDebitLamports, ...input } = body;
          requireSafe(raw(maxDebitLamports) <= LIMITS.maxSpendLamports, 'TOTAL_DEBIT_LIMIT_EXCEEDED');
          pendingCreation = undefined;
          const context = await new Rpc().getBlockhashContext();
          const envelope = await reviewTokenCreation(input, assertDevnetContext(context));
          assertDevnetContext(context);
          pendingCreation = { envelope, context, maxDebitLamports };
          respond(200, { ...envelope, expiresAt: context.expiresAt });
        } else if (req.url === '/api/create-simulate') {
          requireSafe(!ticket, 'EXISTING_EXECUTION_REQUIRES_RECOVERY');
          exactKeys(body, ['confirmation', 'signedWires']);
          const creation = pendingCreation;
          requireSafe(creation && body.confirmation === creation.envelope.digest, 'CREATION_REVIEW_NOT_ACTIVE');
          pendingCreation = undefined;
          active = null; verified = null;
          const current = ++revision;
          const { review, result } = await prepareCreationExecution(
            creation.envelope, creation.context, creation.maxDebitLamports, body.signedWires);
          const simulation = await simulateVerifiedTrade(review, result);
          requireSafe(current === revision, 'REVIEW_CANCELLED');
          verified = executor ? result : null;
          operationId = review.details.plan.id;
          respond(200, { ...simulation, plan: review.details.plan, executionEnabled: Boolean(executor),
            executionDigest: result.executionDigest, operationId });
        } else if (PANEL_ROUTES.includes(req.url)) {
          respond(200, await launcherPanel(req.url, body));
        } else if (['/api/review', '/api/collection-review', '/api/batch-funding-review'].includes(req.url)) {
          requireSafe(!ticket, 'EXISTING_EXECUTION_REQUIRES_RECOVERY');
          active = null; verified = null; const current = ++revision;
          const collecting = req.url === '/api/collection-review';
          const batch = req.url === '/api/batch-funding-review';
          exactKeys(body, batch ? ['payerAddress', 'wallets'] : ['payerAddress', 'destinationAddress', 'lamports']);
          const envelope = collecting
            ? collectionPlan({ destinationAddress: body.destinationAddress,
                wallets: [{ id: 'source-wallet', address: body.payerAddress, lamports: body.lamports }] })
            : fundingPlan({ payerAddress: body.payerAddress,
                wallets: batch ? body.wallets : [{ id: 'wallet-test', address: body.destinationAddress, lamports: body.lamports }] });
          const context = await new Rpc().getBlockhashContext();
          const prepareReview = collecting ? prepareCollectionReview : prepareFundingReview;
          const review = await prepareReview(envelope, envelope.digest, context);
          const payload = externalSigningPayload(review, review.digest, body.payerAddress);
          requireSafe(current === revision, 'REVIEW_CANCELLED');
          active = review; respond(200, payload);
        } else if (req.url === '/api/buy-signing-review') {
          requireSafe(!ticket, 'EXISTING_EXECUTION_REQUIRES_RECOVERY');
          active = null; verified = null; const current = ++revision;
          exactKeys(body, ['owner', 'mint', 'spendLamports', 'slippageBps', 'maxDebitLamports']);
          const { maxDebitLamports, ...input } = body;
          const review = await prepareBuySigningReview(input, maxDebitLamports);
          requireSafe(current === revision, 'REVIEW_CANCELLED');
          active = review;
          respond(200, externalSigningPayload(review, review.digest, input.owner));
        } else if (['/api/sell-signing-review', '/api/cleanup-signing-review'].includes(req.url)) {
          requireSafe(!ticket, 'EXISTING_EXECUTION_REQUIRES_RECOVERY');
          active = null; verified = null; const current = ++revision;
          const prepareReview = req.url === '/api/cleanup-signing-review' ? prepareCleanupSigningReview : prepareSellSigningReview;
          const review = await prepareReview(body);
          requireSafe(current === revision, 'REVIEW_CANCELLED');
          active = review;
          respond(200, externalSigningPayload(review, review.digest, body.owner));
        } else if (req.url === '/api/verify') {
          exactKeys(body, ['reviewDigest', 'signedTransactions']);
          const review = active; active = null; // One attempt, including failed decoding/validation.
          requireSafe(review && review.digest === body.reviewDigest, 'REVIEW_NOT_ACTIVE');
          const current = revision;
          const result = await verifySignedWireBatch(review, body.reviewDigest, body.signedTransactions);
          requireSafe(current === revision, 'REVIEW_CANCELLED');
          if (['buy', 'sell', 'cleanup'].includes(review.details.plan.action)) {
            const simulation = await simulateVerifiedTrade(review, result);
            requireSafe(current === revision, 'REVIEW_CANCELLED');
            verified = executor ? result : null;
            operationId = review.details.plan.id;
            respond(200, { ...simulation, executionEnabled: Boolean(executor),
              executionDigest: result.executionDigest, operationId });
            return;
          }
          verified = executor ? result : null; operationId = review.details.plan.id;
          respond(200, { verified: true, productionVerified: result.productionVerified,
            executionEnabled: Boolean(executor), executionDigest: result.executionDigest, operationId,
            fingerprints: result.transactions.map(tx => tx.fingerprint), broadcast: false });
        } else {
          requireSafe(executor, 'EXECUTION_MODE_DISABLED');
          if (req.url === '/api/operations') {
            exactKeys(body, []); respond(200, { operations: journal.list() });
          } else if (req.url === '/api/recover') {
            exactKeys(body, ['operationId']);
            const result = await executor.recover(body.operationId);
            if (result.state === 'abandoned-before-submission' && ticket?.id === body.operationId) ticket = null;
            const { intent } = journal.inspect(body.operationId);
            if (result.state === 'finalized' && intent.action === 'create') {
              try {
                const creation = await inspectCreatedMint(new Rpc(), intent.mintAddress, intent.payerAddress);
                respond(200, { ...result, creation });
              } catch (error) {
                respond(200, { ...result, creationInspectionError: shortError(error) });
              }
            } else respond(200, result);
          } else if (req.url === '/api/simulate') {
            exactKeys(body, ['executionDigest']);
            requireSafe(verified, 'NO_VERIFIED_EXECUTION');
            const batch = verified; verified = null; const current = revision;
            ticket = await executor.prepare(batch, body.executionDigest);
            if (current !== revision) { ticket = null; await executor.recover(operationId); requireSafe(false, 'EXECUTION_CANCELLED'); }
            respond(200, ticket);
          } else {
            exactKeys(body, ['executionDigest']);
            requireSafe(ticket, 'NO_EXECUTION_TICKET');
            const approved = ticket; ticket = null;
            respond(200, await executor.submit(approved, body.executionDigest));
          }
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
  const args = process.argv.slice(2);
  requireSafe(args.length === 0 || (args.length === 2 && args[0] === '--execution-state'), 'INVALID_ARGUMENTS');
  const journalRoot = args[1];
  startWalletServer({ journalRoot }).then(instance => {
    console.log('Open this session URL in a desktop browser with a Wallet Standard extension:');
    console.log(instance.url);
    console.log(journalRoot ? 'Devnet funding execution mode: explicit simulation and submission approval required. Keep the session URL private.' : 'Devnet signature verification only. Nothing is broadcast. Keep the session URL private.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { instance.close().catch(() => {}); });
  }).catch(error => { console.error(shortError(error)); process.exitCode = 1; });
}
