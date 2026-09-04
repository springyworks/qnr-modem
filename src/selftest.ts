import { SAMPLE_RATE, type FecMode } from './config.js';
import { createAudioIdentity } from './audio.js';
import { convEncode, viterbiDecode } from './conv.js';
import { foldDecodeAll } from './fold.js';
import { buildInfoBits, parseInfoBits } from './framing.js';
import { hammingDecode, hammingEncode } from './hamming.js';
import { decodeChatMessage, encodeChatMessage } from './packet.js';
import {
  BAUD,
  DATA_SYMBOLS,
  DECODE_OPTIONS,
  FRAME_OPTIONS,
  GUARD_SAMPLES,
  PAYLOAD_BYTES,
  PERIOD_SAMPLES,
  SLOT_SAMPLES,
} from './protocol.js';
import { Receiver, type ReceiverOptions } from './rx.js';
import { modulate, modulateChatMessage } from './tx.js';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function testHamming(): void {
  console.log('Hamming(7,4)');
  let roundTrip = true;
  let correctedAll = true;

  for (let nibble = 0; nibble < 16; nibble++) {
    const block = hammingEncode(nibble);
    if (hammingDecode(block).nibble !== nibble) roundTrip = false;

    for (let bit = 0; bit < 7; bit++) {
      const res = hammingDecode(block ^ (1 << bit));
      if (res.nibble !== nibble || !res.corrected) correctedAll = false;
    }
  }

  check('clean blocks decode to original nibble', roundTrip);
  check('every single-bit error is corrected', correctedAll);
}

function decodeSamples(samples: Float32Array, baud: number, mode: FecMode = 'hamming', opts: ReceiverOptions = {}): string {
  let text = '';
  const rx = new Receiver(baud, { onChar: (ch) => (text += ch) }, SAMPLE_RATE, mode, opts);
  const chunk = 4096;
  for (let i = 0; i < samples.length; i += chunk) {
    rx.push(samples.subarray(i, Math.min(i + chunk, samples.length)));
  }
  return text;
}

function withSilence(signal: Float32Array, padSamples: number, noise = 0): Float32Array {
  const out = new Float32Array(signal.length + padSamples * 2);
  out.set(signal, padSamples);
  if (noise > 0) {
    for (let i = 0; i < out.length; i++) {
      const u = Math.max(Math.random(), 1e-12);
      out[i]! += noise * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
    }
  }
  return out;
}

function testModemLoopback(): void {
  const message = 'CQ CQ ROS TEST';
  console.log('MFSK loopback (no audio hardware)');

  for (const baud of [2, 4, 8]) {
    const signal = withSilence(modulate(message, baud), SAMPLE_RATE / 4);
    const decoded = decodeSamples(signal, baud);
    check(`${baud} Bd decodes exactly`, decoded === message, `got "${decoded}"`);
  }
}

function testNoisyChannel(): void {
  console.log('MFSK with additive noise');
  const message = 'ROS 144';
  const signal = withSilence(modulate(message, 4), SAMPLE_RATE / 4, 0.05);
  const decoded = decodeSamples(signal, 4);
  check('4 Bd survives noise at 0.05 sigma', decoded === message, `got "${decoded}"`);
}

function bitsToLlr(bits: Uint8Array, flip: number[] = []): Float64Array {
  const llr = Float64Array.from(bits, (b) => (b ? 1 : -1));
  for (const i of flip) llr[i] = -llr[i]!;
  return llr;
}

function testConvCode(): void {
  console.log('Convolutional K=7 rate 1/2 + Viterbi');
  const info = buildInfoBits(Uint8Array.from([0x41, 0x42, 0x43]));
  const coded = convEncode(info);

  const clean = viterbiDecode(bitsToLlr(coded));
  check('clean soft input recovers info bits', clean.subarray(0, info.length).every((b, i) => b === info[i]));

  const damaged = viterbiDecode(bitsToLlr(coded, [3, 17, 40, 91]));
  const parsed = parseInfoBits(damaged);
  check('4 scattered bit errors are corrected', parsed.ok, parsed.reason ?? '');

  const corrupted = Uint8Array.from(info);
  corrupted[LENGTH_OFFSET] ^= 1;
  check('CRC rejects a corrupted frame', !parseInfoBits(corrupted).ok);
}

function testConvModem(): void {
  console.log('MFSK conv mode loopback');
  const message = 'CQ DE QNR 144';
  for (const baud of [4, 8]) {
    const signal = withSilence(modulate(message, baud, 0.5, SAMPLE_RATE, 'conv'), SAMPLE_RATE / 4);
    const decoded = decodeSamples(signal, baud, 'conv');
    check(`${baud} Bd conv frame decodes with valid CRC`, decoded === message, `got "${decoded}"`);
  }
}

