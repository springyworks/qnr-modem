/** Convolutional codes with K=7. Rate 1/2 uses the classic NASA pair; rate 1/3 adds a third polynomial. */
export const CONSTRAINT_LENGTH = 7;
export const TAIL_BITS = CONSTRAINT_LENGTH - 1;
const STATES = 1 << TAIL_BITS;

export type CodeRate = 2 | 3;

const POLYS: Record<CodeRate, number[]> = {
  2: [0o171, 0o133],
  3: [0o133, 0o145, 0o175],
};

const parity = (v: number): number => {
  let x = v;
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return x & 1;
};

interface Trellis {
  n: number;
  next: Uint8Array;
  outs: Uint8Array[];
}

const cache = new Map<CodeRate, Trellis>();

function trellis(rate: CodeRate): Trellis {
  const hit = cache.get(rate);
  if (hit) return hit;

  const polys = POLYS[rate];
  const next = new Uint8Array(STATES * 2);
  const outs = polys.map(() => new Uint8Array(STATES * 2));

  for (let state = 0; state < STATES; state++) {
    for (let bit = 0; bit < 2; bit++) {
      const reg = ((state << 1) | bit) & 0x7f;
      const i = state * 2 + bit;
      next[i] = reg & (STATES - 1);
      polys.forEach((poly, p) => {
        outs[p]![i] = parity(reg & poly);
      });
    }
  }

  const built: Trellis = { n: polys.length, next, outs };
  cache.set(rate, built);
  return built;
}

export function convEncode(bits: Uint8Array, rate: CodeRate = 2): Uint8Array {
  const { n, next, outs } = trellis(rate);
  const out = new Uint8Array(bits.length * n);
  let state = 0;
  for (let i = 0; i < bits.length; i++) {
    const idx = state * 2 + (bits[i]! & 1);
    for (let p = 0; p < n; p++) out[i * n + p] = outs[p]![idx]!;
    state = next[idx]!;
  }
  return out;
}

/**
 * Soft-decision Viterbi. Input LLRs are positive when a 1 is more likely.
 * Assumes the encoder starts and ends in state 0 (zero-terminated by tail bits).
 */
export function viterbiDecode(llr: Float64Array, rate: CodeRate = 2): Uint8Array {
  const { n, next, outs } = trellis(rate);
  const steps = Math.floor(llr.length / n);
  if (steps === 0) return new Uint8Array(0);

  const NEG = -1e9;
  let metric = new Float64Array(STATES).fill(NEG);
  let nextMetric = new Float64Array(STATES);
  metric[0] = 0;

  // The oldest register bit is lost in the successor state, so store predecessors explicitly.
  const prevState = new Uint8Array(steps * STATES);
  const prevBit = new Uint8Array(steps * STATES);

  for (let t = 0; t < steps; t++) {
    nextMetric.fill(NEG);
    const base = t * n;

    for (let state = 0; state < STATES; state++) {
      const m = metric[state]!;
      if (m === NEG) continue;

      for (let bit = 0; bit < 2; bit++) {
        const idx = state * 2 + bit;
        let branch = 0;
        for (let p = 0; p < n; p++) {
          const l = llr[base + p]!;
          branch += outs[p]![idx] ? l : -l;
        }
        const cand = m + branch;
        const ns = next[idx]!;
        if (cand > nextMetric[ns]!) {
          nextMetric[ns] = cand;
          prevState[t * STATES + ns] = state;
          prevBit[t * STATES + ns] = bit;
        }
      }
    }

    const swap = metric;
    metric = nextMetric;
    nextMetric = swap;
  }

  // Tail bits force the encoder back to state 0, so traceback starts there.
  let state = 0;
  const bits = new Uint8Array(steps);
  for (let t = steps - 1; t >= 0; t--) {
    const slot = t * STATES + state;
    bits[t] = prevBit[slot]!;
    state = prevState[slot]!;
  }
  return bits;
}
