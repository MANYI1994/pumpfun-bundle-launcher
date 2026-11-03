import { NETWORK_PROFILES, networkProfile } from './network-profiles.js';
import { requireSafe, SafetyError, validAddress, canonical, frozenJson, raw } from './security.js';
const nativeFetch = globalThis.fetch.bind(globalThis);

export const DEVNET_GENESIS = NETWORK_PROFILES.devnet.genesis;
const MAINNET_READ_METHODS = new Set(['getGenesisHash', 'getBalance', 'getAccountInfo', 'getSignatureStatuses', 'getBlockHeight']);
const READ_METHODS = new Set(['getGenesisHash', 'getBalance', 'getAccountInfo', 'getSignatureStatuses', 'getLatestBlockhash', 'getFeeForMessage', 'getBlockHeight', 'isBlockhashValid', 'simulateTransaction']);
const issuedContexts = new WeakMap();
export function assertDevnetContext(context) {
  const issued = issuedContexts.get(context);
  requireSafe(issued && issued.production && context.cluster === 'devnet' && context.genesis === DEVNET_GENESIS && Date.now() >= context.observedAt && Date.now() < context.expiresAt, 'UNVERIFIED_OR_EXPIRED_BLOCKHASH_CONTEXT');
  return { blockhash: context.blockhash, lastValidBlockHeight: BigInt(context.lastValidBlockHeight) };
}
export async function fundingBudgetEvidence(context, payer, messageBase64) {
  assertDevnetContext(context);
  const { rpc } = issuedContexts.get(context);
  const fee = await rpc.read('getFeeForMessage', [messageBase64, { commitment: 'confirmed' }]);
  const balance = await rpc.read('getBalance', [payer]);
  requireSafe(Number.isSafeInteger(fee?.value) && fee.value >= 0 && Number.isSafeInteger(balance?.value) && balance.value >= 0, 'INVALID_FEE_OR_BALANCE_RESPONSE');
  assertDevnetContext(context);
  return { feeLamports: String(fee.value), balanceLamports: String(balance.value) };
}
function validateParams(method, params) {
  requireSafe(Array.isArray(params), 'INVALID_RPC_PARAMETERS');
  if (method === 'getGenesisHash') requireSafe(params.length === 0, 'INVALID_RPC_PARAMETERS');
  if (method === 'getBalance') { requireSafe(params.length === 1, 'INVALID_RPC_PARAMETERS'); validAddress(params[0]); }
  if (method === 'getLatestBlockhash') requireSafe(params.length === 1 && canonical(params[0]) === canonical({ commitment: 'confirmed' }), 'INVALID_RPC_PARAMETERS');
  if (method === 'getFeeForMessage') requireSafe(params.length === 2 && typeof params[0] === 'string' && params[0].length <= 1644 && Buffer.from(params[0], 'base64').toString('base64') === params[0] && canonical(params[1]) === canonical({ commitment: 'confirmed' }), 'INVALID_RPC_PARAMETERS');
  if (method === 'getBlockHeight') requireSafe(params.length === 1 && ['confirmed', 'finalized'].some(commitment => canonical(params[0]) === canonical({ commitment })), 'INVALID_RPC_PARAMETERS');
  if (method === 'isBlockhashValid') { requireSafe(params.length === 2 && canonical(params[1]) === canonical({ commitment: 'confirmed' }), 'INVALID_RPC_PARAMETERS'); validAddress(params[0]); }
  if (method === 'simulateTransaction') requireSafe(params.length === 2 && typeof params[0] === 'string' && params[0].length <= 1644 && Buffer.from(params[0], 'base64').length <= 1232 && Buffer.from(params[0], 'base64').toString('base64') === params[0] && canonical(params[1]) === canonical({ encoding: 'base64', commitment: 'confirmed', sigVerify: true, replaceRecentBlockhash: false }), 'INVALID_RPC_PARAMETERS');
  if (method === 'getAccountInfo') {
    requireSafe(params.length === 2, 'INVALID_RPC_PARAMETERS');
    const options = canonical(params[1]);
    const fullAccount = ['confirmed', 'finalized'].some(commitment => options === canonical({ encoding: 'base64', commitment }));
    const loaderHeader = options === canonical({
      encoding: 'base64', commitment: 'finalized', dataSlice: { offset: 0, length: 45 },
    });
    requireSafe(fullAccount || loaderHeader, 'INVALID_RPC_PARAMETERS');
    validAddress(params[0]);
  }
  if (method === 'getSignatureStatuses') requireSafe(params.length === 2 && Array.isArray(params[0]) && params[0].length > 0 && params[0].length <= 5 && params[0].every(s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s)) && canonical(params[1]) === canonical({ searchTransactionHistory: true }), 'INVALID_RPC_PARAMETERS');
}

