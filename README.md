# QNR-144

A weak-signal HF chat modem: 144-tone MFSK, convolutional coding with
soft-decision Viterbi, exact-repeat correlation, and a fixed three-basic-frame
send/listen/listen schedule.

Decodes at **-20 dB SNR** (3 kHz reference) through a CCIR *bad* Watterson channel
(2 ms delay spread, 1 Hz Doppler). Occupies **2.51 kHz**, so it fits an SSB channel.

SNR is referenced to power **while transmitting**, not averaged over the listening
gaps. That distinction matters here: this modem is idle most of the time, and
averaging over the gaps would make the figure look better the longer they get.

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
node dist/cli.js tx "CQ QNR"
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
qnr tx "CQ QNR"                # transmit one chat message through the default audio output
qnr tx "HELLO" -o out.wav      # write a chat transmission to a WAV file
qnr rx                         # listen on the default audio input
qnr rx -i in.wav               # decode a WAV file
qnr rx -i in.wav --jobs=4      # cap the decoder to 4 threads
qnr rxtx                       # listen continuously, ready to send chat messages
qnr rxtx "HELLO"               # queue one message and listen at the same time
qnr rxtx -tui                  # full-screen chat station dashboard
```

The receiver uses every core but one, so the machine stays usable while it works.
`--jobs=N` overrides that. Input WAVs are accepted at any sample rate and in 8/16/24/32-bit
PCM or float, and are resampled to 48 kHz internally.

Without linking, replace `qnr` with `node dist/cli.js`, or use the npm scripts:

```bash
npm run tx -- "C"
npm run rx
```

Audio routing is deliberately **not** handled by this program. Start it, then point
the named stream at your radio with `pavucontrol` (Playback / Recording tabs). Each
running station owns persistent `QNR mm:ss #pid TX` and `QNR mm:ss #pid RX` streams;
the process ID keeps two stations distinct even when started in the same minute.

### Command reference

