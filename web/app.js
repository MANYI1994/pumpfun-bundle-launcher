import { discoverWallets, WalletSession } from './wallet.js';
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get('session');
history.replaceState(null, '', '/');
let wallets = [], payload = null, busy = false, generation = 0;
const validSession = /^[a-f0-9]{64}$/.test(token ?? '');
const status = message => { $('status').textContent = message; };
function reset() { generation++; payload = null; $('approve').checked = false; $('review-section').hidden = true; render(); }
const session = new WalletSession(address => {
  reset(); $('account').textContent = address ? `Connected: ${address}` : 'No wallet connected.';
  if (validSession) api('/api/cancel', {}).catch(() => {});
});
async function api(route, body) {
  const response = await fetch(route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', 'x-launcher-session': token }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'REQUEST_FAILED');
  return data;
}
function render() {
  $('connect').disabled = busy || !validSession || !$('wallets').value;
  $('disconnect').disabled = !session.address;
  $('prepare').disabled = busy || !validSession || !session.address;
  $('sign').disabled = busy || !payload || !$('approve').checked || !session.address || Date.now() >= payload.review.details.expiresAt;
}
discoverWallets(window, items => {
  wallets = items; const selected = $('wallets').value; $('wallets').replaceChildren();
  const placeholder = new Option(items.length ? 'Choose a wallet' : 'No compatible wallets found', ''); $('wallets').add(placeholder);
  items.forEach((wallet, i) => $('wallets').add(new Option(String(wallet.name).slice(0, 80), String(i + 1))));
  if (wallets[Number(selected) - 1]) $('wallets').value = selected;
  render();
});
$('wallets').addEventListener('change', render);
$('approve').addEventListener('change', render);
for (const id of ['destination', 'amount']) $(id).addEventListener('input', reset);
$('connect').addEventListener('click', async () => {
  busy = true; render(); status('Approve the wallet connection.');
  try { await session.connect(wallets[Number($('wallets').value) - 1]); status('Connected. Enter the recipient and test amount.'); }
  catch { status('Connection declined or unsupported. Select one account with devnet signing support and try again.'); }
  finally { busy = false; render(); }
});
$('disconnect').addEventListener('click', async () => { await session.disconnect(); status('Disconnected. Previous reviews are invalid.'); });
$('form').addEventListener('submit', async event => {
  event.preventDefault(); reset(); const current = generation; busy = true; render(); status('Checking devnet, balance and exact transaction fee…');
  try {
    const result = await api('/api/review', { payerAddress: session.address, destinationAddress: $('destination').value, lamports: $('amount').value });
    if (current !== generation || result.expectedAddress !== session.address) throw new Error('WALLET_CHANGED');
    payload = result; const d = result.review.details, p = d.plan;
    const entries = [['Network', 'Solana devnet'], ['From', p.payerAddress], ['To', p.wallets[0].address], ['Lamports', p.wallets[0].lamports], ['Fee', d.budget.feeLamports], ['Remaining', d.budget.remainingLamports], ['Review hash', result.review.digest]];
    $('summary').replaceChildren();
    for (const [label, value] of entries) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; $('summary').append(dt, dd); }
    $('review-section').hidden = false; status('Review the transfer, then approve signing. Nothing will be broadcast.');
  } catch (e) { reset(); status(`Review unavailable: ${e.message}. Check the account has devnet SOL, then prepare again.`); }
  finally { busy = false; render(); }
});
$('sign').addEventListener('click', async () => {
  if (!payload || !$('approve').checked) return;
  const request = payload, current = generation; payload = null; busy = true; render(); status('Check and approve the transaction in your wallet.');
  try {
    const wires = await session.sign(request, request.review.digest);
    if (current !== generation) throw new Error('WALLET_CHANGED');
    const result = await api('/api/verify', { reviewDigest: request.review.digest, signedTransactions: wires });
    if (current !== generation || !result.verified || result.broadcast !== false) throw new Error('VERIFICATION_FAILED');
    status('Signature verified: the expected wallet signed the exact reviewed transaction. Nothing was broadcast.');
  } catch (e) { status(`Signing did not complete: ${e.message}. Prepare a fresh review to try again.`); }
  finally { reset(); busy = false; render(); }
});
setInterval(() => {
  if (payload) $('expiry').textContent = `Review expires in ${Math.max(0, Math.ceil((payload.review.details.expiresAt - Date.now()) / 1000))} seconds. Prepare again if it expires.`;
  render();
}, 500);
if (validSession) status('Choose your wallet to begin.');
render();
