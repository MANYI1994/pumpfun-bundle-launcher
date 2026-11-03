import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Vault } from './vault.js';
import { hiddenInput } from './terminal.js';
import { fundingPlan, sellPlan, collectionPlan, validateEnvelope } from './plans.js';
import { requireSafe, shortError } from './security.js';
import { Rpc } from './network.js';
import { reconcile } from './settlement.js';
import { readRegularFile } from './files.js';

function readJson(file) {
  return JSON.parse(readRegularFile(file));
}
function saveNew(file, value) { writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
function vault() {
  const root = process.env.LAUNCHER_VAULT_DIR || path.join(os.homedir(), '.local', 'share', 'pumpfun-launcher-v2');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  requireSafe(!path.resolve(root).startsWith(repo + path.sep) && path.resolve(root) !== repo, 'VAULT_MUST_BE_OUTSIDE_REPOSITORY');
  return new Vault(root);
}
export async function main(args) {
  const [command, operation, ...rest] = args;
  if (!command || command === 'help') {
    console.log('Restricted devnet security rebuild. Trading and broadcasts are disabled pending protocol integration.');
    console.log('wallet create <id> <buyer|payer|deployer|mint>\nwallet list\nplan fund <input.json> <new-output.json>\nplan sell <input.json> <new-output.json>\nplan collect <input.json> <new-output.json>\ninspect plan <plan.json>\nstatus signatures <signature...>');
  } else if (command === 'wallet' && operation === 'create') {
    requireSafe(rest.length === 2, 'INVALID_ARGUMENTS');
    let password = await hiddenInput('New vault passphrase (16+ characters)');
    let repeat = await hiddenInput('Repeat passphrase');
    try { requireSafe(password === repeat, 'PASSPHRASES_DIFFER'); const result = await vault().create(rest[0], rest[1], password); console.log(JSON.stringify({ id: result.id, role: result.role, address: result.address })); }
    finally { password = ''; repeat = ''; }
  } else if (command === 'wallet' && operation === 'list') {
    requireSafe(rest.length === 0, 'INVALID_ARGUMENTS');
    console.log(JSON.stringify(vault().list().map(({ id, role, address }) => ({ id, role, address })), null, 2));
  } else if (command === 'plan' && ['fund', 'sell', 'collect'].includes(operation)) {
    requireSafe(rest.length === 2, 'INVALID_ARGUMENTS');
    const request = readJson(rest[0]); requireSafe(!Object.hasOwn(request, 'now'), 'CALLER_CLOCK_NOT_ALLOWED');
    const plan = operation === 'fund' ? fundingPlan(request) : operation === 'collect' ? collectionPlan(request) : sellPlan(request);
    saveNew(rest[1], plan); console.log('Review-only plan saved. No signing or broadcast performed.');
  } else if (command === 'inspect' && operation === 'plan') {
    requireSafe(rest.length === 1, 'INVALID_ARGUMENTS');
    const envelope = readJson(rest[0]); validateEnvelope(envelope, envelope.digest);
    console.log(JSON.stringify(envelope, null, 2));
  } else if (command === 'status' && operation === 'signatures') {
    console.log(JSON.stringify(await reconcile(new Rpc(), rest)));
  } else requireSafe(false, 'COMMAND_OR_LIVE_ROUTE_DISABLED');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(shortError(error)); process.exitCode = 1; });
}