```text
NAME
       qnr - 144-tone MFSK weak-signal HF chat modem

SYNOPSIS
       qnr tx MESSAGE [-o FILE] [--snr=DB --profile=NAME [--seed=N]] [--jobs=N]
       qnr rx [-i FILE] [--jobs=N]
       qnr rxtx [MESSAGE] [-tui] [--jobs=N]
       qnr

DESCRIPTION
       qnr transmits and receives a fixed-format 144-tone MFSK frame over a
       sound card and, optionally, a radio. There are no modem options: baud
       rate, coding, interleaving, and the send/listen schedule are frozen in
       the protocol (src/protocol.ts), so any two builds of qnr can always
       talk to each other. The only choices left to the operator are the
       message text, an output/input file, and how many worker threads
       decode.

       Called with no arguments, qnr prints this summary and exits 1.

COMMANDS
       tx MESSAGE
              Transmit one printable ASCII chat message through the default
              audio output. Messages are limited to 16 payload characters and
              are zero-padded before framing. The frame has CRC-16,
              convolutional coding (K=7, rate 1/3), and interleaving.

       rx     Listen on the default audio input and decode continuously.
              It prints each CRC-valid chat message and its measured tuning
              offset and clock drift.

       rxtx [MESSAGE]
              Transmit and receive at the same time. With no MESSAGE this
              behaves like rx. With MESSAGE supplied, it queues one chat
              message, transmits it, and continues listening. There is no ACK
              handshake or automatic retry. The TUI provides FEC-strength and
              off-grid controls. Runs until interrupted with Ctrl-C.

OPTIONS
       -o, --out FILE
              (tx only) Write the transmission to FILE as a 16-bit PCM WAV
              instead of playing it. Useful for test material, or for
              routing audio into a radio by some means other than this
              program's own playback.

       -i, --in FILE
              (rx only) Decode FILE instead of the live audio input. Accepts
              any sample rate and 8/16/24/32-bit PCM or float; resampled to
              48000 Hz internally.

       --snr=DB
              (tx only) Add noise at DB, referenced to 3 kHz bandwidth and
              measured against in-burst power, not the listening gaps. Makes
              repeatable weak-signal test material; no effect on a real
              transmission.

       --profile=NAME
              (tx only, requires --snr) Apply an ITU/CCIR Watterson fading
              channel before writing/playing the signal. NAME is one of:
              none, good, moderate, poor, worst.

       --seed=N
              (tx only) Integer seed for the channel/noise generator, so a
              --snr/--profile test signal is exactly reproducible. Default 1.

       --jobs=N
              (tx, rx and rxtx) Worker thread count for the decoder search.
              Default is cores - 1, so the machine stays usable while it
              decodes.

       -tui, --tui
              (rxtx only) Full-screen Blessed station console with separate
              RX and TX panes, VU meters, raw-repeat/FEC evidence, an event
              trace, and a message entry line. A non-TTY falls back to the
              plain line prompt.

EXIT STATUS
       0      tx completed, or rx decoded a frame that passed its CRC-16.
       1      no message given to tx, an unknown/malformed option, or rx
              reached the end of the input without a passing frame.

EXAMPLES
       qnr rxtx "CQ QNR" -tui
              Start a live station dashboard and queue one chat message.

       qnr tx "CQ QNR" -o out.wav
              Render one chat message to a WAV file instead.

       qnr tx "CQ QNR" -o weak.wav --snr=-20 --profile=poor
              Render a weak-signal chat test file: CCIR poor fading at -20 dB SNR.

       qnr rx -i weak.wav --jobs=4
              Decode a file with the worker pool capped at 4 threads.

       qnr rx
              Listen on the default audio input and print any frame that
              passes its CRC-16, with its tuning offset and clock drift.

       qnr rxtx "CQ"
              Queue one short chat message. The receiver displays it after a
              CRC-valid decode; there is no ACK or per-character mode.

       qnr rxtx -tui
              Listen continuously with the RX/TX station dashboard. An
              always-visible CONTROLS pane above the message box exposes
              FEC strength, off-grid mode, and the tune tone; there is no
              F1/Tab popup menu, since function keys send a different,
              terminal-dependent escape sequence on every emulator.

       TUI quick chat
              Type up to 16 printable ASCII characters and press Enter to
              transmit. Shift+Enter inserts a newline when supported by the
              terminal. Controls use Ctrl-chords, the same nano-style choice
              nano itself relies on: a Ctrl combination is one control byte,
              never an ambiguous multi-byte escape sequence, and it never
              collides with typed chat text. ^F cycles FEC strength, ^G
              toggles off-grid mode, ^T plays a 0.5 second 1 kHz test tone.
              ^L moves keyboard focus onto the CONTROLS pane for arrow-key
              or mouse-click navigation; Escape returns focus to the message
              box. ^X or ^C quits.

       Fast good-SNR chat
              Start `qnr rxtx -tui` at both stations, press ^G to switch on
              off-grid mode, and type a message. It transmits as soon as
              Enter is pressed. The receiver's direct decoder accepts the
              burst without shared-grid alignment. Use this mode for short
              local or good-SNR exchanges; grid mode is better for weak-signal
              repeat folding.

FILES
       wav/*.wav
              Convention used by this repo's own tools (bench.ts,
              experiment.ts, foldExperiment.ts) for generated test material;
              qnr itself accepts a WAV path anywhere.

SEE ALSO
       The "How it works" section below, ARCHITECTURE.md (elementary
       time-slots and multi-station reception), src/protocol.ts (the frozen
       parameters), src/selftest.ts (offline conformance check).
```

### The audio tell-tale

Both live modes print a level meter, which is the quickest way to confirm routing:

```
  TX 3/8  [###########################-----]   -9.0 dBFS
  IN      [##############------------------]  -27.4 dBFS  buffer 68%
```

* `TX n/8` — which burst is on air; `gap` means the listening window
* `dBFS` — drive level. Aim for -20..-6 dBFS. A trailing `!` means you are clipping
* `buffer` — how much audio the receiver has collected before its first attempt

The live receiver runs a direct decoder continuously for loud, out-of-grid frames,
then runs the weak-signal folded search once per basic-frame as raw audio arrives.
It adds soft bit likelihoods independently for each matched TX, first-listen, or
second-listen phase. After a CRC-valid chat message is emitted, the raw evidence
window is reset so the next message cannot contaminate the previous one.

For WAV input, sample zero is the timing epoch. `qnr tx -o` writes its first burst
after the initial protocol guard, so the generated file's first lane is TX; blind
preamble acquisition still accepts shifted recordings.

---

## How it works

### Transmit

