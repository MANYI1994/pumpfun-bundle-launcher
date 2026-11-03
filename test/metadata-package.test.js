import test from 'node:test';
import assert from 'node:assert/strict';
import { packageMetadata } from '../web/metadata-package.js';
import { tokenMetadata } from '../src/create-token.js';

test('metadata package uses the image content ID in the hashed manifest', async () => {
  const fixture = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0);
  const { imageBlock, metadataBlock } = await packageMetadata(new Blob([fixture]), {
    name: 'Devnet token', symbol: 'DVT', description: 'Test metadata',
  }, tokenMetadata);
  assert.equal(imageBlock.cid, 'bafkreia3k22qvrhjo32ir4jizk64375s7sjtdvuxjo4znajruqk5csw6eq');
  assert.deepEqual(imageBlock.parts.at(-1), fixture);
  const manifest = JSON.parse(new TextDecoder().decode(metadataBlock.parts.at(-1)));
  assert.equal(manifest.image, imageBlock.url);
  assert.notEqual(metadataBlock.cid, imageBlock.cid);
});
