# QNR Architecture: Elementary Time-Slots and Multi-Station Reception

This document describes the timing structure the protocol is built from, and thinks
through what a real two-way ham radio chat needs on top of it: a nearby correspondent,
a far-away listener on the same channel, and no configuration knobs anywhere. Some of
this is how `qnr` already works (including its default station mode, which implements
§4, §5 and §7 below, with no `rxtx` subcommand needed -- there is only one app, `qnr`);
some of it is a proposed direction and is labelled as such. See the "How it works"
works" section of [README.md](README.md) for the DSP chain itself (framing, coding,
folding); this document stays one level above that, at the level of who transmits when
and what a station does with the rest of its time.

> **Current protocol:** the chat protocol is ACK-less -- no per-character typewriter packet,
> no ACK handshake, no automatic retry (that old four-byte packet format is gone). A repeat is
> two basic frames: transmit, then listen/rx, repeated as many times as the operator's chosen
> FEC strength says (`REPEATS`, currently up to 60 -- enough to reach for WSPR-grade
> weak-signal margin from the same protocol, not just a quick nearby exchange). The older
> two-slot/ACK exploration in §3 is retained as historical design context only.

---

## 1. The elementary time-slot ("basic-frame")

Every unit of time on the air is the same fixed length, whether or not anyone is
transmitting in it. Call one such unit a **basic-frame**. Its length, `T_slot`, is
fixed by the protocol (guard + burst + guard, ~13.9 s: 2 s + 9.9 s + 2 s) and is
never negotiated, detected, or configurable — every station on the channel agrees on
it simply by running the same frozen build.

A basic-frame is always exactly one of two kinds, and a receiver cannot tell which
kind is coming until it has decoded (or failed to decode) what is inside it:

```
  KIND 1 -- occupied basic-frame (this station is sending "the message")

  +----------+--------------------------------------+----------+
  |  guard   |   144-tone MFSK chat burst (9.9 s)   |  guard   |
  |   2 s    |   16-byte payload, CRC-16, conv FEC   |  gap 2 s |
  +----------+--------------------------------------+----------+
  |<--------------------- T_slot ~= 13.9 s ------------------->|

  KIND 2 -- empty basic-frame (nobody keys up)

  +-------------------------------------------------------------+
  |                         noise only                           |
  +-------------------------------------------------------------+
  |<--------------------- T_slot ~= 13.9 s ------------------->|
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

Two basic-frames make one **period** (~27.7 s): transmit, then listen/rx -- no
separate reply slot; the chat protocol carries no ACK to reply with. Plain `qnr`
repeats a message up to `REPEATS` times (currently 60), so one maximum run is 120
basic frames (~28 minutes) -- a ceiling raised well past a quick-chat count so the
same schedule can also reach for WSPR-grade weak-signal margin by repeating longer.
The receiver never needs to know how many repeats were actually sent; it blindly
folds whatever it hears.

```
 period:  1        2        3        4        5      ...      60
 tx:     [burst] [burst] [burst] [burst] [burst] ... [burst]
 rx:     [--]    [--]    [--]    [--]    [--]    ... [--]
```

`[burst]` and `[--]` are exactly the two kinds of basic-frame from §1 — a slot being
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

## 4. Repeat as many times as useful (implemented in the default `qnr` station)

`qnr tx` -- the simple, deterministic reference/test path -- always plays exactly the
chosen repeat count unconditionally; it does not listen while it transmits. Plain
`qnr` (`src/rxtx.ts`) is the smarter station described here:

1. Key up and send its own transmit frame, same as `tx` (this is the one basic-frame where the
   local software cannot also be usefully decoding *that same burst* -- see §5).
2. During the following listen/rx frame, the decoder keeps running against whatever
   has just arrived -- it never stops, including while sending.
3. Repeat as many times as the operator's chosen FEC strength says (1..`REPEATS`,
   currently up to 60) -- there is no ACK to stop early on, and none is needed: the
   receiver folds however many repeats it actually heard, whatever that count was.

This changes nothing about the on-air timing (still fixed basic-frames) -- the only
choice is how many repeats the *transmitting* station sends, a local decision that
does not need agreement from anyone else on the channel. A handful of repeats suits
a quick nearby exchange; running the same schedule out toward its `REPEATS` ceiling
reaches for WSPR-grade weak-signal margin instead, from the identical protocol.

## 5. TX and RX in the same process (implemented in the default `qnr` station)

Radio is half-duplex: a station cannot usefully decode its own transmitter while it
is keyed (it would just be decoding itself, badly, over the top of its own PTT
noise). Everywhere else, the process should be receiving:

```
 state machine for a TX-capable station:

   +--------------+   own slot arrives,     +--------------+
   |              |   has traffic to send   |              |
   |  LISTEN      |------------------------>|  KEY_TX      |
   |  (decode      |                         |  (own burst, |
   |  every        |<------------------------|  9.9 s)      |
   |  basic-frame) |   burst finishes        |              |
   +--------------+                         +--------------+

 the decoder runs continuously against the capture ring buffer in every
 state except KEY_TX -- including this station's own decode-gap and every
 basic-frame that belongs to somebody else.