```
 printable ASCII chat message, up to 16 characters
      |
      v
 [ fixed 16-byte payload ]    zero-padded when shorter than 16 characters
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
 [ prepend preamble ]         alternating sync tones x2
      |
      v
 [ continuous-phase MFSK ]    tone n = (85 + 3n) * 48000/8192 Hz
      |
      v
audio out  ->  up to 8 identical bursts, selected as FEC strength
```

### The schedule

In normal grid mode, the same chat message is sent up to 8 times on the shared world-time
schedule. The receiver folds bursts that land on the same grid position and sums their
soft metrics. The selected FEC strength is not transmitted as a setting: a receiver can
decode whatever number of bursts it hears, so both operators can use compatible qnr
builds without configuring a repeat count manually.

```
 |<----------- TX ----------->|<------- listen 1 ------->|<--------- listen 2 -------->|
 | g |        chat burst       | g |       decode          | g |        decode          | g |
 +---+-------------------------+---+-----------------------+---+-----------------------+---+
 |<-------------------------------- repeat period ---------------------------------------------->|
```

All basic frames remain equal because every message uses the same 16-byte payload.
There is no ACK, per-character state, or automatic retry. Repeated bursts are simply
additional observations of the same coded chat message.

The 2 s guards absorb PTT and relay switching, path delay, and clock skew between two
stations that share no time reference. The decoder is threaded so the weak-signal
folding search can continue while the station handles live audio.

### Off-grid quick chat

The TUI's **Off-grid mode** is intended for good-SNR, quick exchanges. When enabled,
Enter starts playback immediately instead of waiting for the next shared-grid TX slot.
The receiver's direct decoder continuously searches for a complete loud burst at any
phase, so the other station does not need to know the sender's start time. This mode
trades away weak-signal repeat folding; use normal grid mode for difficult paths.

### Receive

```
 audio in (any start point, no alignment needed)
      |
      v
 [ ACQUIRE tuning ]                sweep +/-60 Hz offset x +/-3000 ppm clock drift,
      |                            scored on the 2 preamble tones only (cheap)
      v
 [ Goertzel bank, 144 tones ]      power per tone, per window, at the found offset
      |                            -- tones split across threads
      v
[ FOLD each preamble phase ]       every station's own repeats land on top of each other
      |                            -- the period is known, so no start time is needed
      v
 [ matched filter on preamble ]    finds the frame inside the folded period
      |
      v
 [ per-burst soft metrics ]        tone power / noise floor, per bit
      |
      v
[ SUM LLRs within that phase ]    <-- grid bursts are combined when available
      |
      v
 [ deinterleave -> Viterbi ]
      |
      v
 [ CRC-16 + payload length ]  --fail--> next candidate start, drift, then offset
      |
      v
       decoded chat message
```

The two stages do different jobs, and both are needed:

* **Folding** solves *acquisition*. Sync energy from all 8 bursts adds together, so
  the preamble is found at an SNR where no single burst could be detected.
* **Summing LLRs** solves *decoding*. Each burst is an independent observation of
  the same coded bits, so their log-likelihoods add. Averaging tone *power* instead
  would only shrink noise variance, and is worth about half as much.

### Decoding as early as possible

A decode never waits for the schedule to end. The receiver tries the shortest window
that can contain a whole burst first, and only widens it when that fails:

```
 attempt 1:  1 burst   ->  39 s of audio    clean signals stop here
 attempt 2:  2 bursts  ->  68 s
 attempt 3:  4 bursts  -> 125 s
 attempt 4:  everything                     weak signals need all 8
```

A window of one period plus one burst is guaranteed to contain a complete burst
wherever the recording happens to start, so no lead-in has to be known or detected.
The ladder costs at most about 1.9x a single full-length attempt when it fails all
the way, and about one seventh of one when the signal is clean.

### Tolerance to mistuning and to sloppy clocks

The protocol is frozen, but the *channel to the receiver* is not. Two things are
searched rather than assumed:

* **Tuning offset, +/-60 Hz in 2 Hz steps.** Tones are 17.6 Hz apart, so a mistune of
  only 8.8 Hz already lands the comb on the wrong tone. Operators misdial, and a
  signal picked up through a WebSDR arrives on whatever frequency the listener
  happened to click.
