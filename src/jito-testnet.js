import { checkBundleStatus } from './bundle-status.js';
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compileTransaction, getBase64EncodedWireTransaction, getSignatureFromTransaction, getTransactionDecoder } from '@solana/kit';
import { Rpc } from './network.js';
import { networkProfile } from './network-profiles.js';
import { PrivateDirectory } from './private-directory.js';
import { bounded, message, transferInstruction } from './transactions.js';
import { verifyAndMergeWireSignatures } from './create-verification.js';
import { digest, equalDigest, exactKeys, frozenJson, raw, requireSafe, validAddress } from './security.js';

const ENGINE = 'https://testnet.block-engine.jito.wtf/api/v1/';
const MAX_PAYMENT = 100000n;
const MAX_TIP = 10000n;
const RESERVE = 10000000n;
const MAX_TOTAL_DEBIT = 300000n;

async function engine(method, params) {
  const endpoint = method === 'getTipAccounts' ? 'getTipAccounts' : 'bundles';
  const response = await fetch(ENGINE + endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  requireSafe(response.ok && response.body, 'JITO_RPC_UNAVAILABLE');
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    requireSafe(size <= 65536, 'JITO_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requireSafe(payload?.jsonrpc === '2.0' && payload.id === 1 && !payload.error &&
    Object.hasOwn(payload, 'result'), 'JITO_RPC_REJECTED');
  return payload.result;
}

async function tipAccounts() {
  const accounts = await engine('getTipAccounts', []);
  requireSafe(Array.isArray(accounts) && accounts.length > 0 && accounts.length <= 32, 'JITO_TIP_ACCOUNTS_UNAVAILABLE');
  return accounts.map(validAddress);
}

function normalize(input) {
  exactKeys(input, ['payerAddress', 'payments', 'tipLamports']);
  const payerAddress = validAddress(input.payerAddress);
  requireSafe(Array.isArray(input.payments) && input.payments.length === 2, 'TWO_TESTNET_PAYMENTS_REQUIRED');
  const payments = input.payments.map(payment => {
    exactKeys(payment, ['destinationAddress', 'lamports']);
    const destinationAddress = validAddress(payment.destinationAddress);
    requireSafe(destinationAddress !== payerAddress && raw(payment.lamports) <= MAX_PAYMENT, 'INVALID_TESTNET_PAYMENT');
    return { destinationAddress, lamports: payment.lamports };
  });
  const tip = raw(input.tipLamports);
  requireSafe(tip >= 1000n && tip <= MAX_TIP, 'TESTNET_TIP_OUTSIDE_LIMITS');
  return { payerAddress, payments, tipLamports: String(tip) };
}

function compile(plan) {
  const lifetime = { blockhash: validAddress(plan.blockhash), lastValidBlockHeight: raw(plan.lastValidBlockHeight) };
  return plan.payments.map((payment, index) => {
    const instructions = [transferInstruction(plan.payerAddress, payment.destinationAddress, payment.lamports)];
    if (index === 1) instructions.push(transferInstruction(plan.payerAddress, plan.tipAddress, plan.tipLamports));
    return bounded(compileTransaction(message(plan.payerAddress, lifetime, instructions)));
  });
}

async function checkBudget(rpc, plan, txs) {
  const fees = await Promise.all(txs.map(tx => rpc.read('getFeeForMessage',
    [Buffer.from(tx.messageBytes).toString('base64'), { commitment: 'confirmed' }])));
  const balance = await rpc.read('getBalance', [plan.payerAddress]);
  requireSafe([...fees, balance].every(result => Number.isSafeInteger(result?.value) && result.value >= 0),
    'TESTNET_BUDGET_EVIDENCE_UNAVAILABLE');
  const debit = plan.payments.reduce((total, payment) => total + BigInt(payment.lamports), BigInt(plan.tipLamports))
    + fees.reduce((total, fee) => total + BigInt(fee.value), 0n);
  requireSafe(debit <= MAX_TOTAL_DEBIT && BigInt(balance.value) >= debit + RESERVE, 'TESTNET_BUDGET_OUTSIDE_LIMITS');
  return { feeLamports: fees.map(fee => String(fee.value)), totalDebitLamports: String(debit) };
}

export async function prepareJitoTestnetBundle(input) {
  const normalized = normalize(input);
  const rpc = new Rpc({ profile: 'testnet' });
  const genesis = await rpc.verifyCluster();
  const recipients = new Set([normalized.payerAddress, ...normalized.payments.map(payment => payment.destinationAddress)]);
  const tipAddress = (await tipAccounts()).find(address => !recipients.has(address));
  requireSafe(tipAddress, 'JITO_TIP_ACCOUNT_UNAVAILABLE');
  const { value } = await rpc.read('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  requireSafe(Number.isSafeInteger(value?.lastValidBlockHeight) && value.lastValidBlockHeight > 0, 'INVALID_BLOCKHASH_LIFETIME');
  const plan = { ...normalized, cluster: 'testnet', genesis, tipAddress,
    blockhash: validAddress(value.blockhash), lastValidBlockHeight: String(value.lastValidBlockHeight),
    expiresAt: Date.now() + 60000 };
  const txs = compile(plan);
  const review = { plan, budget: await checkBudget(rpc, plan, txs),
    unsignedTransactions: txs.map(getBase64EncodedWireTransaction) };
  return frozenJson({ review, digest: digest(review) });
}

function writeEvent(directory, name, payload) {
  directory.assert();
  const fd = openSync(path.join(directory.root, name), constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(payload, null, 2) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const root = openSync(directory.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(root); } finally { closeSync(root); }
}

export async function submitJitoTestnetBundle(envelope, confirmation, signedWires, journalRoot) {
  const approved = frozenJson(envelope);
  exactKeys(approved, ['review', 'digest']);
  requireSafe(equalDigest(confirmation, approved.digest) && equalDigest(confirmation, digest(approved.review)),
    'JITO_REVIEW_NOT_APPROVED');
  const { review } = approved;
  exactKeys(review, ['plan', 'budget', 'unsignedTransactions']);
  const plan = review.plan;
  exactKeys(plan, ['payerAddress', 'payments', 'tipLamports', 'cluster', 'genesis', 'tipAddress',
    'blockhash', 'lastValidBlockHeight', 'expiresAt']);
  normalize({ payerAddress: plan.payerAddress, payments: plan.payments, tipLamports: plan.tipLamports });
  requireSafe(plan.cluster === 'testnet' && plan.genesis === networkProfile('testnet').genesis &&
    Number.isSafeInteger(plan.expiresAt) && Date.now() < plan.expiresAt && plan.expiresAt <= Date.now() + 60000,
  'JITO_TESTNET_REVIEW_EXPIRED_OR_INVALID');
  requireSafe(Array.isArray(signedWires) && signedWires.length === 2, 'JITO_TWO_SIGNATURES_REQUIRED');
  const txs = compile(plan);
  const unsigned = txs.map(getBase64EncodedWireTransaction);
  requireSafe(JSON.stringify(unsigned) === JSON.stringify(review.unsignedTransactions), 'JITO_REVIEW_MESSAGE_CHANGED');
  const signed = await Promise.all(unsigned.map((wire, index) =>
    verifyAndMergeWireSignatures(wire, [plan.payerAddress], [signedWires[index]], 'JITO_SIGNATURE_MISSING')));
  const rpc = new Rpc({ profile: 'testnet' });
  await rpc.verifyCluster();
  const currentTips = await tipAccounts();
  requireSafe(currentTips.includes(plan.tipAddress) && plan.tipAddress !== plan.payerAddress &&
    plan.payments.every(payment => payment.destinationAddress !== plan.tipAddress), 'JITO_TIP_ACCOUNT_CHANGED');
  const validity = await rpc.read('isBlockhashValid', [plan.blockhash, { commitment: 'confirmed' }]);
  requireSafe(validity?.value === true, 'JITO_TESTNET_BLOCKHASH_EXPIRED');
  const budget = await checkBudget(rpc, plan, txs);
  requireSafe(equalDigest(digest(budget), digest(review.budget)), 'JITO_BUDGET_CHANGED');
  requireSafe(Date.now() < plan.expiresAt, 'JITO_TESTNET_REVIEW_EXPIRED_OR_INVALID');
  const repo = path.resolve(import.meta.dirname, '..');
  requireSafe(path.resolve(journalRoot) !== repo && !path.resolve(journalRoot).startsWith(repo + path.sep),
    'JITO_JOURNAL_MUST_BE_OUTSIDE_REPOSITORY');
  const directory = new PrivateDirectory(journalRoot);
  const signatures = signed.map(wire => getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(wire, 'base64'))));
  // Key the attempt by the signed transactions, so editing a review cannot bypass replay protection.
  const attemptId = digest(signatures);
  const receipt = { cluster: 'testnet', attemptId, reviewDigest: approved.digest, signatures,
    lastValidBlockHeight: plan.lastValidBlockHeight };
  writeEvent(directory, attemptId + '.attempt.json', receipt);
  const bundleId = await engine('sendBundle', [signed, { encoding: 'base64' }]);
  requireSafe(typeof bundleId === 'string' && /^[a-f0-9]{64}$/.test(bundleId), 'JITO_ACKNOWLEDGEMENT_UNCERTAIN');
  const accepted = { ...receipt, bundleId, state: 'accepted-by-block-engine' };
  writeEvent(directory, attemptId + '.accepted.json', accepted);
  return frozenJson(accepted);
}

export async function inspectJitoTestnetBundle(bundleId) {
  requireSafe(typeof bundleId === 'string' && /^[a-f0-9]{64}$/.test(bundleId), 'INVALID_JITO_BUNDLE_ID');
  const result = await engine('getBundleStatuses', [[bundleId]]);
  requireSafe(Array.isArray(result?.value) && result.value.length <= 1, 'INVALID_JITO_STATUS_RESPONSE');
  const status = result.value[0];
  requireSafe(!status || status.bundle_id === bundleId, 'JITO_STATUS_ID_MISMATCH');
  return frozenJson({ cluster: 'testnet', bundleId, status: status ?? null });
}

export async function recoverJitoTestnetAttempt(receipt) {
  exactKeys(receipt, ['cluster', 'attemptId', 'reviewDigest', 'signatures', 'lastValidBlockHeight']);
  requireSafe(receipt.cluster === 'testnet' && equalDigest(receipt.attemptId, digest(receipt.signatures)),
    'INVALID_TESTNET_ATTEMPT_RECEIPT');
  const result = await checkBundleStatus({
    digest: receipt.reviewDigest, signatures: receipt.signatures, lastValidBlockHeight: receipt.lastValidBlockHeight,
  }, new Rpc({ profile: 'testnet' }));
  return frozenJson({ ...result, cluster: 'testnet' });
}
