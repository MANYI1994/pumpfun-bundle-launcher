import { downloadCar, packageMetadata } from './metadata-package.js';
import { fromBase64, toBase64 } from './wallet.js';

export function attachLauncherPanel({ api, connectedAddress, sign, showExecution }) {
  const field = id => document.getElementById(id);
  const value = id => field(id).value.trim();
  const metadata = () => ({
    name: value('token-name'), symbol: value('token-symbol'),
    description: value('token-description'), image: value('token-image'),
  });
  const target = () => ({ owner: value('monitor-owner') || connectedAddress() || '', mint: value('monitor-mint') });
  const display = (id, data) => { field(id).textContent = JSON.stringify(data, null, 2); };
  async function action(button, output, route, input) {
    button.disabled = true;
    field(output).textContent = 'Loading…';
    try { display(output, await api(route, input)); }
    catch (error) { field(output).textContent = error.message; }
    finally { button.disabled = false; }
  }
  field('inspect-network').addEventListener('click', event => {
    action(event.currentTarget, 'network-readiness-result', '/api/network-readiness',
      { profile: value('inspect-network-profile') });
  });
  field('check-migration').addEventListener('click', event => {
    action(event.currentTarget, 'migration-result', '/api/migration', { mint: value('monitor-mint') });
  });
  field('metadata-build').addEventListener('click', event => {
    action(event.currentTarget, 'creation-result', '/api/metadata', metadata());
  });
  let publication;
  let publicationRevision = 0;
  const publicationStatus = message => { field('metadata-package-status').textContent = message; };
  function clearPublication() {
    publicationRevision++;
    publication = undefined;
    field('download-image-car').disabled = true;
    field('download-metadata-car').disabled = true;
  }
  for (const id of ['token-name', 'token-symbol', 'token-description', 'token-image', 'token-uri', 'metadata-image-file']) {
    field(id).addEventListener('input', clearPublication);
  }
  field('metadata-package').addEventListener('click', async event => {
    clearPublication();
    clearCreation();
    const revision = publicationRevision;
    const button = event.currentTarget;
    button.disabled = true;
    publicationStatus('Preparing content-addressed files…');
    try {
      const result = await packageMetadata(field('metadata-image-file').files[0], metadata(),
        input => api('/api/metadata', input));
      if (revision !== publicationRevision) return;
      publication = result;
      field('token-image').value = result.imageBlock.url;
      field('token-uri').value = result.metadataBlock.url;
      field('download-image-car').disabled = false;
      field('download-metadata-car').disabled = false;
      publicationStatus('Download and upload both CAR files. The creation form now contains their IPFS URLs.');
    } catch (error) {
      if (revision === publicationRevision) publicationStatus(error.message);
    } finally { button.disabled = false; }
  });
  field('download-image-car').addEventListener('click', () => {
    if (publication) downloadCar(publication.imageBlock, 'token-image.car');
  });
  field('download-metadata-car').addEventListener('click', () => {
    if (publication) downloadCar(publication.metadataBlock, 'token-metadata.car');
  });

  let metadataCheckRevision = 0;
  field('creation-form').addEventListener('input', () => {
    metadataCheckRevision++;
    field('metadata-publication-result').textContent = '';
  });
  field('metadata-package').addEventListener('click', () => {
    metadataCheckRevision++;
    field('metadata-publication-result').textContent = '';
  });
  field('check-metadata-publication').addEventListener('click', async event => {
    const current = ++metadataCheckRevision;
    const button = event.currentTarget;
    const output = field('metadata-publication-result');
    button.disabled = true;
    output.textContent = 'Checking published image and metadata…';
    try {
      const result = await api('/api/metadata-publication', { metadata: metadata(), metadataUri: value('token-uri') });
      if (current === metadataCheckRevision) display('metadata-publication-result', result);
    } catch (error) {
      if (current === metadataCheckRevision) output.textContent = error.message;
    } finally { button.disabled = false; }
  });

  let creation;
  let creationRevision = 0;
  const creationSign = field('creation-sign');
  function clearCreation() {
    creation = undefined;
    creationRevision++;
    creationSign.disabled = true;
  }
  field('creation-form').addEventListener('input', clearCreation);
  field('creation-form').addEventListener('submit', async event => {
    event.preventDefault();
    clearCreation();
    const revision = creationRevision;
    const maxDebitLamports = value('creation-max-debit');
    const button = field('creation-review');
    button.disabled = true;
    field('creation-result').textContent = 'Preparing creation review…';
    try {
      const { expiresAt, budget, ...envelope } = await api('/api/create-review', {
        metadata: metadata(), metadataUri: value('token-uri'), mintAddress: value('token-mint'),
        creatorAddress: connectedAddress() || '', maxDebitLamports,
      });
      if (revision !== creationRevision) return;
      creation = { envelope, expiresAt, maxDebitLamports, signatures: new Map() };
      const { unsignedWireBase64, ...summary } = envelope.review;
      display('creation-result', { ...summary, maxDebitLamports, quotedNetworkFeeLamports: budget.feeLamports,
        creatorBalanceLamports: budget.balanceLamports, digest: envelope.digest, expiresAt: new Date(expiresAt).toISOString() });
      renderSigningStatus();
    } catch (error) { field('creation-result').textContent = error.message; }
    finally { button.disabled = false; }
  });
  creationSign.addEventListener('click', async () => {
    const current = creation;
    if (!current) return;
    const owner = connectedAddress();
    const { review, digest } = current.envelope;
    if (!review.requiredSigners.includes(owner) || current.signatures.has(owner)) {
      field('creation-result').textContent = 'Connect the remaining mint or creator account.';
      return;
    }
    current.signing = true;
    renderSigningStatus();
    try {
      const unsigned = fromBase64(review.unsignedWireBase64);
      const payload = { chain: 'solana:devnet', expectedAddress: owner, unsignedTransactions: [review.unsignedWireBase64],
        review: { digest, details: {
          cluster: 'devnet', productionVerified: true, verificationAllowed: true, broadcast: false,
          plan: { action: 'create' }, expiresAt: current.expiresAt,
          transactions: [{ messageBase64: toBase64(unsigned.subarray(129)), requiredSigners: review.requiredSigners }],
        } } };
      const [wire] = await sign(payload, digest);
      if (creation !== current) return;
      current.signatures.set(owner, wire);
      const remaining = review.requiredSigners.filter(address => !current.signatures.has(address));
      if (remaining.length) {
        display('creation-result', { signedBy: [...current.signatures.keys()], remaining });
        return;
      }
      const result = await api('/api/create-simulate', {
        confirmation: digest, signedWires: [...current.signatures.values()],
      });
      if (creation === current) {
        clearCreation();
        display('creation-result', result);
        showExecution(result, result.plan);
      }
    } catch (error) {
      if (creation === current) {
        if (current.signatures.size === 2) clearCreation();
        field('creation-result').textContent = error.message;
      }
    } finally { current.signing = false; renderSigningStatus(); }
  });
  let bundle;
  let bundleRevision = 0;
  let bundleReceipt;
  const bundleSimulate = field('bundle-simulate');
  const bundleSign = field('bundle-sign');
  function clearBundle() {
    bundle = undefined;
    bundleReceipt = undefined;
    bundleSimulate.disabled = true;
    bundleRevision++;
    bundleSign.disabled = true;
  }
  field('bundle-form').addEventListener('input', clearBundle);
  field('creation-form').addEventListener('input', clearBundle);
  field('metadata-package').addEventListener('click', clearBundle);
  field('bundle-form').addEventListener('submit', async event => {
    event.preventDefault();
    clearBundle();
    const revision = bundleRevision;
    const compile = event.submitter?.value === 'transaction';
    const button = field(compile ? 'bundle-transaction' : 'bundle-plan');
    button.disabled = true;
    try {
      const slippageBps = Number(value('bundle-slippage'));
      const buyers = value('bundle-buyers').split(/\r?\n/).map(line => {
        const [address, spendLamports, maxDebitLamports, extra] = line.trim().split(/\s+/);
        if (!address || !spendLamports || !maxDebitLamports || extra) {
          throw new Error('Enter a public address, trade amount and debit cap on each line.');
        }
        return { address, spendLamports, maxDebitLamports, slippageBps };
      });
      const result = await api(compile ? '/api/launch-bundle-transaction' : '/api/launch-bundle-plan', {
        creatorAddress: connectedAddress() || '', mintAddress: value('token-mint'),
        metadata: metadata(), metadataUri: value('token-uri'),
        creationMaxDebitLamports: value('creation-max-debit'), buyers,
      });
      if (revision !== bundleRevision) return;
      if (compile) {
        bundle = { ...result, index: 0, signatures: result.review.transactions.map(() => new Map()) };
        const { transactions, ...review } = result.review;
        display('bundle-result', { ...review, digest: result.digest,
          transactions: transactions.map(({ unsignedWireBase64, ...step }) => step),
          nextSigners: transactions[0].requiredSigners });
        renderSigningStatus();
      } else display('bundle-result', result);
    } catch (error) { if (revision === bundleRevision) field('bundle-result').textContent = error.message; }
    finally { button.disabled = false; }
  });

  bundleSign.addEventListener('click', async () => {
    const current = bundle;
    if (!current) return;
    const tx = current.review.transactions[current.index];
    const signatures = current.signatures[current.index];
    const owner = connectedAddress();
    if (!tx.requiredSigners.includes(owner) || signatures.has(owner)) {
      display('bundle-result', { transaction: current.index + 1,
        nextSigners: tx.requiredSigners.filter(address => !signatures.has(address)) });
      return;
    }
    current.signing = true;
    renderSigningStatus();
    try {
      const wire = fromBase64(tx.unsignedWireBase64);
      const messageOffset = 1 + 64 * tx.requiredSigners.length;
      const payload = { chain: 'solana:devnet', expectedAddress: owner,
        unsignedTransactions: [tx.unsignedWireBase64],
        review: { digest: current.digest, details: {
          cluster: 'devnet', productionVerified: true, verificationAllowed: true, broadcast: false,
          plan: { action: 'launch-bundle' }, expiresAt: current.review.expiresAt,
          transactions: [{ messageBase64: toBase64(wire.subarray(messageOffset)), requiredSigners: tx.requiredSigners }],
        } } };
      const [signed] = await sign(payload, current.digest);
      if (bundle !== current) return;
      signatures.set(owner, signed);
      if (signatures.size === tx.requiredSigners.length) current.index++;
      const next = current.review.transactions[current.index];
      if (next) {
        display('bundle-result', { transaction: current.index + 1, action: next.action,
          nextSigners: next.requiredSigners.filter(address => !current.signatures[current.index].has(address)),
          expiresAt: new Date(current.review.expiresAt).toISOString() });
      } else {
        clearBundle();
        const revision = bundleRevision;
        const receipt = await api('/api/launch-bundle-verify', { confirmation: current.digest,
          signedTransactions: current.signatures.map(group => [...group.values()]) });
        if (revision === bundleRevision) {
          bundleReceipt = { digest: receipt.digest, expiresAt: current.review.expiresAt };
          field('bundle-recovery').value = JSON.stringify(receipt.recovery, null, 2);
          display('bundle-result', receipt);
          renderSigningStatus();
        }
      }
    } catch (error) {
      field('bundle-result').textContent = error.message;
    } finally { current.signing = false; renderSigningStatus(); }
  });
  field('bundle-check-status').addEventListener('click', event => {
    try {
      const receipt = JSON.parse(value('bundle-recovery'));
      action(event.currentTarget, 'bundle-status-result', '/api/launch-bundle-status', receipt);
    } catch {
      field('bundle-status-result').textContent = 'Paste the recovery JSON from a verified bundle.';
    }
  });

  bundleSimulate.addEventListener('click', async () => {
    const receipt = bundleReceipt;
    if (!receipt || receipt.busy || Date.now() >= receipt.expiresAt) return;
    receipt.busy = true;
    renderSigningStatus();
    try {
      const result = await api('/api/launch-bundle-simulate', { confirmation: receipt.digest });
      if (bundleReceipt === receipt) display('bundle-result', result);
    } catch (error) {
      if (bundleReceipt === receipt) field('bundle-result').textContent = error.message;
    } finally {
      receipt.busy = false;
      renderSigningStatus();
    }
  });

  function renderSigningStatus() {
    const now = Date.now();
    bundleSimulate.disabled = !bundleReceipt || bundleReceipt.busy || now >= bundleReceipt.expiresAt;
    const connected = connectedAddress();
    const render = (button, statusId, current, expiresAt, required, signed) => {
      if (!current) {
        button.disabled = true;
        field(statusId).textContent = '';
        return;
      }
      const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
      const remaining = required.filter(address => !signed.has(address));
      button.disabled = !seconds || current.signing || !remaining.includes(connected);
      field(statusId).textContent = seconds
        ? `${seconds}s to sign · Remaining: ${remaining.join(', ')}`
        : 'Signing window expired. Prepare a fresh review.';
    };
    render(creationSign, 'creation-signing-status', creation, creation?.expiresAt,
      creation?.envelope.review.requiredSigners, creation?.signatures);
    const step = bundle?.review.transactions[bundle.index];
    render(bundleSign, 'bundle-signing-status', bundle, bundle?.review.expiresAt,
      step?.requiredSigners, bundle?.signatures[bundle.index]);
  }
  setInterval(renderSigningStatus, 500);
  const buyInput = () => ({
    owner: connectedAddress() || '', mint: value('monitor-mint'),
    spendLamports: value('buy-budget'), slippageBps: Number(value('buy-slippage')),
  });
  field('buy-form').addEventListener('submit', event => {
    event.preventDefault();
    action(field('buy-review'), 'buy-result', '/api/buy-review', buyInput());
  });
  field('buy-transaction').addEventListener('click', () => {
    if (!field('buy-form').reportValidity()) return;
    action(field('buy-transaction'), 'buy-result', '/api/buy-transaction', buyInput());
  });
  const sellInput = () => ({
    owner: connectedAddress() || '', mint: value('monitor-mint'),
    percent: value('sell-percent'), slippageBps: Number(value('sell-slippage')),
  });
  field('sell-form').addEventListener('submit', event => {
    event.preventDefault();
    action(field('sell-review'), 'sell-result', '/api/sell-review', sellInput());
  });
  field('sell-transaction').addEventListener('click', () => {
    if (!field('sell-form').reportValidity()) return;
    action(field('sell-transaction'), 'sell-result', '/api/sell-transaction', sellInput());
  });
  for (const [side, readInput] of [['buy', buyInput], ['sell', sellInput]]) {
    field('pool-' + side + '-review').addEventListener('click', event => {
      action(event.currentTarget, side + '-result', '/api/pumpswap-review', { side, ...readInput() });
    });
    field('pool-' + side + '-transaction').addEventListener('click', event => {
      clearTradeApproval();
      action(event.currentTarget, side + '-result', '/api/pumpswap-transaction', { side, ...readInput() });
    });
  }
  let tradeApproval;
  let approvalRevision = 0;
  function clearTradeApproval() {
    tradeApproval = null;
    approvalRevision++;
    for (const actionName of ['buy', 'sell', 'cleanup']) field(actionName + '-sign-simulate').disabled = true;
  }
  for (const id of ['monitor-mint', 'buy-budget', 'buy-slippage', 'buy-max-debit', 'sell-percent', 'sell-slippage', 'cleanup-account', 'trade-signing-route', 'swap-max-debit']) {
    field(id).addEventListener('input', clearTradeApproval);
  }

  function bindTradeApproval(actionName, readInput) {
    const output = actionName + '-result';
    function signingRequest() {
      if (['buy', 'sell'].includes(actionName) && value('trade-signing-route') === 'pumpswap') {
        const trade = actionName === 'buy' ? buyInput() : sellInput();
        return ['/api/pumpswap-signing-review', { ...trade, side: actionName, maxDebitLamports: value('swap-max-debit') }];
      }
      return ['/api/' + actionName + '-signing-review', readInput()];
    }
    const signButton = field(actionName + '-sign-simulate');
    field(actionName + '-form').addEventListener('submit', event => {
      event.preventDefault();
      clearTradeApproval();
    });
    field('pool-' + actionName + '-review')?.addEventListener('click', clearTradeApproval);
    field(actionName + '-transaction')?.addEventListener('click', clearTradeApproval);
    field(actionName + '-prepare-sign').addEventListener('click', async event => {
      if (!field(actionName + '-form').reportValidity()) return;
      clearTradeApproval();
      const current = approvalRevision;
      const button = event.currentTarget;
      const [route, input] = signingRequest();
      button.disabled = true;
      field(output).textContent = 'Preparing wallet approval…';
      try {
        const payload = await api(route, input);
        if (current !== approvalRevision || JSON.stringify([route, input]) !== JSON.stringify(signingRequest())) {
          throw new Error('TRADE_INPUT_CHANGED');
        }
        tradeApproval = payload;
        const { plan, budget, expiresAt } = payload.review.details;
        const amounts = plan.action === 'swap'
          ? { route: plan.route, side: plan.side, inputAmountRaw: plan.inputAmountRaw, inputUnit: plan.inputUnit,
              minimumOutputRaw: plan.minimumOutputRaw, outputUnit: plan.outputUnit,
              sourceTokenAccount: plan.sourceTokenAccount, destination: plan.destinationTokenAccount,
              maxNativeDebitLamports: plan.maxDebitLamports }
          : actionName === 'buy'
          ? { tradeBudgetLamports: plan.tradeBudgetLamports, maxTotalDebitLamports: plan.maxDebitLamports,
              minimumTokenAmountRaw: plan.minimumTokenAmountRaw, destination: plan.destinationTokenAccount }
          : actionName === 'sell'
            ? { amountRaw: plan.amountRaw, minimumOutputLamports: plan.minimumOutputLamports,
                sourceTokenAccount: plan.sourceTokenAccount, proceedsAddress: plan.proceedsAddress }
            : { cleanupKind: plan.cleanupKind, accountToClose: plan.tokenAccount,
                expectedRecoveryLamports: plan.recoveredLamports, proceedsAddress: plan.proceedsAddress };
        display(output, { wallet: plan.owner, mint: plan.mint, ...amounts,
          quotedNetworkFeeLamports: budget.feeLamports, expiresAt: new Date(expiresAt).toISOString(),
          digest: payload.review.digest });
        signButton.disabled = false;
      } catch (error) { field(output).textContent = error.message; }
      finally { button.disabled = false; }
    });
    signButton.addEventListener('click', async () => {
      const payload = tradeApproval;
      const plan = payload?.review.details.plan;
      if (!plan || (plan.action === 'swap' ? plan.side : plan.action) !== actionName) return;
      clearTradeApproval();
      field(output).textContent = 'Awaiting wallet signature and devnet simulation…';
      try {
        const signedTransactions = await sign(payload, payload.review.digest);
        const result = await api('/api/verify', { reviewDigest: payload.review.digest, signedTransactions });
        display(output, result);
        showExecution(result, payload.review.details.plan);
      } catch (error) { field(output).textContent = error.message; }
    });
  }
  bindTradeApproval('buy', () => ({ ...buyInput(), maxDebitLamports: value('buy-max-debit') }));
  bindTradeApproval('sell', sellInput);
  bindTradeApproval('cleanup', () => ({ owner: connectedAddress() || '', tokenAccount: value('cleanup-account') }));

  let timer;
  let revision = 0;
  let inFlight = false;
  async function refresh() {
    if (document.hidden || inFlight) return;
    inFlight = true;
    const current = revision;
    const requested = target();
    try {
      const balances = await api('/api/balances', requested);
      const latest = target();
      if (current === revision && latest.owner === requested.owner && latest.mint === requested.mint) {
        display('balance-result', balances);
      }
    } catch (error) {
      if (current === revision) field('balance-result').textContent = error.message;
    } finally { inFlight = false; }
  }
  field('monitor-start').addEventListener('click', () => {
    clearInterval(timer);
    revision++;
    field('balance-result').textContent = 'Waiting for balance…';
    timer = setInterval(refresh, 15000);
    refresh();
  });
  field('monitor-stop').addEventListener('click', () => {
    clearInterval(timer);
    revision++;
    field('balance-result').textContent = 'Monitoring stopped.';
  });
}
