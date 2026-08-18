/** Block interleaver: written row-wise, read column-wise, so adjacent coded bits end up rows apart. */
export const INTERLEAVER_WIDTH = 8;

function permutation(length: number, width: number): Uint32Array {
  const rows = Math.ceil(length / width);
  const perm = new Uint32Array(length);
  let k = 0;
  for (let c = 0; c < width; c++) {
    for (let r = 0; r < rows; r++) {
      const idx = r * width + c;
      if (idx < length) perm[k++] = idx;
    }
  }
  return perm;
}

export function interleave(bits: Uint8Array, width = INTERLEAVER_WIDTH): Uint8Array {
  const perm = permutation(bits.length, width);
  const out = new Uint8Array(bits.length);
  for (let k = 0; k < perm.length; k++) out[k] = bits[perm[k]!]!;
  return out;
}

export function deinterleave(values: Float64Array, width = INTERLEAVER_WIDTH): Float64Array {
  const perm = permutation(values.length, width);
  const out = new Float64Array(values.length);
  for (let k = 0; k < perm.length; k++) out[perm[k]!] = values[k]!;
  return out;
}