* **Clock drift, +/-3000 ppm in 100 ppm steps.** No two sound cards agree, and an
  internet relay resamples on the way. A few hundred ppm is invisible inside one
  5.1 s packet burst but walks the folded period past a whole symbol across the repeat
  schedule, which used to smear the fold into noise. The listening gap is therefore
  treated as approximate: drift stretches the period *and* the symbol length.

Acquisition scores these on the two preamble tones alone, which costs 2/144 of a
full tone bank per candidate, so the whole grid is affordable. Only the best few
tunings get a full decode.

Windows are mapped to the fold by absolute sample position, so a fractional period
never accumulates rounding error across the schedule.

Because the search runs far more Viterbi trials than a single-tuning decode, a frame
must match the protocol's fixed 16-byte payload length as well as its CRC-16 before
it is believed. That keeps the false-accept rate at roughly 2^-32 per trial.

### Threading

The Goertzel bank is ~95% of decode time and is perfectly parallel: each thread walks
the same audio and fills a disjoint set of tone columns in shared memory, so the
result is identical to a single-threaded run. Audio is passed as a `SharedArrayBuffer`
and never copied. On a 12-core machine a 141 s recording decodes in about 10 s
instead of 17 s, while also searching ~4000 tuning candidates it previously ignored.

---

## Measured performance

The table below was measured with the fixed 16-byte chat payload and is retained as
DSP background. Re-run the channel sweeps before treating it as a current sensitivity
claim after changing audio hardware or channel conditions.

Frozen configuration, 24 trials per cell, random-length noise lead-in on every run.
SNR is referenced to in-burst power, so the figures do not depend on the gap length.

Decode rate versus SNR (3 kHz reference), CCIR *bad* channel (2 ms / 1 Hz):

| -19 dB | -20 dB | -21 dB | -22 dB | -23 dB |
|--------|--------|--------|--------|--------|
| 100%   | 100%   | 83%    | 8%     | 0%     |

The waterfall is about 2 dB wide, which is expected: with 8-fold diversity the
fading is averaged out and the channel behaves close to AWGN.

With 24 trials, 1 sigma on a mid-range cell is about 10 percentage points, so only
differences of roughly 20 points or more mean anything.

**The listening gap does not affect sensitivity.** At a fixed in-burst SNR, only the
spacing changed:

| Gap | -19 dB | -20 dB | -21 dB |
|-----|--------|--------|--------|
| 1 s | 100%   | 100%   | 79%    |
| 2 s | 100%   | 100%   | 75%    |
| 4 s | 100%   | 100%   | 75%    |
| 8 s | 100%   | 100%   | 67%    |
| 18.4 s | 100% | 100%   | 88%    |

Flat, non-monotonic, and well inside the ~9 point noise of 24 trials. This is the
physically sensible answer: a burst is 9-10 s long while the fade coherence time at
1 Hz Doppler is about 1 s, so the fading is already decorrelated *within* a single
burst. Dead air between bursts cannot add diversity that the burst length has
already collected.

> An earlier version of this file claimed the gap was "the highest-leverage
> parameter" (1 s -> 4%, 8 s -> 96%). That was an artifact: the four gaps were
> compared at a fixed nominal SNR while the SNR reference averaged transmit power
> over the gaps, so the 8 s cell was quietly given 2.1 dB less noise than the 1 s
> cell. Across a 2 dB waterfall that alone produces the entire effect.

The gap is therefore set by the protocol's need to carry a reply, not by sensitivity,
and costs nothing but wall-clock time.

Other sweeps: rate 1/3 beat rate 1/2 (67% vs 21%), interleaver 64 beat 16; preamble
length made no measurable difference between 2, 4 and 8 pairs. These compared equal
or near-equal duty cycles, so they are not affected by the issue above.

For context, WSPR decodes to about -29 dB at 0.45 bit/s with 4 tones. Converting this
modem's -20 dB in 3 kHz to WSPR's 2.5 kHz reference gives about -19 dB, so it is
roughly **10 dB behind WSPR** at a comparable data rate. The earlier claim of -23 dB
and "5 dB behind" came from an SNR reference that averaged transmit power over the
listening gaps; see the note above.

---

## Repository layout

| File | Role |
|------|------|
| `src/cli.ts` | the user-facing program |
| `src/rxtx.ts` | simultaneous transmit + continuous receive (`qnr rxtx`) |
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
