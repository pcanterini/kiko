// Hands-free from the phone, through a real server (src/remote/server.ts): welcome offers it only
// from a hub that listens (an older one refuses what it doesn't know); hands_free turns the phone's
// listener on and off (PhoneHub.listen); its audio, PCM in JSON or Opus in binary frames of kind 3,
// reaches the listener only while it's on; hands_free_state goes only to that phone, and only once it
// asked; the app going away or the connection closing stops it.
import "../../setup.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import type { Opus, OpusStream } from "../../../src/platform/types.ts";
import { frame, joinPackets, KIND, splitPackets } from "../../../src/remote/opus.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";
import { checkWaits } from "../../support/until.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = checkWaits(3000, 5);

/** Opus as a 4-byte packet per 20 ms frame (the frame's first sample in it), decoded back to that frame. */
const fakeOpus: Opus = {
  available: () => true,
  encoder(): OpusStream {
    throw new Error("not used");
  },
  decoder(rate: number): OpusStream {
    const bytes = (rate / 50) * 2;
    return {
      push: async (packets) =>
        Buffer.concat(
          splitPackets(packets)!.map((p) => {
            const b = Buffer.alloc(bytes);
            for (let i = 0; i < bytes; i += 2) b.writeInt16LE(p.readInt16LE(2), i);
            return b;
          }),
        ),
      flush: async () => Buffer.alloc(0),
      close: () => {},
    };
  },
};

function phone(port: number) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  return {
    got,
    async send(m: Record<string, unknown>) {
      await opened;
      const text = JSON.stringify({ v: 1, ...m });
      assert.equal(invalid(JSON.parse(text), "phone"), null, text);
      ws.send(text);
    },
    async sendBinary(b: Buffer) {
      await opened;
      ws.send(b);
    },
    all: (type: string) => got.filter((m) => m.type === type),
    next(type: string, after = 0) {
      return until(() => got.filter((m) => m.type === type).length > after).then(() => got.filter((m) => m.type === type)[after]);
    },
    close: () => ws.close(),
  };
}

const pcm = (value: number) => {
  const b = Buffer.alloc(3200);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
};

async function setUp(name: string, o: { listens?: boolean; playing?: boolean } = {}) {
  const calls: string[] = [];
  const played: Array<[string, boolean]> = [];
  const heard: Array<[string, number, number]> = [];
  let server: PhoneServer;
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: () => {},
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
    ...(o.listens === false
      ? {}
      : {
          async listen(phoneId: string, on: boolean, why: string) {
            calls.push(`${on ? "on" : "off"} ${why}`);
            // As the app does: the phone told how its listener is.
            server.handsFreeState(phoneId, { on, by: null, name: "Kiko" });
            return null;
          },
          listenAudio: (phoneId: string, b: Buffer) => void heard.push([phoneId, b.readInt16LE(0), b.length]),
          ...(o.playing === false ? {} : { listenPlaying: (phoneId: string, on: boolean) => void played.push([phoneId, on]) }),
        }),
  };
  const pairing = new Pairing(join(process.cwd(), `phones-hf-${name}.json`));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceMs: 60_000, presenceSettleMs: 0, opus: fakeOpus });
  const port = await server.start();
  const p = phone(port);
  await p.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
  const welcome = await p.next("welcome");
  await p.send({ type: "presence", state: "back" });
  return { server, p, welcome, calls, heard, played, phoneId: welcome.phoneId as string, pairing, port };
}

