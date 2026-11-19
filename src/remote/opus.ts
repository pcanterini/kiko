// Opus on the phone link: which codec a connection uses, the binary frames the audio goes in, and
// the two streams the server runs (each press's audio decoded for speech-to-text, the voice encoded
// for the phones that take Opus). The codec itself is the platform's (src/platform/macos/opus.ts).
//
// Agreeing on it (protocol/README.md, "Opus"): the hub's welcome lists the codecs it takes
// (`codecs`); a phone that takes one of them says so (`audio_codecs`, what it takes, best first);
// the hub picks the first of the phone's it has and says it (`audio_codec`), for both ways. A phone
// that says nothing (an older app, or the app's Compressed audio off) stays on PCM in JSON, exactly
// as before.
//
// A binary frame: byte 0 the protocol version, byte 1 its kind (1 the phone's talk audio, 16 kHz;
// 2 the hub's voice, 24 kHz; 3 the phone's hands-free audio, 16 kHz), then Opus packets of 20 ms,
// each behind a 2-byte big-endian length.
import { log } from "../core/log.ts";
import type { VoicePos } from "../core/voice-marks.ts";
import type { Opus, OpusStream } from "../platform/types.ts";

export type Codec = "pcm" | "opus";
/** Every codec there is, in the order a hub prefers them. PCM needs no saying: it's always there. */
export const CODECS = ["opus"] as const;
/** Bits a second, both ways: about 2.5–3.3 KB/s, ~18–21× less than base64 PCM (protocol/README.md, "Opus"). */
const OPUS_BITRATE = 24_000;
const TALK_RATE = 16_000;
const VOICE_RATE = 24_000;
/** Packets to a message once a stretch of the voice is going (100 ms); the first goes at once. */
const PACKETS_PER_MESSAGE = 5;
/** Samples in one 20 ms packet of the voice. */
export const VOICE_PACKET = (VOICE_RATE / 1000) * 20;

/**
 * Where a frame's audio is in the lines said (the phones' read-along: voice_marks `sync`): `marks`,
 * a line that starts again `offset` samples into the frame (its sample `at`); `head`, the line and
 * sample the frame's first sample is, when it's one of a line's (for a phone that missed the mark).
 */
export type FrameMarks = { marks: Array<VoicePos & { offset: number }>; head: VoicePos | null };

export const KIND = { talk: 1, voice: 2, listen: 3 } as const;
type FrameKind = (typeof KIND)[keyof typeof KIND];

/** The codec both sides take: the first of the phone's (best first) that the hub has; else PCM. */
export function pickCodec(phone: readonly string[] | null | undefined, hub: readonly string[]): Codec {
  for (const c of phone ?? []) if (hub.includes(c)) return c as Codec;
  return "pcm";
}

/** Packets behind their 2-byte lengths, as the helper and the frames have them. */
export function joinPackets(packets: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const p of packets) {
    if (p.length === 0 || p.length > 0xffff) throw new Error(`an Opus packet of ${p.length} bytes`);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(p.length);
    parts.push(len, p);
  }
  return Buffer.concat(parts);
}

/** The packets in `data` (each behind its 2-byte length); null when one runs past the end. */
export function splitPackets(data: Buffer): Buffer[] | null {
  const out: Buffer[] = [];
  let at = 0;
  while (at < data.length) {
    if (at + 2 > data.length) return null;
    const len = data.readUInt16BE(at);
    at += 2;
    if (len === 0 || at + len > data.length) return null;
    out.push(data.subarray(at, at + len));
    at += len;
  }
  return out;
}

type Settled = { ok: true; value: Buffer } | { ok: false; error: unknown };
/** Settled at once (a rejection is never left without a handler), used when its turn comes. */
const settle = (p: Promise<Buffer>): Promise<Settled> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A binary frame: the version, the kind, the packets (already behind their lengths). */
export function frame(version: number, kind: FrameKind, packets: Buffer): Buffer {
  return Buffer.concat([Buffer.from([version, kind]), packets]);
}

/** A binary frame read, or why it isn't one. */
export function parseFrame(data: Buffer, version: number): { kind: FrameKind; packets: Buffer; count: number } | { error: string } {
  if (data.length < 2) return { error: "a binary frame shorter than its header" };
  if (data[0] !== version) return { error: `a binary frame of version ${data[0]}` };
  const kind = data[1];
  if (kind !== KIND.talk && kind !== KIND.voice && kind !== KIND.listen) return { error: `a binary frame of kind ${kind}` };
  const packets = data.subarray(2);
  const split = splitPackets(packets);
  if (!split) return { error: "a binary frame whose packets run past its end" };
  if (!split.length) return { error: "a binary frame with no packets" };
  return { kind, packets, count: split.length };
}