export class Rpc {
  #url; #fetch; #production; #profile; #id = 0; #verified = false;
  constructor({ profile = 'devnet', url, fetchImpl } = {}) {
    this.#profile = networkProfile(profile);
    let endpoint;
    try { endpoint = new URL(url === undefined ? this.#profile.rpcUrl : url); }
    catch { throw new SafetyError('INVALID_RPC_ENDPOINT'); }
    requireSafe(endpoint.href === this.#profile.rpcUrl, 'RPC_ENDPOINT_NOT_ALLOWED');
    this.#url = endpoint.href;
    this.#production = fetchImpl === undefined;
    this.#fetch = fetchImpl === undefined ? nativeFetch : fetchImpl;
  }
  async #request(method, params) {
    const id = ++this.#id;
    let response;
    try { response = await this.#fetch(this.#url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }); }
    catch { throw new SafetyError('RPC_TRANSPORT_FAILED'); }
    requireSafe(response.ok && response.body, 'RPC_HTTP_ERROR');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > 1024 * 1024) { await response.body.cancel?.().catch(() => {}); throw new SafetyError('RPC_RESPONSE_TOO_LARGE'); } chunks.push(chunk); }
    let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SafetyError('RPC_INVALID_JSON'); }
    requireSafe(payload.jsonrpc === '2.0' && payload.id === id && !payload.error && Object.hasOwn(payload, 'result'), 'RPC_RESPONSE_REJECTED');
    return payload.result;
  }
  async verifyCluster() {
    const genesis = await this.#request('getGenesisHash', []);
    requireSafe(genesis === this.#profile.genesis, 'WRONG_CLUSTER');
    this.#verified = true;
    return genesis;
  }
  async read(method, params = []) {
    requireSafe(READ_METHODS.has(method) &&
      (this.#profile.executionEnabled || MAINNET_READ_METHODS.has(method)), 'RPC_METHOD_NOT_ALLOWED');
    const snapshot = frozenJson(params);
    validateParams(method, snapshot);
    if (!this.#verified) await this.verifyCluster();
    return this.#request(method, snapshot);
  }
  async account(pubkey, owner) {
    validAddress(pubkey); validAddress(owner);
    const result = await this.read('getAccountInfo', [pubkey, { encoding: 'base64', commitment: 'confirmed' }]);
    requireSafe(result && result.value && result.value.owner === owner && result.value.executable === false && Array.isArray(result.value.data) && result.value.data.length === 2 && result.value.data[1] === 'base64' && typeof result.value.data[0] === 'string' && Buffer.from(result.value.data[0], 'base64').toString('base64') === result.value.data[0], 'ACCOUNT_OWNER_OR_DATA_MISMATCH');
    return Buffer.from(result.value.data[0], 'base64');
  }
  async getBlockhashContext({ reviewLifetimeMs = 30000 } = {}) {
    requireSafe(this.#profile.executionEnabled, 'PROFILE_EXECUTION_DISABLED');
    requireSafe(Number.isSafeInteger(reviewLifetimeMs) && reviewLifetimeMs >= 1000 &&
      reviewLifetimeMs <= 60000, 'INVALID_REVIEW_LIFETIME');
    // Recheck cluster for each signing context, not just once per client lifetime.
    await this.verifyCluster();
    const result = await this.read('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    validAddress(result?.value?.blockhash);
    requireSafe(Number.isSafeInteger(result.value.lastValidBlockHeight) && result.value.lastValidBlockHeight > 0, 'INVALID_BLOCKHASH_LIFETIME');
    const now = Date.now();
    const context = frozenJson({ cluster: 'devnet', genesis: DEVNET_GENESIS, blockhash: result.value.blockhash, lastValidBlockHeight: String(result.value.lastValidBlockHeight), observedAt: now, expiresAt: now + reviewLifetimeMs });
    issuedContexts.set(context, { production: this.#production, rpc: this });
    return context;
  }
  async send() {
    // No environment variable or config switch bypasses protocol integration review.
    throw new SafetyError('BROADCAST_DISABLED_PENDING_PROTOCOL_INTEGRATION');
  }
}
