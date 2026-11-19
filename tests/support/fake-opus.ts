// A stand-in for Apple's Opus (src/platform/macos/opus.ts) for the unit tests: no helper, no sound.
import type { Opus, OpusStream } from "../../src/platform/types.ts";
import { joinPackets, splitPackets } from "../../src/remote/opus.ts";

/**
 * A stand-in for Apple's Opus: each 20 ms frame of PCM is one 4-byte packet (its index and first
 * sample), and back; answers come a moment later, as the helper's do, in order.
 */
export function fakeOpus(o: { delayMs?: number } = {}): Opus & { opened: string[] } {
  const opened: string[] = [];
  const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), o.delayMs ?? 1));
  return {
    opened,
    available: () => true,
    encoder(rate: number): OpusStream {
      opened.push(`encoder ${rate}`);
      const bytes = (rate / 50) * 2;
      let waiting = Buffer.alloc(0);
      let n = 0;
      let closed = false;
      const packet = (pcm: Buffer) => Buffer.from([n++ & 0xff, 0x55, pcm.readInt16LE(0) & 0xff, (pcm.readInt16LE(0) >> 8) & 0xff]);
      let queue = Promise.resolve<unknown>(null);
      const ask = (f: () => Buffer) => (queue = queue.then(() => (closed ? Promise.reject(new Error("closed")) : later(f())))) as Promise<Buffer>;
      return {
        push: (pcm) =>
          ask(() => {
            waiting = Buffer.concat([waiting, pcm]);
            const out: Buffer[] = [];
            while (waiting.length >= bytes) {
              out.push(packet(waiting.subarray(0, bytes)));
              waiting = waiting.subarray(bytes);
            }
            return out.length ? joinPackets(out) : Buffer.alloc(0);
          }),
        flush: () =>
          ask(() => {
            if (!waiting.length) return Buffer.alloc(0);
            const last = Buffer.concat([waiting, Buffer.alloc(bytes - waiting.length)]);
            waiting = Buffer.alloc(0);
            return joinPackets([packet(last)]);
          }),
        close: () => void (closed = true),
      };
    },
    decoder(rate: number): OpusStream {
      opened.push(`decoder ${rate}`);
      const bytes = (rate / 50) * 2;
      let queue = Promise.resolve<unknown>(null);
      return {
        push: (packets) =>
          (queue = queue.then(() => {
            const split = splitPackets(packets)!;
            const pcm = Buffer.concat(
              split.map((p) => {
                const b = Buffer.alloc(bytes);
                for (let i = 0; i < bytes; i += 2) b.writeInt16LE(p.readInt16LE(2), i);
                return b;
              }),
            );
            return later(pcm);
          })) as Promise<Buffer>,
        flush: () => later(Buffer.alloc(0)),
        close: () => {},
      };
    },
  };
}
