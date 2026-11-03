import { AccountRole, compileTransaction, getAddressEncoder, getBase64EncodedWireTransaction, getProgramDerivedAddress } from '@solana/kit';
import { ASSOCIATED, PUMP, SYSTEM, bounded, message, transactionFingerprint } from './transactions.js';
import { digest, exactKeys, frozenJson, requireSafe, validAddress } from './security.js';

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MAYHEM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';
const encoder = getAddressEncoder();
const bytes = address => encoder.encode(address);
async function derive(programAddress, label, ...seeds) {
  return (await getProgramDerivedAddress({ programAddress, seeds: label ? [Buffer.from(label), ...seeds] : seeds }))[0];
}
function stringField(value, maxBytes) {
  requireSafe(typeof value === 'string' && value.trim() === value && value.length > 0 &&
    Buffer.byteLength(value) <= maxBytes && !/[\p{C}]/u.test(value), 'INVALID_METADATA_TEXT');
  return value;
}
function httpsField(value) {
  stringField(value, 200);
  let url;
  try { url = new URL(value); } catch { requireSafe(false, 'INVALID_METADATA_URL'); }
  requireSafe(url.protocol === 'https:' && !url.username && !url.password &&
    !url.search && !url.hash && url.href === value, 'INVALID_METADATA_URL');
  return value;
}
function borshString(value) {
  const content = Buffer.from(value);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(content.length);
  return Buffer.concat([size, content]);
}

export function tokenMetadata(input) {
  exactKeys(input, ['name', 'symbol', 'description', 'image']);
  return frozenJson({
    name: stringField(input.name, 32),
    symbol: stringField(input.symbol, 10),
    description: stringField(input.description, 1000),
    image: httpsField(input.image),
  });
}

export async function reviewTokenCreation(input, lifetime) {
  exactKeys(input, ['metadata', 'metadataUri', 'creatorAddress', 'mintAddress']);
  const metadata = tokenMetadata(input.metadata);
  const metadataUri = httpsField(input.metadataUri);
  const creator = validAddress(input.creatorAddress);
  const mint = validAddress(input.mintAddress);
  requireSafe(creator !== mint, 'MINT_AND_CREATOR_MUST_DIFFER');
  const blockhash = validAddress(lifetime.blockhash);
  const lastValidBlockHeight = lifetime.lastValidBlockHeight;
  const [authority, curve, global, globalParams, solVault, mayhemState, eventAuthority] = await Promise.all([
    derive(PUMP, 'mint-authority'), derive(PUMP, 'bonding-curve', bytes(mint)),
    derive(PUMP, 'global'), derive(MAYHEM, 'global-params'), derive(MAYHEM, 'sol-vault'),
    derive(MAYHEM, 'mayhem-state', bytes(mint)), derive(PUMP, '__event_authority'),
  ]);
  const [curveAta, mayhemVault] = await Promise.all([
    derive(ASSOCIATED, null, bytes(curve), bytes(TOKEN_2022), bytes(mint)),
    derive(ASSOCIATED, null, bytes(solVault), bytes(TOKEN_2022), bytes(mint)),
  ]);
  const R = AccountRole.READONLY, W = AccountRole.WRITABLE, S = AccountRole.WRITABLE_SIGNER;
  const accounts = [
    [mint, S], [authority, R], [curve, W], [curveAta, W], [global, R], [creator, S],
    [SYSTEM, R], [TOKEN_2022, R], [ASSOCIATED, R], [MAYHEM, W], [globalParams, R],
    [solVault, W], [mayhemState, W], [mayhemVault, W], [eventAuthority, R], [PUMP, R],
  ].map(([address, role]) => ({ address, role }));
  const data = Buffer.concat([
    Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]),
    borshString(metadata.name), borshString(metadata.symbol), borshString(metadataUri),
    bytes(creator), Buffer.alloc(11),
  ]);
  const tx = bounded(compileTransaction(message(creator, { blockhash, lastValidBlockHeight },
    [{ programAddress: PUMP, accounts, data }])));
  const review = {
    cluster: 'devnet', action: 'create', program: PUMP, metadata, metadataUri,
    mintAddress: mint, creatorAddress: creator, bondingCurve: curve,
    blockhash, lastValidBlockHeight: String(lastValidBlockHeight),
    requiredSigners: Object.keys(tx.signatures), fingerprint: transactionFingerprint(tx),
    unsignedWireBase64: getBase64EncodedWireTransaction(tx),
    signingAllowed: false, broadcast: false,
  };
  return frozenJson({ review, digest: digest(review) });
}
