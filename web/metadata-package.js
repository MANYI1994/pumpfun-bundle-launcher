const utf8 = new TextEncoder();
const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes) {
  let output = '', bits = 0, value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function varint(value) {
  const bytes = [];
  while (value >= 128) {
    bytes.push((value % 128) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

export async function rawContentId(data) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const cid = Uint8Array.of(1, 0x55, 0x12, 32, ...hash);
  return { cid, text: 'b' + base32(cid) };
}

async function rawBlock(data) {
  const { cid, text } = await rawContentId(data);
  // DAG-CBOR CARv1 header: { roots: [CID], version: 1 }.
  const header = Uint8Array.of(0xa2, 0x65, ...utf8.encode('roots'), 0x81,
    0xd8, 42, 0x58, cid.length + 1, 0, ...cid, 0x67, ...utf8.encode('version'), 1);
  return {
    cid: text,
    url: 'https:' + '//ipfs.io/ipfs/' + text,
    parts: [varint(header.length), header, varint(cid.length + data.length), cid, data],
  };
}

function supportedImage(data) {
  const prefix = (...expected) => expected.every((byte, index) => data[index] === byte);
  return prefix(137, 80, 78, 71, 13, 10, 26, 10) || prefix(255, 216, 255) ||
    (prefix(82, 73, 70, 70) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80);
}

export async function packageMetadata(image, metadata, validateMetadata) {
  if (!image || image.size < 12 || image.size > 262144) throw new Error('Choose a PNG, JPEG or WebP image up to 256 KiB.');
  const imageBytes = new Uint8Array(await image.arrayBuffer());
  if (!supportedImage(imageBytes)) throw new Error('Image format must be PNG, JPEG or WebP.');
  const imageBlock = await rawBlock(imageBytes);
  const manifest = await validateMetadata({ ...metadata, image: imageBlock.url });
  const metadataBlock = await rawBlock(utf8.encode(JSON.stringify(manifest)));
  return { imageBlock, metadataBlock };
}

export function downloadCar(block, filename) {
  const url = URL.createObjectURL(new Blob(block.parts, { type: 'application/vnd.ipld.car' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