describe("hands-free from the phone, through a real server", () => {
  test("offered in welcome only by a hub that listens; an older one's phone never asks", async () => {
    const yes = await setUp("offered");
    const no = await setUp("not-offered", { listens: false });
    try {
      assert.equal(yes.welcome.handsFree, true);
      assert.equal(no.welcome.handsFree, undefined);
      await no.p.send({ type: "hands_free", on: true });
      const err = await no.p.next("error");
      assert.equal(err.code, "invalid");
    } finally {
      for (const x of [yes, no]) {
        x.p.close();
        x.server.stop();
      }
    }
  });

  test("hands_free_playing: offered with handsFreePlaying, reaches the listener only while it's on", async () => {
    const yes = await setUp("playing");
    const older = await setUp("playing-older", { playing: false });
    try {
      assert.equal(yes.welcome.handsFreePlaying, true);
      assert.equal(older.welcome.handsFree, true);
      assert.equal(older.welcome.handsFreePlaying, undefined, "a hub that doesn't take it doesn't offer it");
      const { p, played, phoneId } = yes;
      await p.send({ type: "hands_free_playing", playing: true }); // before it's on: dropped, no error
      await p.send({ type: "hands_free", on: true });
      await p.next("hands_free_state");
      await p.send({ type: "hands_free_playing", playing: true });
      await p.send({ type: "listen_audio", data: pcm(1).toString("base64") });
      await p.send({ type: "hands_free_playing", playing: false });
      await until(() => played.length >= 2);
      assert.deepEqual(played, [
        [phoneId, true],
        [phoneId, false],
      ]);
      await p.send({ type: "hands_free", on: false });
      await p.next("hands_free_state", 1);
      await p.send({ type: "hands_free_playing", playing: true });
      await wait(50);
      assert.equal(played.length, 2, "after it's off: dropped");
      assert.deepEqual(p.all("error"), [], "never refused");
    } finally {
      for (const x of [yes, older]) {
        x.p.close();
        x.server.stop();
      }
    }
  });

  test("on: its audio reaches the listener (PCM and Opus, kind 3), in order; off: dropped", async () => {
    const { server, p, calls, heard, phoneId } = await setUp("audio");
    try {
      // Before it's on: dropped, no error.
      await p.send({ type: "listen_audio", data: pcm(1).toString("base64") });
      await p.send({ type: "hands_free", on: true });
      const state = await p.next("hands_free_state");
      assert.deepEqual(state, { v: 1, type: "hands_free_state", on: true, by: null, name: "Kiko" });
      assert.deepEqual(calls, ["on phone"]);
      await p.send({ type: "listen_audio", data: pcm(2).toString("base64") });
      await p.send({ type: "audio_codecs", codecs: ["opus"] });
      await p.next("audio_codec");
      const packet = (v: number) => Buffer.from([0, 0x55, v & 0xff, v >> 8]);
      await p.sendBinary(frame(1, KIND.listen, joinPackets([packet(3), packet(4)])));
      await until(() => heard.length >= 2);
      assert.deepEqual(heard, [
        [phoneId, 2, 3200],
        [phoneId, 3, 1280], // a frame's two packets, decoded in order: 2 × 20 ms
      ]);
      await p.send({ type: "hands_free", on: false });
      await p.next("hands_free_state", 1);
      assert.deepEqual(calls, ["on phone", "off phone"]);
      await p.sendBinary(frame(1, KIND.listen, joinPackets([packet(5)])));
      await p.send({ type: "listen_audio", data: pcm(6).toString("base64") });
      await wait(50);
      assert.equal(heard.length, 2, "after it's off: dropped");
      assert.deepEqual(p.all("error"), [], "never refused");
    } finally {
      p.close();
      server.stop();
    }
  });

  test("the app going away stops it; back in front, the phone turns it on again", async () => {
    const { server, p, calls } = await setUp("away");
    try {
      await p.send({ type: "hands_free", on: true });
      await p.next("hands_free_state");
      await p.send({ type: "presence", state: "away" });
      await until(() => calls.length === 2);
      assert.deepEqual(calls, ["on phone", "off away"]);
      // Said while away (a race as it goes): not now.
      await p.send({ type: "hands_free", on: true });
      const s = await p.next("hands_free_state", 2);
      assert.equal(s.on, false);
      assert.equal(calls.length, 2);
      await p.send({ type: "presence", state: "back" });
      await p.send({ type: "hands_free", on: true });
      await until(() => calls.length === 3);
      assert.equal(calls[2], "on phone");
    } finally {
      p.close();
      server.stop();
    }
  });

  test("the connection closing stops it; hands_free_state only to phones that asked", async () => {
    const a = await setUp("closing");
    try {
      await a.p.send({ type: "hands_free", on: true });
      await a.p.next("hands_free_state");
      const other = phone(a.port);
      // A second phone that never asked about hands-free gets none of the first's.
      await other.send({ type: "pair", code: a.pairing.open().code, device: "Other", appVersion: "0.1.0" });
      await other.next("welcome");
      a.server.handsFreeState(a.phoneId, { on: true, by: "name", name: "Kiko" });
      await a.p.next("hands_free_state", 1);
      await wait(30);
      assert.deepEqual(other.all("hands_free_state"), []);
      a.p.close();
      await until(() => a.calls.length === 2);
      assert.deepEqual(a.calls, ["on phone", "off gone"]);
      other.close();
    } finally {
      a.server.stop();
    }
  });
});
