import { getAddressEncoder, getBase58Decoder, getProgramDerivedAddress } from '@solana/kit';
import { PUMP } from './transactions.js';
import { PUMP_SWAP } from './migration.js';
import { networkProfile } from './network-profiles.js';
import { Rpc } from './network.js';
import { digest, exactKeys, frozenJson, requireSafe, shortError } from './security.js';

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const HEADER_OPTIONS = Object.freeze({
  encoding: 'base64', commitment: 'finalized', dataSlice: Object.freeze({ offset: 0, length: 45 }),
});
const decode = getBase58Decoder();

function header(account, length) {
  requireSafe(Array.isArray(account?.data) && account.data.length === 2 &&
    account.data[1] === 'base64' && typeof account.data[0] === 'string', 'INVALID_LOADER_HEADER');
  const bytes = Buffer.from(account.data[0], 'base64');
  requireSafe(bytes.length === length && bytes.toString('base64') === account.data[0], 'INVALID_LOADER_HEADER');
  return bytes;
}

async function inspectProgram(rpc, name, address) {
  const result = await rpc.read('getAccountInfo', [address, HEADER_OPTIONS]);
  const account = result?.value;
  const summary = { name, address, present: Boolean(account), executable: account?.executable === true,
    owner: typeof account?.owner === 'string' ? account.owner : null };
  if (!account || !summary.executable || summary.owner !== LOADER) {
    return { ...summary, deployment: null, state: !account ? 'missing' : 'unsupported-program-account' };
  }

  const program = header(account, 36);
  requireSafe(program.readUInt32LE(0) === 2, 'INVALID_LOADER_PROGRAM');
  const programDataAddress = decode.decode(program.subarray(4, 36));
  const [expected] = await getProgramDerivedAddress({
    programAddress: LOADER, seeds: [getAddressEncoder().encode(address)],
  });
  requireSafe(programDataAddress === expected, 'PROGRAM_DATA_ADDRESS_MISMATCH');

  const deployment = await rpc.read('getAccountInfo', [programDataAddress, HEADER_OPTIONS]);
  requireSafe(deployment?.value?.owner === LOADER && deployment.value.executable === false,
    'INVALID_PROGRAM_DATA_OWNER');
  const data = header(deployment.value, 45);
  requireSafe(data.readUInt32LE(0) === 3 && [0, 1].includes(data[12]), 'INVALID_PROGRAM_DATA_HEADER');
  const slot = data.readBigUInt64LE(4);
  requireSafe(Number.isSafeInteger(deployment.context?.slot) && deployment.context.slot >= 0 &&
    slot <= BigInt(deployment.context.slot), 'INVALID_PROGRAM_DEPLOYMENT_SLOT');
  return { ...summary, state: 'deployment-header-verified', deployment: {
    programDataAddress, deployedSlot: String(slot),
    upgradeAuthority: data[12] === 1 ? decode.decode(data.subarray(13, 45)) : null,
  } };
}

export async function inspectNetwork(input, rpcFactory = profile => new Rpc({ profile })) {
  exactKeys(input, ['profile']);
  const profile = networkProfile(input.profile);
  const rpc = rpcFactory(profile.name);
  const genesis = await rpc.verifyCluster();
  requireSafe(genesis === profile.genesis, 'WRONG_CLUSTER');
  const programs = await Promise.all([
    ['Pump', PUMP], ['PumpSwap', PUMP_SWAP],
  ].map(async ([name, address]) => {
    try { return await inspectProgram(rpc, name, address); }
    catch (error) { return { name, address, state: 'inspection-failed', error: shortError(error) }; }
  }));
  const baseline = { profile: profile.name, genesis, programs };
  return frozenJson({ ...baseline, mode: 'read-only-inspection',
    deploymentBaselineDigest: programs.every(program => program.state === 'deployment-header-verified')
      ? digest(baseline) : null,
    executionSupportedByProfile: profile.executionEnabled, journalNamespace: profile.journalNamespace });
}