```

A **receive-only station is always in `LISTEN`**: for it, every basic-frame,
occupied or not, gets a decode attempt, forever. Both `qnr rx` and plain `qnr` tie
their weak-signal redecode cadence to `T_slot` (`SLOT_SAMPLES` in
[src/protocol.ts](src/protocol.ts)), so there is genuinely one attempt per elementary
slot, while their direct path stays ready for loud off-grid packets at any time.

## 6. World time as the sync anchor

Live `qnr` (the default station) derives the basic-frame grid from wall time (NTP,
GPS, or another
shared clock); its own first burst waits for the next guard-aligned transmit frame
and later repeats stay in that same two-frame phase. WAV input uses sample zero as
the equivalent epoch. The receiver still matched-filters every observed sync-marker
phase: a loud off-grid signal is decoded immediately by the direct path with no
need to wait for the world-time grid at all.

## 7. A minimal, pipe-friendly terminal UI (implemented as `qnr -tui`)

`src/stationUi.ts` is the `blessed`-based full-screen dashboard used by `qnr -tui`.
It has separate RX and TX panes, VU meters for input, peak, ring, folded
repeats, output, repeat progress and queue pressure, plus an air-traffic trace and
message entry line. Plain `qnr` remains append-only and pipe-friendly; `-tui`
falls back to that line prompt when no TTY exists.

```
 RX / DECODER            TX / SCHEDULER
 IN      |####------|    OUT     |########--|
 RING    |#########-|    REPEAT  |###-------|  3/60
 FOLD    |####------|  3/60 raw  QUEUE   |##--------|  2
 DIRECT  SEARCH          RADIO   KEYED
 TEXT    HELLO WOR       STATUS  burst 3/60 - "HELLO WORLD"
```

The RX pane shows TX/RX folding evidence, the rolling 256-character
receive line, and the direct decoder state; the TX pane shows repeat progress,
output level, and queue depth.

---

## Status: implemented vs. proposed

| Idea | Status |
|------|--------|
| Fixed-length basic-frame, occupied or noise-only | Implemented (`SLOT_SAMPLES`, `PERIOD_SAMPLES` in [src/protocol.ts](src/protocol.ts)) |
| Up to `REPEATS` (60), 2-frame TX/RX schedule | Implemented |
| ACK-less chat payload, CRC-16 + convolutional FEC | Implemented (see [README.md](README.md)) |
| Progressive decode ladder (1, 2, 4, 8, 16, 32 bursts, then everything) | Implemented ([src/search.ts](src/search.ts)) |
| Simultaneous TX + RX in one process (default `qnr`, no subcommand) | Implemented ([src/rxtx.ts](src/rxtx.ts)) |
| Operator picks repeat count 1..`REPEATS` live, no receiver foreknowledge needed | Implemented (default `qnr`; `qnr tx` always sends the chosen count) |
| Redecode cadence tied to `T_slot` (one attempt per basic-frame) | Implemented in both `qnr rx` and default `qnr` |
| Full-screen RX/TX TUI | Implemented with Blessed in `qnr -tui` |
| Continuous LLR folding in live `rx` | Implemented, including TX/RX phases and loud off-grid fallback |
| Shared/contended slot B for a far third station | Proposed (§3) |
| Fixed three-station rota | Proposed, would require a protocol version change (§3) |
