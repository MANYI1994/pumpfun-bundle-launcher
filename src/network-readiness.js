import { PUMP } from './transactions.js';
import { PUMP_SWAP } from './migration.js';
import { networkProfile } from './network-profiles.js';
import { Rpc } from './network.js';
import { exactKeys, frozenJson } from './security.js';

export async function inspectNetwork(input) {
  exactKeys(input, ['profile']);
  const profile = networkProfile(input.profile);
  const rpc = new Rpc({ profile: profile.name });
  const genesis = await rpc.verifyCluster();
  const programs = await Promise.all([
    ['Pump', PUMP], ['PumpSwap', PUMP_SWAP],
  ].map(async ([name, address]) => {
    const result = await rpc.read('getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
    return { name, address, present: Boolean(result?.value), executable: result?.value?.executable === true,
      owner: typeof result?.value?.owner === 'string' ? result.value.owner : null };
  }));
  return frozenJson({ profile: profile.name, genesis, programs, mode: 'read-only-inspection',
    executionSupportedByProfile: profile.executionEnabled, journalNamespace: profile.journalNamespace });
}
