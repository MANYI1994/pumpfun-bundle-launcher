import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyPairSignerFromPrivateKeyBytes, getTransactionDecoder, partiallySignTransaction, signTransaction, getBase64EncodedWireTransaction } from '@solana/kit';
import { reviewTokenCreation } from '../src/create-token.js';
import { verifyCreationSignatures } from '../src/create-verification.js';

test('creation verification merges independently signed wires in canonical order', async () => {
  const creator = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(1));
  const mint = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(2));
  const envelope = await reviewTokenCreation({
    metadata: { name: 'Test', symbol: 'TST', description: 'Test mint', image: 'https://example.com/image.png' },
    metadataUri: 'https://example.com/metadata.json', creatorAddress: creator.address, mintAddress: mint.address,
  }, { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100n });
  const tx = getTransactionDecoder().decode(Buffer.from(envelope.review.unsignedWireBase64, 'base64'));
  const creatorWire = getBase64EncodedWireTransaction(await partiallySignTransaction([creator.keyPair], tx));
  const mintWire = getBase64EncodedWireTransaction(await partiallySignTransaction([mint.keyPair], tx));
  await assert.rejects(verifyCreationSignatures(envelope, envelope.digest, [mintWire]), /MINT_AND_CREATOR/);
  const result = await verifyCreationSignatures(envelope, envelope.digest, [mintWire, creatorWire]);
  assert.equal(result.signedWireBase64, getBase64EncodedWireTransaction(await signTransaction([creator.keyPair, mint.keyPair], tx)));
});
