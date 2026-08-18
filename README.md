# QNR-144

A weak-signal HF chat modem: 144-tone MFSK, convolutional coding with soft-decision
Viterbi, and exact-repeat correlation across a fixed send/listen schedule.

Decodes at **-23 dB SNR** (3 kHz reference) through a CCIR *worst* Watterson channel
(4 ms delay spread, 2 Hz Doppler). Occupies **2.51 kHz**, so it fits an SSB channel.

There are no modem options. Every parameter is frozen at the value that won its
measurement sweep, so any two copies of this program can always talk to each other.

---

## Install

```bash
npm install
npm run build
```

Requires Node 22+ and PipeWire (`pw-play` / `pw-record`, standard on Ubuntu).

That builds the program but does **not** put it on your `PATH`. Either run it
directly:

```bash
node dist/cli.js tx "CQ DE QNR"
```

or install the `qnr` command once:

```bash
npm link            # creates a global symlink to this checkout
```

If `npm link` fails with a permissions error, either point npm at a user-owned
prefix (`npm config set prefix ~/.local` and make sure `~/.local/bin` is on your
`PATH`) or just use `node dist/cli.js`.

## Use

```bash
qnr tx "CQ DE QNR"             # transmit through the default audio output
qnr tx "CQ DE QNR" -o out.wav  # write the transmission to a WAV file
qnr rx                         # listen on the default audio input
qnr rx -i in.wav               # decode a WAV file
```

Without linking, replace `qnr` with `node dist/cli.js`, or use the npm scripts:

```bash
npm run tx -- "CQ DE QNR"
npm run rx
```

Audio routing is deliberately **not** handled by this program. Start it, then point
the stream at your radio with `pavucontrol` (Playback / Recording tabs).

### The audio tell-tale

Both live modes print a level meter, which is the quickest way to confirm routing:

```
  TX 3/8  [###########################-----]   -9.0 dBFS
  IN      [##############------------------]  -27.4 dBFS  buffer 68%
```

* `TX n/8` — which burst is on air; `gap` means the listening window
* `dBFS` — drive level. Aim for -20..-6 dBFS. A trailing `!` means you are clipping
* `buffer` — how much audio the receiver has collected; it needs 100% before its
  first decode attempt

The receiver retries every 15 s on a sliding window, so it does not matter where in
the schedule you start listening.

---

## How it works

### Transmit

```
 "CQ DE QNR"
      |
      v
 [ pad to 16 chars ]          fixed payload => fixed frame length
      |
      v
 [ CRC-16 + length ]          16 bit length | payload | CRC | 6 tail bits
      |
      v
 [ conv encode K=7 r1/3 ]     1 bit in -> 3 coded bits out
      |
      v
 [ block interleave 64 ]      spreads fade bursts across the frame
      |
      v
 [ pack 7 bits per symbol ]   -> tones 0..127
      |
      v
 [ prepend preamble ]         130,140 x4  (the alternating warble)
      |
      v
 [ continuous-phase MFSK ]    tone n = (85 + 3n) * 48000/8192 Hz
      |
      v
 audio out  ->  8 identical bursts, 8 s apart
```

### The schedule

The same frame is sent 8 times. The gaps are what make it work: they are long
enough for the ionospheric fading to decorrelate, so each burst is an independent
look at the message.

```
 |<-10.4s->|<--8s-->|<-10.4s->|<--8s-->|         total 139 s
 +---------+--------+---------+--------+ ...
 | BURST 1 | listen | BURST 2 | listen |
 +---------+--------+---------+--------+
 |<---------- period = 18.4 s -------->|
```

### Receive

```
 audio in (any start point, no alignment needed)
      |
      v
 [ Goertzel bank, 144 tones ]      power per tone, per window
      |
      v
 [ FOLD modulo 18.4 s period ]     all 8 bursts land on top of each other
      |                            -- the period is known, so no start time is needed
      v
 [ matched filter on preamble ]    finds the frame inside the folded period
      |
      v
 [ per-burst soft metrics ]        tone power / noise floor, per bit
      |
      v
 [ SUM LLRs across bursts ]        <-- this is where the diversity gain comes from
      |
      v
 [ deinterleave -> Viterbi ]
      |
      v
 [ CRC-16 check ]  --fail--> try next candidate start
      |
      v
   "CQ DE QNR"
```

The two stages do different jobs, and both are needed:

* **Folding** solves *acquisition*. Sync energy from all 8 bursts adds together, so
  the preamble is found at an SNR where no single burst could be detected.
