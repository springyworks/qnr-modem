export interface HammingResult {
  nibble: number;
  corrected: boolean;
}

export function hammingEncode(nibble: number): number {
  const d1 = (nibble >> 3) & 1;
  const d2 = (nibble >> 2) & 1;
  const d3 = (nibble >> 1) & 1;
  const d4 = nibble & 1;
  const p1 = d1 ^ d2 ^ d4;
  const p2 = d1 ^ d3 ^ d4;
  const p3 = d2 ^ d3 ^ d4;
  return (p1 << 6) | (p2 << 5) | (d1 << 4) | (p3 << 3) | (d2 << 2) | (d3 << 1) | d4;
}

export function hammingDecode(block: number): HammingResult {
  const p1 = (block >> 6) & 1;
  const p2 = (block >> 5) & 1;
  const d1 = (block >> 4) & 1;
  const p3 = (block >> 3) & 1;
  const d2 = (block >> 2) & 1;
  const d3 = (block >> 1) & 1;
  const d4 = block & 1;

  const z1 = p1 ^ d1 ^ d2 ^ d4;
  const z2 = p2 ^ d1 ^ d3 ^ d4;
  const z3 = p3 ^ d2 ^ d3 ^ d4;
  const syndrome = (z3 << 2) | (z2 << 1) | z1;

  let corrected = block;
  let wasCorrected = false;
  if (syndrome !== 0) {
    corrected ^= 1 << (7 - syndrome);
    wasCorrected = true;
  }

  const cd1 = (corrected >> 4) & 1;
  const cd2 = (corrected >> 2) & 1;
  const cd3 = (corrected >> 1) & 1;
  const cd4 = corrected & 1;
  return { nibble: (cd1 << 3) | (cd2 << 2) | (cd3 << 1) | cd4, corrected: wasCorrected };
}
