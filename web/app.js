import { attachLauncherPanel } from "./launcher-panel.js";
import { discoverWallets, WalletSession } from './wallet.js';
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get('session');
history.replaceState(null, '', '/');
let wallets = [], payload = null, execution = null, executionEnabled = false, busy = false, generation = 0;
const validSession = /^[a-f0-9]{64}$/.test(token ?? '');
const status = message => { $('status').textContent = message; };
function reset() { generation++; payload = null; $('approve').checked = false; $('review-section').hidden = true; render(); }
const session = new WalletSession(address => {
  execution = null; $('execution-section').hidden = true;
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
  $('simulate').disabled = busy || !execution || Boolean(execution.ticket) || !session.address;
  $('submit').disabled = busy || !execution?.ticket || !$('approve-send').checked || !session.address || Date.now() >= execution.ticket.expiresAt;
  $('recover').disabled = busy || !$('operations').value;
  $('refresh-operations').disabled = busy;
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
$('approve-send').addEventListener('change', render);
$('operations').addEventListener('change', render);
for (const id of ['destination', 'amount', 'transfer-kind']) $(id).addEventListener('input', () => { execution = null; $('execution-section').hidden = true; reset(); });
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
    if (executionEnabled) await api('/api/cancel', {});
    execution = null; $('execution-section').hidden = true;
    const route = $('transfer-kind').value === 'collect' ? '/api/collection-review' : '/api/review';
    const result = await api(route, { payerAddress: session.address, destinationAddress: $('destination').value, lamports: $('amount').value });
    if (current !== generation || result.expectedAddress !== session.address) throw new Error('WALLET_CHANGED');
    payload = result; const d = result.review.details, p = d.plan;
    const collecting = p.action === 'collect';
    const budget = collecting ? d.budget[0] : d.budget;
    const entries = [['Network', 'Solana devnet'], ['Purpose', collecting ? 'Collect SOL' : 'Fund wallet'], ['From', result.expectedAddress], ['To', collecting ? p.destinationAddress : p.wallets[0].address], ['Lamports', p.wallets[0].lamports], ['Fee', budget.feeLamports], ['Remaining', budget.remainingLamports], ['Review hash', result.review.digest]];
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
    showExecution(result, request.review.details.plan);
  } catch (e) { status(`Signing did not complete: ${e.message}. Prepare a fresh review to try again.`); }
  finally { reset(); busy = false; render(); }
});
function showExecution(result, plan) {
  const payer = plan.action === 'collect' ? plan.wallets[0].address : plan.payerAddress;
  if (!result.executionEnabled || session.address !== payer) return;
  execution = { digest: result.executionDigest, id: result.operationId, ticket: null };
  $('approve-send').checked = false;
  const summary = plan.action === 'buy'
    ? `Buy mint: ${plan.mint}\nWallet: ${plan.payerAddress}\nDestination: ${plan.destinationTokenAccount}\nTrade budget: ${plan.tradeBudgetLamports} lamports\nTotal debit cap checked in simulation: ${plan.maxDebitLamports} lamports\nMinimum token output: ${plan.minimumTokenAmountRaw} raw units`
    : plan.action === 'sell'
      ? `Sell mint: ${plan.mint}\nWallet: ${plan.payerAddress}\nSource: ${plan.sourceTokenAccount}\nToken amount: ${plan.amountRaw} raw units\nMinimum SOL proceeds: ${plan.minimumOutputLamports} lamports\nProceeds wallet: ${plan.proceedsAddress}`
      : `Purpose: ${plan.action === 'collect' ? 'Collect SOL' : 'Fund wallet'}\nFrom: ${payer}\nTo: ${plan.destinationAddress ?? plan.wallets[0].address}\nLamports: ${plan.wallets[0].lamports}`;
  $('execution-summary').textContent = `${summary}\nOperation: ${execution.id}`;
  $('execution-section').hidden = false;
  render();
}
setInterval(() => {
  if (payload) $('expiry').textContent = `Review expires in ${Math.max(0, Math.ceil((payload.review.details.expiresAt - Date.now()) / 1000))} seconds. Prepare again if it expires.`;
  render();
}, 500);
$('simulate').addEventListener('click', async () => {
  if (!execution) return;
  const current = generation; busy = true; render(); status('Simulating the unchanged signed transaction and checking the current budget…');
  try {
    const prepared = await api('/api/simulate', { executionDigest: execution.digest });
    if (!execution || current !== generation) throw new Error('WALLET_CHANGED');
    execution.ticket = prepared;
    const change = prepared.budget.conservativeNetProceedsLamports === undefined
      ? `Simulated total debit: ${prepared.budget.totalDebitLamports} lamports`
      : `Simulated net proceeds: ${prepared.budget.conservativeNetProceedsLamports} lamports`;
    $('execution-summary').textContent += `\n${change}\nFee: ${prepared.budget.feeLamports} lamports\nRemaining: ${prepared.budget.remainingLamports} lamports`;
    status('Simulation passed. Check the transaction, then explicitly approve devnet submission.');
  } catch (e) { execution = null; status(`Simulation unavailable: ${e.message}. Use saved-operation recovery before preparing again.`); }
  finally { busy = false; render(); }
});
$('submit').addEventListener('click', async () => {
  if (!execution?.ticket || !$('approve-send').checked) return;
  const approved = execution; execution = null; $('approve-send').checked = false; busy = true; render();
  status(`Submitting operation ${approved.id}. An RPC acknowledgement is not finalization.`);
  try {
    const result = await api('/api/submit', { executionDigest: approved.digest });
    status(`RPC accepted operation ${result.id}. Check its original signature through recovery for finalization.`);
  } catch (e) { status(`Submission outcome requires recovery: ${e.message}. Operation ${approved.id}. Do not create another transfer yet.`); }
  finally { busy = false; render(); }
});
$('refresh-operations').addEventListener('click', async () => {
  busy = true; render();
  try {
    const result = await api('/api/operations', {}); $('operations').replaceChildren(new Option('Choose an operation', ''));
    for (const item of result.operations) $('operations').add(new Option(`${item.id} · ${item.state}`, item.id));
    status('Choose an operation to check. Recovery never submits transactions.');
  } catch (e) { status(`Operations unavailable: ${e.message}`); }
  finally { busy = false; render(); }
});
$('recover').addEventListener('click', async () => {
  busy = true; render();
  try {
    const result = await api('/api/recover', { operationId: $('operations').value });
    if (result.state === 'abandoned-before-submission' && execution?.id === result.id) { execution = null; $('execution-section').hidden = true; }
    status(`Operation ${result.id}: ${result.state}. Automatic resubmission is disabled.`);
  }
  catch (e) { status(`Recovery unavailable: ${e.message}. Keep the original operation and try checking again later.`); }
  finally { busy = false; render(); }
});
if (validSession) {
  status('Choose your wallet to begin.');
  api('/api/mode', {}).then(mode => {
    executionEnabled = mode.executionEnabled;
    $('recovery-section').hidden = !executionEnabled;
    if (executionEnabled) {
      $('intro').textContent = 'Devnet execution mode: connect, review, sign, simulate and explicitly submit. Use disposable test SOL only.';
      $('footnote').textContent = 'Desktop wallet extensions. Execution supports native SOL funding and collection, and reviewed single-wallet Pump buys and sells.';
    }
  }).catch(() => status('Session unavailable. Reopen the complete local session URL.'));
}
render();

if (validSession) attachLauncherPanel({ api, showExecution, connectedAddress: () => session.address, sign: (request, digest) => session.sign(request, digest) });
