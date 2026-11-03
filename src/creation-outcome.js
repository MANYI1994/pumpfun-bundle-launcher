import { getAddressEncoder, getBase58Decoder, getProgramDerivedAddress } from '@solana/kit';
import { requireSafe, validAddress } from './security.js';
import { PUMP } from './transactions.js';

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const CURVE_TAG = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
const decode = getBase58Decoder();
const encode = getAddressEncoder();

async function finalizedData(rpc, address, program) {
  const response = await rpc.read('getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
  const account = response?.value;
  requireSafe(account?.owner === program && account.executable === false &&
    Array.isArray(account.data) && account.data[1] === 'base64' &&
    typeof account.data[0] === 'string', 'CREATION_ACCOUNT_NOT_VERIFIED');
  const data = Buffer.from(account.data[0], 'base64');
  requireSafe(data.toString('base64') === account.data[0], 'CREATION_ACCOUNT_NOT_VERIFIED');
  return data;
}

function authority(data, offset) {
  const present = data.readUInt32LE(offset);
  requireSafe(present === 0 || present === 1, 'INVALID_MINT_AUTHORITY');
  return present === 0 ? null : decode.decode(data.subarray(offset + 4, offset + 36));
}

export async function inspectCreatedMint(rpc, mintAddress, expectedCreator) {
  validAddress(mintAddress);
  validAddress(expectedCreator);
  const [bondingCurve] = await getProgramDerivedAddress({
    programAddress: PUMP, seeds: [Buffer.from('bonding-curve'), encode.encode(mintAddress)],
  });
  const [mint, curve] = await Promise.all([
    finalizedData(rpc, mintAddress, TOKEN_2022),
    finalizedData(rpc, bondingCurve, PUMP),
  ]);
  requireSafe(mint.length >= 82 && mint[45] === 1, 'CREATED_MINT_NOT_INITIALIZED');
  requireSafe(curve.length >= 81 && curve.subarray(0, 8).equals(CURVE_TAG) &&
    [0, 1].includes(curve[48]), 'CREATED_CURVE_NOT_VERIFIED');
  const creator = decode.decode(curve.subarray(49, 81));
  return {
    mintAddress, bondingCurve, tokenProgram: TOKEN_2022,
    creator, creatorMatches: creator === expectedCreator, decimals: mint[44],
    supplyRaw: String(mint.readBigUInt64LE(36)), curveComplete: curve[48] === 1,
    mintAuthority: authority(mint, 0), freezeAuthority: authority(mint, 46),
  };
}
