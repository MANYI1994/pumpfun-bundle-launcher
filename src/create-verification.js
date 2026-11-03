import { getAddressEncoder, getBase64EncodedWireTransaction, getTransactionDecoder } from '@solana/kit';
import { reviewTokenCreation } from './create-token.js';
import { equalDigest, exactKeys, frozenJson, raw, requireSafe } from './security.js';

function decodeWire(wire) {
  requireSafe(typeof wire === 'string' && wire.length <= 1644, 'INVALID_CREATION_WIRE');
  const bytes = Buffer.from(wire, 'base64');
  requireSafe(bytes.length > 0 && bytes.length <= 1232 && bytes.toString('base64') === wire, 'INVALID_CREATION_WIRE');
  let transaction;
  try { transaction = getTransactionDecoder().decode(bytes); }
  catch { requireSafe(false, 'INVALID_CREATION_WIRE'); }
  requireSafe(getBase64EncodedWireTransaction(transaction) === wire, 'INVALID_CREATION_WIRE');
  return transaction;
}

export async function verifyCreationSignatures(envelope, confirmation, signedWires) {
  exactKeys(envelope, ['review', 'digest']);
  requireSafe(equalDigest(confirmation, envelope.digest), 'CREATION_REVIEW_NOT_APPROVED');
  const review = frozenJson(envelope.review);
  const expected = await reviewTokenCreation({
    metadata: review.metadata, metadataUri: review.metadataUri,
    creatorAddress: review.creatorAddress, mintAddress: review.mintAddress,
  }, { blockhash: review.blockhash, lastValidBlockHeight: raw(review.lastValidBlockHeight) });
  requireSafe(equalDigest(expected.digest, confirmation) &&
    JSON.stringify(frozenJson(expected.review)) === JSON.stringify(review), 'CREATION_REVIEW_CHANGED');
  requireSafe(Array.isArray(signedWires) && signedWires.length >= 1 && signedWires.length <= 2, 'INVALID_CREATION_SIGNED_WIRES');

  const unsigned = decodeWire(expected.review.unsignedWireBase64);
  const required = expected.review.requiredSigners;
  const signatures = Object.fromEntries(required.map(address => [address, null]));
  for (const wire of signedWires) {
    const transaction = decodeWire(wire);
    requireSafe(Buffer.from(transaction.messageBytes).equals(Buffer.from(unsigned.messageBytes)), 'CREATION_MESSAGE_CHANGED');
    requireSafe(Object.keys(transaction.signatures).length === required.length &&
      required.every(address => Object.hasOwn(transaction.signatures, address)), 'CREATION_SIGNERS_CHANGED');
    for (const address of required) {
      const signature = transaction.signatures[address];
      if (!signature || signature.every(byte => byte === 0)) continue;
      const publicKey = await crypto.subtle.importKey('raw', getAddressEncoder().encode(address), 'Ed25519', false, ['verify']);
      requireSafe(await crypto.subtle.verify('Ed25519', publicKey, signature, unsigned.messageBytes), 'INVALID_CREATION_SIGNATURE');
      signatures[address] = signature;
    }
  }
  requireSafe(required.every(address => signatures[address]), 'MINT_AND_CREATOR_SIGNATURES_REQUIRED');
  return frozenJson({ verified: true, reviewDigest: expected.digest, fingerprint: expected.review.fingerprint,
    mintAddress: review.mintAddress, creatorAddress: review.creatorAddress,
    signedWireBase64: getBase64EncodedWireTransaction({ ...unsigned, signatures }), broadcast: false });
}