/**
 * The voice for the phones that take Opus: one encoder for all of them (they get the same packets).
 * The first packet of a stretch of speech goes at once; after it, five to a message (100 ms), or
 * whatever's ready once no more has come for `idleMs`; what's short of a frame is padded and sent once
 * none has come for `endMs` (the line is over). `cut()` (barge-in) drops everything not sent and
 * starts a new encoder, so nothing of what was cut comes after.
 */
export class VoiceEncoder {
  private stream: OpusStream | null = null;
  // Where the audio is, in samples of what the phones decode (VOICE_PACKET a packet): each push's
  // place in its line, so a frame says which line's sample it starts with. A flush pads the last
  // packet with silence: what's pushed after it starts at the next packet, so its line is marked
  // again there. `fed`: pushed since the last flush; `base`: where that flush left the packets;
  // `produced`: packets out of the encoder; `sentAt`: packets sent; `runs`: where each run of a line
  // (or of no line) starts, not yet all sent; `expect`: the next sample, if it carries on a run of a
  // line (null: on a run of no line; undefined: on none, so the next push starts one).
  private fed = 0;
  private base = 0;
  private produced = 0;
  private sentAt = 0;
  private runs: Array<{ streamAt: number; pos: VoicePos | null; told: boolean }> = [];
  private expect: VoicePos | null | undefined = undefined;
  // What's encoded and not sent yet, and whether the next packet starts a stretch.
  private ready: Buffer[] = [];
  private fresh = true;
  private gen = 0;
  // Every push and flush in order: an answer is used only once those before it are.
  private chain: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private endTimer: NodeJS.Timeout | null = null;
  // What's waiting in the encoder short of a whole frame.
  private partial = false;

  private opus: Opus;
  private send: (packets: Buffer, count: number, marks: FrameMarks) => void;
  private o: { idleMs?: number; endMs?: number };

  /** `idleMs`: whatever's ready goes once nothing more has come this long; `endMs`: the line is over. */
  constructor(opus: Opus, send: (packets: Buffer, count: number, marks: FrameMarks) => void, o: { idleMs?: number; endMs?: number } = {}) {
    this.opus = opus;
    this.send = send;
    this.o = o;
  }

  /** 24 kHz 16-bit mono PCM as the voice makes it; `pos`, where it is in its line. */
  push(pcm: Buffer, pos?: VoicePos) {
    if (!pcm.length) return;
    const gen = this.gen;
    const n = Math.floor(pcm.length / 2);
    // Its place, in order with every answer before it (a flush before it has moved `base` by then).
    this.chain = this.chain.then(() => {
      if (gen !== this.gen) return;
      const carries = pos ? Boolean(this.expect && this.expect.line === pos.line && this.expect.at === pos.at) : this.expect === null;
      if (!carries) this.runs.push({ streamAt: this.base + this.fed, pos: pos ? { line: pos.line, at: pos.at } : null, told: false });
      this.expect = pos ? { line: pos.line, at: pos.at + n } : null;
      this.fed += n;
    });
    const stream = (this.stream ??= this.opus.encoder(VOICE_RATE, OPUS_BITRATE));
    const out = stream.push(pcm);
    this.partial = true; // a frame may wait in the encoder; flushed once the line is over
    this.after(out, gen);
    this.arm();
  }

  /** Barge-in: nothing more of what was said goes, and the next sound starts a new stretch. */
  cut() {
    this.gen++;
    this.ready = [];
    this.fresh = true;
    this.partial = false;
    this.fed = this.base = this.produced = this.sentAt = 0;
    this.runs = [];
    this.expect = undefined;
    this.stream?.close();
    this.stream = null;
    this.disarm();
  }

  stop() {
    this.cut();
  }

  /** Whatever's encoded goes now, and what's short of a frame (padded): the line is over. */
  end() {
    this.disarm();
    const stream = this.stream;
    if (!stream) return;
    const gen = this.gen;
    if (this.partial) this.after(stream.flush(), gen);
    this.partial = false;
    this.chain = this.chain.then(() => {
      if (gen !== this.gen) return;
      // Padded to a whole packet: what comes next starts on the next one, marked again.
      this.base = this.produced;
      this.fed = 0;
      this.expect = undefined;
      this.out(true);
      this.fresh = true;
    });
  }

