/**
 * Physical layout of sync markers within one burst: instead of clustering every alternating
 * SYNC1/SYNC2 pair up front (a jarring block ahead of the musical 144-tone data), one pair is
 * placed before each of `preamblePairs` evenly-sized data chunks -- pair, chunk, pair, chunk...
 * The very first pair still lands at burst position 0, so the streaming/off-grid receiver
 * (rx.ts) keeps its existing clock-lock edge unchanged; any later pair that lands mid-burst is
 * already tolerated by rx.ts's existing erasure handling (any symbol >127 is treated as a lost
 * data slot). Total marker/data/idle symbol count is unchanged, so burst duration is unchanged.
 * tx.ts (encode) and fold.ts/tune.ts (decode) must all agree on this layout.
 */
function chunkSize(dataSymbols: number, preamblePairs: number): number {
  return Math.ceil(dataSymbols / preamblePairs);
}

/** Symbol-index positions (within one burst, 0-based) holding a sync marker, alternating
 * SYM_SYNC_1 (even index) / SYM_SYNC_2 (odd index). */
export function syncMarkerPositions(dataSymbols: number, preamblePairs: number): number[] {
  const size = chunkSize(dataSymbols, preamblePairs);
  const positions: number[] = [];
  let pos = 0;
  for (let i = 0; i < preamblePairs; i++) {
    positions.push(pos, pos + 1);
    pos += 2 + Math.min(size, Math.max(0, dataSymbols - i * size));
  }
  return positions;
}

/** Physical burst offset of each logical data symbol -- inverse of `syncMarkerPositions`. */
export function dataSymbolOffsets(dataSymbols: number, preamblePairs: number): number[] {
  const size = chunkSize(dataSymbols, preamblePairs);
  const offsets = new Array<number>(dataSymbols);
  let pos = 0;
  let k = 0;
  for (let i = 0; i < preamblePairs; i++) {
    pos += 2;
    const n = Math.min(size, Math.max(0, dataSymbols - i * size));
    for (let j = 0; j < n; j++) offsets[k++] = pos + j;
    pos += n;
  }
  return offsets;
}

/** Splices sync markers between chunks of `dataSymbols`; inverse layout of `dataSymbolOffsets`. */
export function distributeSync(dataSymbols: number[], preamblePairs: number, sync1: number, sync2: number): number[] {
  const size = chunkSize(dataSymbols.length, preamblePairs);
  const out: number[] = [];
  for (let i = 0; i < preamblePairs; i++) {
    out.push(sync1, sync2);
    out.push(...dataSymbols.slice(i * size, (i + 1) * size));
  }
  return out;
}
