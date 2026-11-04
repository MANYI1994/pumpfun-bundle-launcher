// Wallet Standard browser boundary. Key material stays in the external wallet.
const CHAIN = 'solana:devnet';
const SIGN = 'solana:signTransaction';
function check(ok, code) { if (!ok) throw new Error(code); }
export function fromBase64(value) {
  check(typeof value === 'string' && value.length <= 1644 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'INVALID_WIRE');
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  check(bytes.length > 0 && bytes.length <= 1232 && toBase64(bytes) === value, 'INVALID_WIRE');
  return bytes;
}
export function toBase64(bytes) { return btoa(String.fromCharCode(...bytes)); }
async function boundedWalletCall(action, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('WALLET_REQUEST_TIMED_OUT')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
function messageOfWire(wire, signerCount) {
  const offset = 1 + 64 * signerCount;
  check(wire.length > offset && wire[0] === signerCount, 'INVALID_WIRE');
  return wire.subarray(offset);
}
function sameBytes(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
function accountSupported(account) {
  return account && typeof account.address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(account.address)
    && account.publicKey instanceof Uint8Array && account.publicKey.length === 32
    && account.chains?.includes(CHAIN) && account.features?.includes(SIGN);
}
function supported(wallet) {
  return wallet?.version === '1.0.0' && wallet.chains?.includes(CHAIN)
    && wallet.features?.['standard:connect']?.version === '1.0.0'
    && typeof wallet.features['standard:connect'].connect === 'function'
    && wallet.features?.['standard:events']?.version === '1.0.0'
    && typeof wallet.features['standard:events'].on === 'function'
    && wallet.features?.[SIGN]?.version === '1.0.0'
    && typeof wallet.features[SIGN].signTransaction === 'function'
    && wallet.features[SIGN].supportedTransactionVersions?.includes('legacy');
}
export function discoverWallets(surface, onChange) {
  const wallets = new Set();
  const notify = () => onChange([...wallets]);
  const api = Object.freeze({ register(...items) {
    const accepted = [];
    for (const w of items) if (!wallets.has(w) && !accepted.includes(w) && wallets.size + accepted.length < 20 && supported(w)) accepted.push(w);
    accepted.forEach(w => wallets.add(w)); notify();
    return () => { accepted.forEach(w => wallets.delete(w)); notify(); };
  } });
  const listener = event => { try { if (typeof event.detail === 'function') event.detail(api); } catch { /* Untrusted extension registration. */ } };
  surface.addEventListener('wallet-standard:register-wallet', listener);
  class ReadyEvent extends Event { get detail() { return api; } }
  surface.dispatchEvent(new ReadyEvent('wallet-standard:app-ready'));
  return () => { surface.removeEventListener('wallet-standard:register-wallet', listener); wallets.clear(); };
}
export class WalletSession {
  #wallet = null; #account = null; #off = null; #revision = 0; #busy = false; #onChange;
  constructor(onChange = () => {}) { this.#onChange = onChange; }
  get address() { return this.#account?.address ?? null; }
  #invalidate() {
    this.#revision++; this.#wallet = null; this.#account = null;
    const off = this.#off; this.#off = null; if (typeof off === 'function') off();
    this.#onChange(null);
  }
  async disconnect() {
    const wallet = this.#wallet; this.#invalidate();
    try { await wallet?.features?.['standard:disconnect']?.disconnect(); } catch { /* Already invalidated. */ }
  }
  async connect(wallet) {
    check(!this.#busy, 'WALLET_BUSY'); check(supported(wallet), 'UNSUPPORTED_WALLET');
    this.#invalidate(); const revision = this.#revision; this.#busy = true;
    try {
      const result = await boundedWalletCall(() => wallet.features['standard:connect'].connect({ silent: false }), 60000);
      check(this.#revision === revision, 'WALLET_CHANGED');
      const accounts = result?.accounts?.filter(accountSupported);
      check(accounts?.length === 1, 'SELECT_ONE_DEVNET_ACCOUNT');
      const account = accounts[0];
      check(wallet.accounts?.includes(account), 'ACCOUNT_NOT_CONNECTED');
      this.#wallet = wallet; this.#account = account;
      this.#off = wallet.features['standard:events'].on('change', () => this.#invalidate());
      check(typeof this.#off === 'function', 'INVALID_EVENTS_FEATURE');
      this.#onChange(this.address); return this.address;
    } catch { this.#invalidate(); throw new Error('WALLET_CONNECTION_REJECTED'); }
    finally { this.#busy = false; }
  }
  async sign(payload, confirmation) {
    check(!this.#busy, 'WALLET_BUSY');
    const wallet = this.#wallet, account = this.#account, revision = this.#revision;
    const data = structuredClone(payload);
    const details = data?.review?.details;
    check(wallet && account && supported(wallet) && accountSupported(account), 'WALLET_NOT_CONNECTED');
    check(wallet.accounts?.includes(account) && account.address === data.expectedAddress, 'CONNECTED_WALLET_MISMATCH');
    check(data.chain === CHAIN && details?.cluster === 'devnet' && details.productionVerified === true
      && details.verificationAllowed === true && ['fund', 'collect', 'buy', 'sell', 'cleanup', 'create', 'swap', 'launch-bundle'].includes(details.plan?.action)
      && details.broadcast === false, 'UNVERIFIED_WALLET_REQUEST');
    check(typeof confirmation === 'string' && /^[a-f0-9]{64}$/.test(confirmation) && confirmation === data.review.digest, 'REVIEW_NOT_APPROVED');
    check(Date.now() < details.expiresAt && details.expiresAt <= Date.now() + 60000, 'REVIEW_EXPIRED');
    check(Array.isArray(data.unsignedTransactions) && data.unsignedTransactions.length > 0
      && data.unsignedTransactions.length <= 5 && data.unsignedTransactions.length === details.transactions?.length, 'INVALID_BATCH');
    const bundle = details.plan.action === 'launch-bundle';
    const signerCount = bundle ? details.transactions[0].requiredSigners?.length : details.plan.action === 'create' ? 2 : 1;
    check(signerCount === 1 || signerCount === 2, 'INVALID_SIGNER_COUNT');
    check(signerCount === 1 || data.unsignedTransactions.length === 1, 'INVALID_BATCH');
    const signerOffsets = [];
    const requests = data.unsignedTransactions.map((wire, i) => {
      const tx = details.transactions[i];
      const signerIndex = tx.requiredSigners?.indexOf(account.address) ?? -1;
      check(tx.requiredSigners?.length === signerCount && signerIndex >= 0, 'CONNECTED_WALLET_MISMATCH');
      const transaction = fromBase64(wire), message = messageOfWire(transaction, signerCount);
      check(toBase64(message) === tx.messageBase64 &&
        transaction.subarray(1, 1 + 64 * signerCount).every(v => v === 0), 'MESSAGE_DIFFERS_FROM_REVIEW');
      const keyOffset = 4 + signerIndex * 32;
      check(message[0] === signerCount && message[1] === 0 && message[3] >= signerCount && message[3] < 128 &&
        sameBytes(message.subarray(keyOffset, keyOffset + 32), account.publicKey), 'CONNECTED_WALLET_MISMATCH');
      signerOffsets.push(1 + signerIndex * 64);
      return { transaction, account, chain: CHAIN };
    });
    this.#busy = true;
    try {
      // signTransaction is deliberately distinct from signAndSendTransaction.
      const output = await boundedWalletCall(() => wallet.features[SIGN].signTransaction(...requests), Math.max(1, details.expiresAt - Date.now()));
      check(this.#revision === revision && this.#wallet === wallet && wallet.accounts?.includes(account), 'WALLET_CHANGED');
      check(Date.now() < details.expiresAt, 'REVIEW_EXPIRED');
      check(Array.isArray(output) && output.length === requests.length, 'INVALID_WALLET_RESPONSE');
      const wires = output.map(result => {
        check(result?.signedTransaction instanceof Uint8Array && result.signedTransaction.length > 0 && result.signedTransaction.length <= 1232, 'INVALID_WALLET_RESPONSE');
        return new Uint8Array(result.signedTransaction);
      });
      const signed = [];
      for (let i = 0; i < wires.length; i++) {
        const wire = wires[i];
        const message = messageOfWire(wire, signerCount);
        check(toBase64(message) === details.transactions[i].messageBase64, 'MESSAGE_DIFFERS_FROM_REVIEW');
        const key = await crypto.subtle.importKey('raw', account.publicKey, 'Ed25519', false, ['verify']);
        check(await crypto.subtle.verify('Ed25519', key, wire.subarray(signerOffsets[i], signerOffsets[i] + 64), message), 'INVALID_WALLET_SIGNATURE');
        check(this.#revision === revision && Date.now() < details.expiresAt, 'WALLET_CHANGED_OR_EXPIRED');
        signed.push(toBase64(wire));
      }
      return signed;
    } catch (e) {
      if (['WALLET_CHANGED', 'REVIEW_EXPIRED', 'INVALID_WALLET_RESPONSE', 'MESSAGE_DIFFERS_FROM_REVIEW', 'INVALID_WALLET_SIGNATURE', 'WALLET_CHANGED_OR_EXPIRED', 'WALLET_REQUEST_TIMED_OUT'].includes(e?.message)) throw e;
      throw new Error('WALLET_SIGNATURE_REJECTED');
    } finally { this.#busy = false; }
  }
}
