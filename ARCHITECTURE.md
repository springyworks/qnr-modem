# QNR Architecture: Elementary Time-Slots and Multi-Station Reception

This document describes the timing structure the protocol is built from, and thinks
through what a real two-way ham radio chat needs on top of it: a nearby correspondent,
a far-away listener on the same channel, and no configuration knobs anywhere. Some of
this is how `qnr` already works (including `qnr rxtx`, which implements §4, §5 and §7
below); some of it is a proposed direction and is labelled as such. See the "How it
works" section of [README.md](README.md) for the DSP chain itself (framing, coding,
folding); this document stays one level above that, at the level of who transmits when
and what a station does with the rest of its time.

> **Current protocol:** every frame carries a fixed four-byte typewriter packet
> `[ASCII character, sequence ID, ACK code, ACK ID]`. A repeat is three basic frames:
> transmit, decode-only listen, and listen/reply. ACK code `0` is a complete ACK. The
> older two-slot exploration in §3 is retained as historical design context only.

---

## 1. The elementary time-slot ("basic-frame")

Every unit of time on the air is the same fixed length, whether or not anyone is
transmitting in it. Call one such unit a **basic-frame**. Its length, `T_slot`, is
fixed by the protocol (guard + burst + guard, ~9.1 s: 2 s + 5.1 s + 2 s) and is
never negotiated, detected, or configurable — every station on the channel agrees on
it simply by running the same frozen build.

A basic-frame is always exactly one of two kinds, and a receiver cannot tell which
kind is coming until it has decoded (or failed to decode) what is inside it:

```
  KIND 1 -- occupied basic-frame (this station is sending "the message")

  +----------+--------------------------------------+----------+
  |  guard   |   144-tone MFSK packet burst (5.1 s) |  guard   |
  |   2 s    |   ASCII | ID | ACK | ACK-ID, CRC/FEC |  gap 2 s |
  +----------+--------------------------------------+----------+
  |<--------------------- T_slot ~= 9.1 s -------------------->|

  KIND 2 -- empty basic-frame (nobody keys up)

  +-------------------------------------------------------------+
  |                         noise only                           |
  +-------------------------------------------------------------+
  |<--------------------- T_slot ~= 9.1 s -------------------->|
```

The leading guard absorbs PTT keying, path delay and clock skew; the trailing guard
is the **decode gap** — the time the *other* station has, inside its own listening
window, to run a CRC attempt and get a reply keyed up before its own slot starts. The
whole point of `T_slot` being fixed and equal for every station is that nobody has to
transmit a "here I am, now you go" marker: the schedule itself is the marker.

Chained together, the air is nothing but a sequence of these:

```
  [basic-frame] [basic-frame] [basic-frame] [basic-frame] [basic-frame] ...
```

## 2. The fixed schedule as a chain of basic-frames

Three basic-frames make one **period** (~27.4 s): transmit, listen 1, then listen 2
or reply. `qnr tx` repeats a packet up to 8 times (`REPEATS`), so one maximum packet
run is 24 basic frames. `qnr rxtx` stops the run early when it hears ACK code `0` for
the outgoing sequence ID.

```
 period:    1        2        3        4        5        6        7        8
 tx:       [packet] [packet] [packet] [packet] [packet] [packet] [packet] [packet]
 listen 1: [decode] [decode] [decode] [decode] [decode] [decode] [decode] [decode]
 listen 2: [ACK/reply] [--] [--] [--] [--] [--] [--] [--]
```

`[packet]` and `[--]` are exactly the two kinds of basic-frame from §1 — a slot being
"empty" is not a gap in the schedule, it is a basic-frame like any other, it just
happens to carry noise. This is why the timing works without either side announcing
anything: **the schedule, not the traffic, defines the slots.**

## 3. Historical: the former two-slot multi-station exploration

The protocol above is implicitly point-to-point: one slot for the initiator, one for
the correspondent. Add a third station listening on the same frequency who is much
further away — call it **C-far** — and the picture gets harder, because there is no
mode to switch into for it: the same fixed 8-burst, 2-slot schedule has to work for
whoever is listening, near or far, without knowing in advance which one is out there.

```mermaid
sequenceDiagram
    participant A as Station A (initiator)
    participant B as Station B (near, strong path)
    participant C as Station C-far (weak path)

    Note over A,C: Every basic-frame is the same fixed length.<br/>A's slot is always occupied; B's slot is noise until B replies.

    loop period 1..8 (A repeats until it hears a reply, or the schedule ends)
        A->>B: burst n in slot A (10.4 s, same message)
        A-->>C: same burst n, much weaker over the longer path
        Note over B: folds bursts 1..n, tries CRC-16 every period
        Note over C: folds bursts 1..n too, but needs more repeats<br/>to reach a decodable effective SNR
    end

    Note over B: CRC passes after burst 3 (good path, few repeats needed)
    B->>A: reply, in slot B, same period as the pass
    Note over A: hears B's reply -- now implemented to stop repeating early, see §4

    Note over C: still below threshold at period 3 -- has no slot<br/>of its own and nothing decoded yet
    Note over C: finally passes CRC after folding all 8 bursts,<br/>at period 8 -- by which point A/B have already finished
```

This is **the hard part**: with zero protocol modes, the schedule cannot be tuned
per-listener. Two directions keep that constraint while giving C-far a real chance:

* **Shared slot B, not owned by B.** Slot B's timing is fixed, but *who* transmits in
  it is not: any station that has decoded A and has something to say may use it. If
  B stays silent (nothing decoded yet, or nothing to say), C-far may reply there
  instead once *it* has folded enough bursts to pass CRC. Collisions (both reply at
  once) are rare and self-resolving — a garbled CRC is simply a slot A can retry
  into.
