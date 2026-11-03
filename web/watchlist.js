export function attachWatchlist({ api, connectedAddress }) {
  const field = id => document.getElementById(id);
  const wallets = [];
  let results = new Map();
  let revision = 0;
  let timer;
  let busy = false;
  const status = message => { field('watch-status').textContent = message; };

  function button(label, handler) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'secondary';
    element.textContent = label;
    element.addEventListener('click', handler);
    return element;
  }

  function render() {
    const list = field('watch-wallets');
    list.replaceChildren();
    field('watch-refresh').disabled = busy || wallets.length === 0;
    field('watch-toggle').disabled = wallets.length === 0;
    field('watch-toggle').textContent = timer ? 'Stop live refresh' : 'Start live refresh';
    for (const wallet of wallets) {
      const row = document.createElement('article');
      row.className = 'watch-wallet';
      const title = document.createElement('h3');
      title.textContent = wallet.label;
      const address = document.createElement('p');
      address.textContent = wallet.address;
      const summary = document.createElement('pre');
      const result = results.get(wallet.address);
      summary.textContent = result?.error ?? (result?.balance
        ? [
            'SOL balance: ' + formatSol(result.balance.lamports),
            ...result.balance.associatedTokenAccounts.map(account =>
              'Token units: ' + account.rawAmount + (account.frozen ? ' (frozen)' : '') + '\nAccount: ' + account.address),
          ].join('\n')
        : 'Refresh to load balances.');
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(
        button('Monitor wallet', () => {
          field('monitor-owner').value = wallet.address;
          field('monitor-start').click();
        }),
        button('Use as transfer destination', () => {
          field('destination').value = wallet.address;
          field('destination').dispatchEvent(new Event('input'));
        }),
        button('Remove', () => {
          wallets.splice(wallets.indexOf(wallet), 1);
          results.delete(wallet.address);
          revision++;
          if (!wallets.length) stop();
          render();
        }),
      );
      row.append(title, address, summary, actions);
      list.append(row);
    }
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
    revision++;
  }

  async function refresh() {
    if (busy || !wallets.length || document.hidden) return;
    busy = true;
    const current = revision;
    const mint = field('monitor-mint').value.trim();
    status('Reading devnet balances…');
    render();
    try {
      const rows = await api('/api/watch-balances', { wallets: wallets.map(wallet => ({ ...wallet })), mint });
      if (current !== revision) return;
      results = new Map(rows.map(row => [row.address, row]));
      status('Updated at ' + new Date().toLocaleTimeString());
    } catch (error) {
      if (current === revision) status(error.message);
    } finally {
      busy = false;
      render();
    }
  }

  field('watch-form').addEventListener('submit', event => {
    event.preventDefault();
    const address = field('watch-address').value.trim();
    const label = field('watch-label').value.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) || !/^[a-zA-Z0-9 _-]{1,32}$/.test(label)) {
      status('Enter a valid public address and wallet label.');
      return;
    }
    if (wallets.length >= 5 || wallets.some(wallet => wallet.address === address)) {
      status('Use up to five distinct wallet addresses.');
      return;
    }
    wallets.push({ address, label });
    revision++;
    field('watch-form').reset();
    status('Wallet added.');
    render();
  });
  field('watch-connected').addEventListener('click', () => {
    const address = connectedAddress();
    if (address) field('watch-address').value = address;
    else status('Connect a wallet first.');
  });
  field('watch-refresh').addEventListener('click', refresh);
  field('watch-toggle').addEventListener('click', () => {
    if (timer) {
      stop();
      status('Live refresh stopped.');
    } else {
      timer = setInterval(refresh, 15000);
      refresh();
    }
    render();
  });
  field('monitor-mint').addEventListener('input', () => {
    revision++;
    results.clear();
    status('Mint changed. Refresh balances for this selection.');
    render();
  });
  render();
}

function formatSol(lamports) {
  const amount = BigInt(lamports);
  const fraction = String(amount % 1000000000n).padStart(9, '0').replace(/0+$/, '');
  return String(amount / 1000000000n) + (fraction ? '.' + fraction : '') + ' SOL';
}