  private after(out: Promise<Buffer>, gen: number) {
    const result = settle(out);
    this.chain = this.chain.then(async () => {
      const r = await result;
      if (gen !== this.gen) return;
      if (!r.ok) {
        log("error", { where: "phone_opus_encode", message: why(r.error) });
        return this.cut(); // a new encoder for what comes next
      }
      const packets = splitPackets(r.value) ?? [];
      this.produced += packets.length * VOICE_PACKET;
      this.ready.push(...packets);
      if (this.fresh && this.ready.length) {
        this.fresh = false;
        this.out(true); // the first of a stretch: at once
      } else if (this.ready.length >= PACKETS_PER_MESSAGE) this.out(false);
    });
  }

  /** Sends what's ready: five at a time, and with `all`, what's left too. */
  private out(all: boolean) {
    while (this.ready.length >= PACKETS_PER_MESSAGE || (all && this.ready.length)) {
      const some = this.ready.splice(0, all && this.ready.length < PACKETS_PER_MESSAGE ? this.ready.length : PACKETS_PER_MESSAGE);
      this.send(joinPackets(some), some.length, this.marksFor(some.length * VOICE_PACKET));
    }
  }

  /** The marks for the next `samples` sent (FrameMarks), and the runs they leave behind dropped. */
  private marksFor(samples: number): FrameMarks {
    const from = this.sentAt;
    const to = from + samples;
    this.sentAt = to;
    let headRun: { streamAt: number; pos: VoicePos | null } | null = null;
    const marks: FrameMarks["marks"] = [];
    for (const run of this.runs) {
      if (run.streamAt <= from) headRun = run;
      if (run.streamAt < to && !run.told) {
        run.told = true;
        if (run.pos) marks.push({ line: run.pos.line, at: run.pos.at, offset: Math.max(0, run.streamAt - from) });
      }
    }
    // Runs that started before this frame's end and have a later one started before it too: done with.
    while (this.runs.length > 1 && this.runs[1].streamAt <= to) this.runs.shift();
    const head = headRun?.pos ? { line: headRun.pos.line, at: headRun.pos.at + (from - headRun.streamAt) } : null;
    return { marks, head };
  }

  private arm() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    const gen = this.gen;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.chain = this.chain.then(() => {
        if (gen === this.gen) this.out(true);
      });
    }, this.o.idleMs ?? 40);
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      if (gen === this.gen) this.end();
    }, this.o.endMs ?? 250);
    this.idleTimer.unref();
    this.endTimer.unref();
  }

  private disarm() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.idleTimer = this.endTimer = null;
  }
}

/**
 * One press's audio from a phone on Opus, decoded to 16 kHz PCM for speech-to-text in the order it
 * came. PCM in JSON during the same press (it shouldn't happen) waits its turn behind what's still
 * being decoded. `drained()` resolves once all of it has been handed on: the press ends only then.
 */
export class TalkDecoder {
  private stream: OpusStream | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  /** Bytes of PCM handed on, and packets decoded: for the log. */
  pcmBytes = 0;
  packets = 0;

  private opus: Opus;
  private sink: (pcm: Buffer) => void;

  constructor(opus: Opus, sink: (pcm: Buffer) => void) {
    this.opus = opus;
    this.sink = sink;
  }

  /** Packets (behind their lengths), as a binary frame carries them. */
  packetsIn(packets: Buffer, count: number) {
    if (this.closed) return;
    const stream = (this.stream ??= this.opus.decoder(TALK_RATE));
    const result = settle(stream.push(packets));
    this.packets += count;
    this.chain = this.chain.then(async () => {
      const r = await result;
      if (r.ok) return this.give(r.value);
      log("error", { where: "phone_opus_decode", message: why(r.error) });
      if (this.stream === stream) {
        stream.close();
        this.stream = null; // the next packets get a new decoder
      }
    });
  }

  /** PCM as it came in JSON: after what's ahead of it. */
  pcmIn(pcm: Buffer) {
    if (this.closed) return;
    this.chain = this.chain.then(() => this.give(pcm));
  }

  /** Resolves once everything given so far has gone to the sink (or `timeoutMs` passed: false). */
  drained(timeoutMs = 1000): Promise<boolean> {
    let timer: NodeJS.Timeout | null = null;
    const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
    return Promise.race([this.chain.then(() => true), late]).finally(() => timer && clearTimeout(timer));
  }

  close() {
    this.closed = true;
    this.stream?.close();
    this.stream = null;
  }

  private give(pcm: Buffer) {
    if (this.closed || !pcm.length) return;
    this.pcmBytes += pcm.length;
    this.sink(pcm);
  }
}
