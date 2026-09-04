# QNR-144

A weak-signal HF chat modem: 144-tone MFSK, convolutional coding with
soft-decision Viterbi, exact-repeat correlation, and a fixed two-basic-frame
tx/rx schedule that repeats as long as useful -- fast nearby chat at a handful
of repeats, or WSPR-grade weak-signal margin from the same protocol by just
repeating longer (up to `REPEATS`, currently 60).

Decodes at **-20 dB SNR** (3 kHz reference) through a CCIR *bad* Watterson channel
(2 ms delay spread, 1 Hz Doppler). Occupies **2.51 kHz**, so it fits an SSB channel.

SNR is referenced to power **while transmitting**, not averaged over the listening
gaps. That distinction matters here: this modem is idle most of the time, and
averaging over the gaps would make the figure look better the longer they get.

There are no modem options. Every parameter is frozen at the value that won its
measurement sweep, so any two copies of this program can always talk to each other.

It also runs **entirely in a browser** as a single self-contained HTML file — see
[The web station](#the-web-station-github-pages).

> **Known gap: the burst is 9.9 s, not the intended 5 s.**
> `npm run requirements` checks every stated on-air constraint against what the code
> actually builds. Ten of twelve pass (144 tones, 8 Bd, 2.51 kHz, constant envelope,
> 3.01 dB PAPR, phase continuity, tx/rx alternation). The burst and slot length do
> not: a 16-byte payload at rate 1/3 needs 79 symbols, which is 9.9 s at 8 Bd.
> A 5 s burst is 40 symbols, and would carry only 4 bytes at the current rate and
> framing (6 bytes with a 4-bit length field, 11 bytes at rate 1/2 with less coding
> gain). That trade is a protocol break which moves every measured sensitivity
> figure, so it is left as an explicit decision rather than applied silently.


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

**The station is `qnr -tui`.** Everything else is for testing, scripting and
headless operation.

```bash
qnr -tui                       # the station: full-screen dashboard, tx and rx together
qnr -tui "CQ QNR"              # same, with one message already queued
```

The other subcommands are deliberately plain and pipe-friendly:

```bash
qnr                            # same station, but an append-only line prompt (no TUI)
qnr tx "CQ QNR"                # one-shot transmit only, no listening
qnr tx "HELLO" -o out.wav      # render a transmission to a WAV file
qnr rx                         # listen only, never transmits
qnr rx -i in.wav               # decode a recording (this is the deep/weak-signal path)
qnr rx -i in.wav --jobs=4      # cap the decoder to 4 threads
qnr fastchat "CQ"              # experimental 3 s incremental-redundancy grid
```

There is no `rxtx` subcommand: transmitting and receiving together is what plain
`qnr` *is*, so it needs no argument to select it.

### Threads, and why live is not the deepest decode

A live station leaves three cores free so the audio never breaks up; an offline
decode uses every core but one. `--jobs=N` overrides either.

That is also why a **live** station folds only
[`LIVE_FOLD_REPEATS`](src/protocol.ts) periods deep, while a transmitter may send up
to `REPEATS` (60). A live fold has to finish inside one period or it starves the
thread feeding PipeWire and the outgoing tone stutters. To get the full
many-repeat weak-signal gain, record the audio and decode it with `qnr rx -i`,
which may take as long as it likes because nothing is being transmitted.

Input WAVs are accepted at any sample rate and in 8/16/24/32-bit PCM or float, and are
resampled to 48 kHz internally.

Without linking, replace `qnr` with `node dist/cli.js`, or use the npm scripts:

```bash
npm run tui
npm run tx -- "CQ QNR"
npm run rx
```

### Checking the build

```bash
npm run selftest       # FEC, framing and the full modem chain, no hardware
npm run integration    # worker-backed two-station folded decode
npm run fasttest       # the 3 s chunked grid
npm run requirements   # stated on-air requirements vs. what the code actually builds
npm run snrprobe       # measured fast-chat and weak-signal SNR, real tx/rx pipeline
npm run wsprprobe      # repeats needed vs SNR, down to the decoding floor
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
       qnr [MESSAGE] [-tui] [--jobs=N]
       qnr tx MESSAGE [-o FILE] [--snr=DB [--profile=NAME] [--seed=N]]
       qnr rx [-i FILE] [--jobs=N]
       qnr fastchat [MESSAGE]
       qnr -h | --help

DESCRIPTION
       qnr transmits and receives a fixed-format 144-tone MFSK frame over a
       sound card and, optionally, a radio. There are no modem options: baud
       rate, coding, interleaving, and the send/listen schedule are frozen in
       the protocol (src/protocol.ts), so any two builds of qnr can always
       talk to each other. The only choices left to the operator are the
       message text, an output/input file, and how many worker threads
       decode.

       Called with no MESSAGE and no recognised subcommand, qnr is the default
       station: transmit and receive at the same time, forever, until
       interrupted with Ctrl-C. There used to be a separate `rxtx` subcommand
       for this; it has been folded into plain `qnr` so there is only one app
       to remember. `qnr rxtx` now prints a one-line pointer to this instead
       of running.

COMMANDS
       (no subcommand) [MESSAGE] [-tui]
              The default station: transmit and receive at the same time.
              With no MESSAGE this behaves like rx. With MESSAGE supplied, it
              queues one chat message, transmits it, and continues listening.
              There is no ACK handshake or automatic retry. The TUI
              (`-tui`/`--tui`) provides FEC-strength and off-grid controls.
              Runs until interrupted with Ctrl-C.

       tx MESSAGE
              One-shot transmit only, no listening: play (or render to a
              WAV file) one message through the default audio output.
              Messages are limited to 16 payload characters and are
              zero-padded before framing. The frame has CRC-16, convolutional
              coding (K=7, rate 1/3), and interleaving.

       rx     Listen only, no ability to send. Decodes continuously and
              prints each CRC-valid chat message and its measured tuning
              offset and clock drift.

       fastchat [MESSAGE]
              3-second-grid incremental-redundancy chat: the same coded
              payload striped into short repeating bursts instead of one long
              burst, for late-join capability (see the fastchat section
              below). No ACK, no TUI.

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
              Worker thread count for the decoder search. Default is
              cores - 1 for an offline decode, and cores - 3 for a live
              station, which needs spare cores to keep feeding audio to
              PipeWire without the transmitted tone breaking up.

       -tui, --tui
              (default station only) Full-screen Blessed station console with
              separate RX and TX panes, VU meters, raw-repeat/FEC evidence, an
              event trace, and a message entry line. A non-TTY falls back to
              the plain line prompt.

EXIT STATUS
       0      tx completed, or rx decoded a frame that passed its CRC-16.
       1      no message given to tx, an unknown/malformed option, or rx
              reached the end of the input without a passing frame.

EXAMPLES
       qnr "CQ QNR" -tui
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

       qnr "CQ"
              Queue one short chat message. The receiver displays it after a
              CRC-valid decode; there is no ACK or per-character mode.

       qnr -tui
              Listen continuously with the RX/TX station dashboard. Press F1
              or Tab, or click [F1 Menu], to open the operator menu.

       TUI quick chat
              Type up to 16 printable ASCII characters and press Enter to
              transmit. Shift+Enter inserts a newline when supported by the
              terminal. Open the menu with F1, Tab, or the mouse. Use [o] to
              enable Off-grid mode for immediate transmit, [f] to choose FEC
              strength, and [t] to play a 0.5 second 1 kHz audio test tone.
              Use arrow keys and Enter, mouse clicks, or the bracketed mnemonic
              letters to navigate. Press x or Escape to go back.

       Fast good-SNR chat
              Start `qnr -tui` at both stations, open the menu, choose
              `o Off-grid mode: ON`, and type a message. It transmits as soon
              as Enter is pressed. The receiver's direct decoder accepts the
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

## Operating the station (`qnr -tui`)

```
 RX / DECODER                     TX / SCHEDULER
 IN      |####------|             OUT     |########--|
 RING    |#########-|             REPEAT  |###-------|  3/8
 FOLD    |####------|  3/4 raw    QUEUE   |##--------|  2
 DIRECT  SEARCH                   RADIO   KEYED
 TEXT    HELLO WOR                STATUS  burst 3/8 - "HELLO WORLD"
```

Type up to 16 printable ASCII characters and press **Enter** to send. Shift+Enter
inserts a newline where the terminal supports it.

| Key | Control |
|-----|---------|
| `Enter` | send the typed message |
| `Tab` / `^L` | move focus between the message box and the controls pane |
| `Tab` / `F1` | open the menu (F1 alone is unreliable under tmux and some window managers) |
| `^F` | FEC strength: how many repeats to send, stepping 1, 2, 4, 8, 16, 32, 60 |
| `^G` | off-grid mode: transmit immediately instead of waiting for the world-time slot |
| `^T` | 0.5 s 1 kHz test tone, to check audio routing |
| `^N` / `^P` | simulated TX SNR / Watterson fading, for testing without a radio |
| `←` `→` | adjust the selected control when the controls pane has focus |
| `x` / `Esc` | leave the menu |

The focused pane is outlined in green. Mouse clicks select a pane and activate menu
items, if the terminal passes mouse events through (`set -g mouse on` under tmux).

**FEC strength is not transmitted.** The receiver folds however many repeats it
happens to hear, so the two stations never have to agree on a count: raise it for a
distant station, drop it to 1 or 2 for a quick local exchange.

**Off-grid mode** is for good-SNR back-and-forth. It keys up the moment you press
Enter rather than waiting for the shared world-time slot, so it gives up repeat-fold
gain in exchange for immediacy. Leave it off for weak signals.

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
sync-marker acquisition still accepts shifted recordings.

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
 [ scatter sync markers ]     alternating sync tones spliced between data chunks
      |                       instead of clustered up front (src/synclayout.ts) --
      |                       keeps the burst's texture even; total symbol count
      |                       (and so burst duration) is unchanged
      v
 [ continuous-phase MFSK ]    tone n = (85 + 3n) * 48000/8192 Hz
      |
      v
audio out  ->  up to 8 identical bursts, selected as FEC strength
```

### The schedule

In normal grid mode, the same chat message is sent up to `REPEATS` (currently 60) times
on the shared world-time schedule. The receiver folds bursts that land on the same grid
position and sums their soft metrics. The selected FEC strength is not transmitted as a
setting: a receiver can decode whatever number of bursts it hears, so both operators can
use compatible qnr builds without configuring a repeat count manually. A handful of
repeats is enough for a quick nearby exchange; running the same schedule out to its full
length reaches for WSPR-grade weak-signal margin instead, from the same protocol.

```
 |<----------- TX ----------->|<----------- RX ------------>|
 | g |     chat burst     | g | g |       decode        | g |
 +---+---------------------+---+---+----------------------+---+
 |<-------------------- repeat period -------------------->|
```

Both basic frames remain equal because every message uses the same 16-byte payload.
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
      |                            scored on the 2 sync tones only, at their scattered
      v                            positions across the burst (cheap)
 [ Goertzel bank, 144 tones ]      power per tone, per window, at the found offset
      |                            -- tones split across threads
      v
[ FOLD each sync phase ]           every station's own repeats land on top of each other
      |                            -- the period is known, so no start time is needed
      v
 [ matched filter on sync markers ] finds the frame inside the folded period
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
  the sync markers are found at an SNR where no single burst could be detected.
* **Summing LLRs** solves *decoding*. Each burst is an independent observation of
  the same coded bits, so their log-likelihoods add. Averaging tone *power* instead
  would only shrink noise variance, and is worth about half as much.

### Decoding as early as possible

A decode never waits for the schedule to end. The receiver tries the shortest window
that can contain a whole burst first, and only widens it when that fails:

```
 attempt 1:  1 burst    ->   38 s of audio    clean signals stop here
 attempt 2:  2 bursts   ->   65 s
 attempt 3:  4 bursts   ->  121 s
 attempt 4:  8 bursts   ->  232 s
 attempt 5:  16 bursts  ->  454 s
 attempt 6:  32 bursts  ->  898 s
 attempt 7:  everything -> 1675 s (~28 min)   weak/far-away signals may need all 60
```

A window of one period plus one burst is guaranteed to contain a complete burst
wherever the recording happens to start, so no lead-in has to be known or detected.
Doubling the ladder instead of jumping straight to the ceiling means a weak signal's
"repeats actually needed" is measured to within 2x, not just "somewhere under 60".

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

Acquisition scores these on the two sync tones alone, at their scattered burst
positions, which costs 2/144 of a full tone bank per candidate, so the whole grid is
affordable. Only the best few tunings get a full decode.

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

Other sweeps: rate 1/3 beat rate 1/2 (67% vs 21%), interleaver 64 beat 16; the number
of sync-marker pairs made no measurable difference between 2, 4 and 8 pairs. These
compared equal or near-equal duty cycles, so they are not affected by the issue above.

For context, WSPR decodes to about -29 dB at 0.45 bit/s with 4 tones. Converting this
modem's -20 dB in 3 kHz to WSPR's 2.5 kHz reference gives about -19 dB, so it is
roughly **10 dB behind WSPR** at a comparable data rate. The earlier claim of -23 dB
and "5 dB behind" came from an SNR reference that averaged transmit power over the
listening gaps; see the note above.

---

## The web station (GitHub Pages)

`docs/index.html` is the whole modem as **one self-contained HTML file** — no
bundler at runtime, no CDN, no network requests, nothing uploaded. It runs the same
TypeScript DSP as the command-line program, compiled to a browser build and inlined.

```bash
npm run build:web       # -> docs/index.html
```

Publish it by pointing GitHub Pages at the `docs/` folder on the default branch
(Settings → Pages → Source: *Deploy from a branch*, folder `/docs`). Opening the
file directly with `file://` works too.

It gives you a terminal with `help`, `info`, `selftest`, `sim`, `devices`, `mic`,
`tx`, `tone` and `clear`. `selftest` and `sim` prove the DSP end-to-end in the
browser — `sim -18 poor` decodes a signal 18 dB under the noise through simulated
CCIR Poor fading, matching the command-line result.

The folded search runs in a Web Worker built from the same inlined source, so a
long decode never freezes the page.

### Browser audio, honestly

Audio is the hard part of a browser modem, and the limits are real:

| | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Microphone capture | yes | yes | yes |
| Choosing the **input** device | yes | yes | yes |
| Choosing the **output** device from the page | yes (`setSinkId`) | no | no |
| Sample-rate control | usually honours 48 kHz | usually | often resamples |

* Echo cancellation, noise suppression and auto gain are all explicitly disabled —
  every one of them destroys a weak MFSK signal.
* Where the page cannot choose an output device, pick it in the OS mixer instead.
* A page cannot open your radio's PTT. For real transmit, route the tab's audio to
  the rig with the OS mixer, or use the command-line station.
* Browsers require a user gesture before audio starts, so the first `tx` or
  `mic on` must come from a click or keypress.

The command-line station remains the better choice for real weak-signal work: it is
multi-threaded, it can fold far more deeply, and PipeWire routing is far more
predictable than a browser's.

---

## Repository layout

| File | Role |
|------|------|
| `src/cli.ts` | argument parsing and the headless commands |
| `src/rxtx.ts` | the station: transmit + receive together, `qnr` and `qnr -tui` |
| `src/stationUi.ts` | the Blessed dashboard for `-tui` |
| `src/protocol.ts` | frozen parameters, the single source of truth |
| `src/tx.ts` | framing, interleaving, continuous-phase modulator |
| `src/synclayout.ts` | where the sync markers sit inside a burst |
| `src/fold.ts` | repeat correlation receiver (folding + LLR combining) |
| `src/search.ts` | multi-threaded tuning/drift search around `fold.ts` |
| `src/rx.ts` | streaming single-burst receiver for loud, off-grid signals |
| `src/live.ts` | the always-on receive loop both live modes share |
| `src/conv.ts` | convolutional encoder and soft-decision Viterbi |
| `src/detector.ts` | Goertzel bank over the 144 tones |
| `src/channel.ts` | Watterson HF channel simulator |
| `src/audio.ts` | PipeWire capture and playback |
| `src/chunked.ts`, `src/fastchat.ts` | experimental 3 s incremental-redundancy grid |
| `src/webmodem.ts` | browser-safe facade bundled into `docs/index.html` |
| `web/`, `tools/buildWeb.mjs` | the single-file web build |
| `src/selftest.ts`, `src/integration.ts`, `src/fastSelfTest.ts` | tests, no hardware needed |
| `src/requirements.ts` | asserts the stated on-air requirements against the build |
| `src/snrProbe.ts`, `src/wsprProbe.ts` | SNR measurement through the real pipeline |

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
