const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

function updateByte(hash, byte) {
  return ((hash ^ BigInt(byte)) * FNV_PRIME_64) & UINT64_MASK;
}

// These IDs are deterministic record locators, not authentication secrets.
// Processing both UTF-16 bytes keeps the result identical in Node and browsers.
export function stableHexId(value) {
  let hash = FNV_OFFSET_64;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash = updateByte(hash, code & 0xff);
    hash = updateByte(hash, code >>> 8);
  }
  return hash.toString(16).padStart(16, "0");
}
