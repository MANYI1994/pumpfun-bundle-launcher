import { rawContentId } from '../web/metadata-package.js';
import { tokenMetadata } from './create-token.js';
import { canonical, exactKeys, requireSafe } from './security.js';

const GATEWAY = 'https://ipfs.io/ipfs/';
const RAW_CID = /^b[a-z2-7]{58}$/;

async function readPublishedBlock(url, maxBytes, fetchImpl) {
  requireSafe(typeof url === 'string' && url.startsWith(GATEWAY), 'PACKAGE_IPFS_URL_REQUIRED');
  const expected = url.slice(GATEWAY.length);
  requireSafe(RAW_CID.test(expected), 'PACKAGE_IPFS_URL_REQUIRED');
  const response = await fetchImpl(GATEWAY + expected, {
    redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { accept: 'application/vnd.ipld.raw' },
  });
  requireSafe(response.ok && response.body, 'PUBLISHED_BLOCK_UNAVAILABLE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireSafe(size <= maxBytes, 'PUBLISHED_BLOCK_TOO_LARGE');
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  const { text } = await rawContentId(data);
  requireSafe(text === expected, 'PUBLISHED_CONTENT_ID_MISMATCH');
  return data;
}

export async function verifyMetadataPublication(input, fetchImpl = fetch) {
  exactKeys(input, ['metadata', 'metadataUri']);
  const expected = tokenMetadata(input.metadata);
  const [metadataBytes, imageBytes] = await Promise.all([
    readPublishedBlock(input.metadataUri, 8192, fetchImpl),
    readPublishedBlock(expected.image, 262144, fetchImpl),
  ]);
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)); }
  catch { requireSafe(false, 'PUBLISHED_METADATA_INVALID_JSON'); }
  requireSafe(canonical(tokenMetadata(manifest)) === canonical(expected), 'PUBLISHED_METADATA_DIFFERS_FROM_FORM');
  return { verified: true, metadataUri: input.metadataUri, imageUri: expected.image,
    metadataBytes: metadataBytes.length, imageBytes: imageBytes.length, checkedAt: Date.now() };
}