* **Summing LLRs** solves *decoding*. Each burst is an independent observation of
  the same coded bits, so their log-likelihoods add. Averaging tone *power* instead
  would only shrink noise variance, and is worth about half as much.

---

## Measured performance

Frozen configuration, 24 trials per cell, random-length noise lead-in on every run.

Decode rate versus SNR (3 kHz reference), CCIR *bad* channel (2 ms / 1 Hz):

| -21 dB | -22 dB | -23 dB | -24 dB | -25 dB |
|--------|--------|--------|--------|--------|
| 100%   | 100%   | 100%   | 38%    | 4%     |

The ~2 dB waterfall is expected: with 8-fold diversity the fading is averaged out
and the channel behaves close to AWGN.

**Listening gap is the highest-leverage parameter.** At -22 dB with 8 repeats, only
the spacing changed:

| Gap | slow 0.1 Hz | bad 1 Hz | worst 2 Hz |
|-----|-------------|----------|------------|
| 1 s | 4%          | 0%       | 0%         |
| 2 s | 38%         | 25%      | 29%        |
| 4 s | 75%         | 67%      | 67%        |
| 8 s | 96%         | 100%     | 100%       |

Same energy, same repeat count. Short gaps put every burst inside one fade, which
makes the diversity illusory.

Other sweeps: rate 1/3 beat rate 1/2 (67% vs 21% at -22 dB); interleaver 64 beat 16;
preamble length made no measurable difference between 2, 4 and 8 pairs.

For context, WSPR decodes to about -29 dB at 0.45 bit/s with 4 tones. This runs
0.81 bit/s with 144 tones, so it is roughly 5 dB behind at nearly double the rate.

---

## Repository layout

| File | Role |
|------|------|
| `src/cli.ts` | the user-facing program |
| `src/protocol.ts` | frozen parameters, the single source of truth |
| `src/tx.ts` | framing, interleaving, continuous-phase modulator |
| `src/fold.ts` | repeat correlation receiver (folding + LLR combining) |
| `src/rx.ts` | streaming single-burst receiver, used by the TUI |
| `src/conv.ts` | convolutional encoder and soft-decision Viterbi |
| `src/detector.ts` | Goertzel bank over the 144 tones |
| `src/channel.ts` | Watterson HF channel simulator |
| `src/audio.ts` | PipeWire capture and playback |
| `src/selftest.ts` | end-to-end tests, no hardware needed |
| `src/foldExperiment.ts` | parameter sweeps across all cores |

```bash
npm run selftest        # verifies FEC and the full modem chain
node dist/foldExperiment.js --trials=24
```

---

## Notes for AI agents working on this code

This project was built by measurement, and several confident-sounding conclusions
turned out to be wrong. If you change the DSP, the following will save you time.

**Verify against the energy budget before you optimise.** The check that repeatedly
caught real bugs:

```
Eb/N0 = SNR_3kHz + 10*log10(3000 / bitrate)
```

Rate 1/2 K=7 soft Viterbi needs about 4.5 dB. When the modem failed at an SNR where
the budget said 10 dB was available, that gap was always an implementation fault --
never physics. Chasing it found the acquisition bottleneck twice.

**Do not trust a small number of trials.** A 2-trial smoke test "showed" that 2 Hz
Doppler outperformed 1 Hz. At 48 trials the opposite was true. With 24 trials, 1σ is
about 10%, so differences under ~15% are noise. Report that uncertainty instead of
ranking within it.

**Watch for results that are true only under the current bottleneck.** Rate 1/3 was
measured as worthless, then as a large win. Both measurements were correct: while
acquisition was failing, extra coding gain had nothing to act on. A result is
conditional on whatever is currently limiting the system.

**Combining soft information is not the same as averaging signals.** Summing tone
power across repeats only reduces noise variance (~3 dB for 4 bursts). Summing LLRs
gives full diversity. Getting this wrong cost most of the available gain and looked
like a tuning problem.

**Prefer protocol knowledge over estimation.** Frame length and repeat period are
fixed by the protocol, so the receiver is told them rather than detecting them.
Every threshold-based estimator that was replaced this way removed a failure mode.

**Parallelise experiments.** `src/pool.ts` spreads cells over all cores; a sweep that
takes an hour single-threaded finishes in minutes. Sweeps are embarrassingly parallel.

**Silence is not signal.** SNR is referenced to the active burst power via
`referencePower`. Averaging over a buffer that includes silent gaps silently changes
the SNR you think you are testing.