function testChatMessage(): void {
  console.log('Chat message frame');
  const encoded = encodeChatMessage('HELLO WORLD 12345');
  const decoded = decodeChatMessage(encoded);
  check('truncates to 16 payload characters', decoded === 'HELLO WORLD 1234', `got "${decoded}"`);

  const short = decodeChatMessage(encodeChatMessage('HI'));
  check('short messages round-trip without padding', short === 'HI', `got "${short}"`);

  const identity = createAudioIdentity(new Date(2026, 7, 21, 8, 5), 4242);
  check('PipeWire station labels carry time and process identity', identity.label === 'QNR 08:05 #4242' && identity.id === 'qnr-0805-4242');
}

function testChatMessageModem(): void {
  console.log('Chat message MFSK loopback');
  const expected = 'CQ CQ DE QNR';
  const signal = withSilence(
    modulateChatMessage(encodeChatMessage(expected), DATA_SYMBOLS, BAUD, 0.5, SAMPLE_RATE, FRAME_OPTIONS),
    SAMPLE_RATE / 4
  );
  const decoded = decodeChatMessage(
    decodeSamples(signal, BAUD, 'conv', {
      interleaverWidth: FRAME_OPTIONS.interleaverWidth,
      rate: FRAME_OPTIONS.rate,
      maxPayloadBytes: PAYLOAD_BYTES,
      dataSymbols: DATA_SYMBOLS,
      preamblePairs: FRAME_OPTIONS.preamblePairs,
    })
  );
  check('chat frame survives FEC and CRC', decoded === expected, `got ${JSON.stringify(decoded)}`);

  const shortExpected = 'HI';
  const shortSignal = withSilence(
    modulateChatMessage(encodeChatMessage(shortExpected), DATA_SYMBOLS, BAUD, 0.5, SAMPLE_RATE, FRAME_OPTIONS),
    SAMPLE_RATE / 4
  );
  const shortDecoded = decodeChatMessage(
    decodeSamples(shortSignal, BAUD, 'conv', {
      interleaverWidth: FRAME_OPTIONS.interleaverWidth,
      rate: FRAME_OPTIONS.rate,
      maxPayloadBytes: PAYLOAD_BYTES,
      dataSymbols: DATA_SYMBOLS,
      preamblePairs: FRAME_OPTIONS.preamblePairs,
    })
  );
  check(
    'a short message tiles its coded unit to fill the fixed burst',
    shortDecoded === shortExpected,
    `got ${JSON.stringify(shortDecoded)}`
  );
}

function addSignal(target: Float32Array, signal: Float32Array, start: number): void {
  for (let sampleIndex = 0; sampleIndex < signal.length; sampleIndex++) {
    target[start + sampleIndex]! += signal[sampleIndex]!;
  }
}

function testInterleavedFoldedStations(): void {
  console.log('Two-frame chat repeat folding');
  const messageA = 'STATION A';
  const messageB = 'STATION B';
  const burstA = modulateChatMessage(encodeChatMessage(messageA), DATA_SYMBOLS, BAUD, 0.5, SAMPLE_RATE, FRAME_OPTIONS);
  const burstB = modulateChatMessage(encodeChatMessage(messageB), DATA_SYMBOLS, BAUD, 0.5, SAMPLE_RATE, FRAME_OPTIONS);
  const repeats = 2;
  const lead = Math.round(SAMPLE_RATE * 0.37);
  const samples = new Float32Array(lead + repeats * PERIOD_SAMPLES);

  for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
    const periodStart = lead + repeatIndex * PERIOD_SAMPLES;
    addSignal(samples, burstA, periodStart + GUARD_SAMPLES);
    addSignal(samples, burstB, periodStart + SLOT_SAMPLES + GUARD_SAMPLES);
  }

  const results = foldDecodeAll(samples, DECODE_OPTIONS);
  const stationA = results.find((result) => decodeChatMessage(result.text) === messageA);
  const stationB = results.find((result) => decodeChatMessage(result.text) === messageB);
  check('transmit and rx frames both decode', Boolean(stationA && stationB));
  check(
    'each station combines its own repeats',
    stationA?.bursts === repeats && stationB?.bursts === repeats,
    `got A=${stationA?.bursts ?? 0}, B=${stationB?.bursts ?? 0}`
  );
}

const LENGTH_OFFSET = 20;

testHamming();
testModemLoopback();
testNoisyChannel();
testConvCode();
testConvModem();
testChatMessage();
testChatMessageModem();
testInterleavedFoldedStations();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