* **A three-slot rota (A / B / C), same idea as the two-slot one.** Every station
  gets a turn of identical, fixed length, in round-robin order. This is a change to
  the frozen protocol itself, not a runtime option — it would need to ship as the
  new frozen schedule that all builds share, not a flag.

Both keep "no modes, no options": the schedule stays a fixed sequence of
equal-length basic-frames: what changes is only who is allowed to use an empty one.

## 4. Repeat-until-ACK (implemented in `qnr rxtx`)

`qnr tx` -- the simple, deterministic reference/test path -- still plays all 8 bursts
unconditionally; it does not listen while it transmits. `qnr rxtx` (`src/rxtx.ts`) is
the smarter station described here:

1. Key up and send its own transmit frame, same as `tx` (this is the one basic-frame where the
   local software cannot also be usefully decoding *that same burst* -- see §5).
2. During the two following listening frames, the decoder keeps running against whatever
   has just arrived -- it never stops, including while sending.
3. Stop repeating as soon as it receives ACK code `0` addressed to its outgoing
  sequence ID, instead of always running to its 8-burst ceiling.

This changes nothing about the on-air timing (still fixed basic-frames, still up to
8 repeats) -- it only changes when the *transmitting* station chooses to stop, which
is a local decision and does not need agreement from anyone else on the channel.

## 5. TX and RX in the same process (implemented in `qnr rxtx`)

Radio is half-duplex: a station cannot usefully decode its own transmitter while it
is keyed (it would just be decoding itself, badly, over the top of its own PTT
noise). Everywhere else, the process should be receiving:

```
 state machine for a TX-capable station:

   +--------------+   own slot arrives,     +--------------+
   |              |   has traffic to send   |              |
   |  LISTEN      |------------------------>|  KEY_TX      |
   |  (decode      |                         |  (own packet,|
   |  every        |<------------------------|  5.1 s)      |
   |  basic-frame) |   burst finishes        |              |
   +--------------+                         +--------------+

 the decoder runs continuously against the capture ring buffer in every
 state except KEY_TX -- including this station's own decode-gap and every
 basic-frame that belongs to somebody else.
```

A **receive-only station is always in `LISTEN`**: for it, every basic-frame,
occupied or not, gets a decode attempt, forever. Both `qnr rx` and `qnr rxtx` tie
their weak-signal redecode cadence to `T_slot` (`SLOT_SAMPLES` in
[src/protocol.ts](src/protocol.ts)), so there is genuinely one attempt per elementary
slot, while their direct path stays ready for loud off-grid packets at any time.

## 6. World time as the sync anchor

Live `qnr rxtx` derives the basic-frame grid from wall time (NTP, GPS, or another
shared clock); its own first packet waits for the next guard-aligned transmit frame
and later repeats stay in that same three-frame phase. WAV input uses sample zero as
the equivalent epoch. The receiver still matched-filters every observed preamble
phase: a loud off-grid signal is decoded immediately by the direct path, then its ACK
is scheduled in the next world-time transmit frame to resynchronize both stations.

## 7. A minimal, pipe-friendly terminal UI (implemented as `qnr rxtx -tui`)

`src/stationUi.ts` is the `blessed`-based full-screen dashboard used by `qnr rxtx
-tui`. It has separate RX and TX panes, VU meters for input, peak, ring, folded
repeats, output, repeat progress and queue pressure, plus an air-traffic trace and
message entry line. Plain `qnr rxtx` remains append-only and pipe-friendly; `-tui`
falls back to that line prompt when no TTY exists.

```
 RX / DECODER            TX / SCHEDULER
 IN      |####------|    OUT     |########--|
 RING    |#########-|    REPEAT  |###-------|  3/8
 FOLD    |####------|  3/8 raw   QUEUE   |##--------|  2
 DIRECT  SEARCH          RADIO   KEYED
 TEXT    HELLO WOR       STATUS  burst 3/8 - "L" id=4 ack=17
```

The RX pane shows TX/listen-1/listen-2 folding evidence, the rolling 256-character
receive line, and the direct decoder state; the TX pane shows packet ID/ACK state,
repeat progress, output level, and queue depth.

---

## Status: implemented vs. proposed

| Idea | Status |
|------|--------|
| Fixed-length basic-frame, occupied or noise-only | Implemented (`SLOT_SAMPLES`, `PERIOD_SAMPLES` in [src/protocol.ts](src/protocol.ts)) |
| 8-repeat, 3-frame TX/listen/listen schedule | Implemented |
| Four-byte character/ID/ACK/ACK-ID packet | Implemented |
| ACK code 0 stops a packet repeat run | Implemented |
| Progressive decode ladder (1, 2, 4, 8 bursts) | Implemented ([src/search.ts](src/search.ts)) |
| Simultaneous TX + RX in one process (`qnr rxtx`) | Implemented ([src/rxtx.ts](src/rxtx.ts)) |
| A stops repeating once it hears ACK code 0 for its packet ID | Implemented (`qnr rxtx`; `qnr tx` still always sends all 8) |
| Redecode cadence tied to `T_slot` (one attempt per basic-frame) | Implemented in both `qnr rx` and `qnr rxtx` |
| Full-screen RX/TX TUI | Implemented with Blessed in `qnr rxtx -tui` |
| Continuous packet-epoch LLR folding in live `rx` | Implemented, including TX/listen-1/listen-2 phases and loud off-grid fallback |
| Shared/contended slot B for a far third station | Proposed (§3) |
| Fixed three-station rota | Proposed, would require a protocol version change (§3) |
