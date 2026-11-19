// The protocol (protocol/schema.json) and its examples: every example is a valid message of the
// type its file is named for, every message type has an example, and messages that break the
// schema are caught (the server checks every message the phone sends with the same validator).
// The iOS app's tests decode the same examples, so the two sides can't drift apart.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { invalid, MESSAGE_TYPES, PROTOCOL_VERSION, schema } from "../../../src/remote/schema.ts";

const DIR = new URL("../../../protocol/examples/", import.meta.url);
const examples = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((file) => ({ file, message: JSON.parse(readFileSync(new URL(file, DIR), "utf8")) }));

test("the schema's version is the one every message carries", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(schema.$defs.v.const, PROTOCOL_VERSION);
});

for (const { file, message } of examples) {
  test(`example ${file} is a valid ${message.type} message`, () => {
    assert.ok(file.startsWith(`${message.type}.`), "named after its type");
    assert.equal(message.v, PROTOCOL_VERSION);
    assert.equal(invalid(message, MESSAGE_TYPES.get(message.type)), null);
  });
}

test("every message type has an example, and says who sends it", () => {
  const covered = new Set(examples.map((e) => e.message.type));
  for (const [type, from] of MESSAGE_TYPES) {
    assert.ok(covered.has(type), `no example for ${type}`);
    assert.ok(from === "phone" || from === "hub", `${type} has no x-from`);
  }
});

test("messages that break the schema are caught, with why", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /not a JSON object/],
    [[1], /not a JSON object/],
    [{ v: 1, type: "nope" }, /unknown type/],
    [{ type: "talk_end" }, /missing v/],
    [{ v: 2, type: "talk_end" }, /talk_end\.v: must be 1/],
    [{ v: 1, type: "talk_end", extra: true }, /unexpected field extra/],
    [{ v: 1, type: "pair", code: "12345", device: "x", appVersion: "1" }, /pair\.code/],
    [{ v: 1, type: "hello", token: "short", device: "x", appVersion: "1" }, /hello\.token: shorter/],
    [{ v: 1, type: "permission", promptId: "p", decision: "maybe" }, /decision: must be one of/],
    [{ v: 1, type: "type", text: "" }, /type\.text: shorter/],
    [{ v: 1, type: "talk_audio", data: "not base64!" }, /talk_audio\.data/],
    [{ v: 1, type: "watch" }, /missing sessionId/],
    [{ v: 1, type: "play_on_phone", on: "yes" }, /must be boolean/],
    [{ v: 1, type: "play_on_mac" }, /missing on/],
    [{ v: 1, type: "state", listening: true, talker: "bob", speaking: false, deciding: null, routed: null, waiting: null, holding: null, muted: false, playOnMac: true }, /talker/],
    [{ v: 1, type: "state", listening: true, talker: null, speaking: false, deciding: null, routed: null, waiting: null, holding: null, muted: false }, /missing playOnMac/],
    [
      { v: 1, type: "welcome", hubName: "h", phoneId: "p", playOnPhone: false, playOnMac: true, versions: [1], addresses: [{ kind: "lan", host: "192.168.1.20", port: 7333 }] },
      /welcome\.addresses\[0\]\.kind: must be one of/,
    ],
    [{ v: 1, type: "paired", token: "t".repeat(40), phoneId: "p", hubName: "h", addresses: [{ kind: "home", host: "192.168.1.20" }] }, /paired\.addresses\[0\]: missing port/],
    [{ v: 1, type: "history", sessionId: "s", items: [{ kind: "steps", summary: "", steps: [{ tool: "Bash" }], at: null }], truncated: false }, /history\.items/],
    [{ v: 1, type: "presence", state: "gone" }, /presence\.state: must be one of/],
    [{ v: 1, type: "seen", upTo: 0 }, /seen\.upTo: below 1/],
    [{ v: 1, type: "seen", upTo: 1.5 }, /seen\.upTo: must be integer/],
    [{ v: 1, type: "catch_up", ids: ["x"] }, /catch_up\.ids\[0\]/],
    [{ v: 1, type: "missed", items: [{ id: 1, at: 1, sessionId: null, name: null, kind: "update", text: "x" }] }, /missed\.items\[0\]\.kind/],
    [{ v: 1, type: "missed", items: [{ id: 1, at: 1, sessionId: null, kind: "answer", text: "x" }] }, /missed\.items\[0\]: missing name/],
    [{ v: 1, type: "missed", items: [{ id: 1, at: 1, sessionId: null, name: null, kind: "answer", text: "x", settled: { how: "done", at: 1 } }] }, /missed\.items\[0\]\.settled\.how/],
    [{ v: 1, type: "missed_settled", items: [{ id: 1, settled: { how: "replied" } }] }, /missed_settled\.items\[0\]\.settled: missing at/],
    [{ v: 1, type: "catch_up", summary: "yes" }, /catch_up\.summary: must be boolean/],
    [{ v: 1, type: "catch_up_stop", now: true }, /unexpected field now/],
    [
      { v: 1, type: "state", listening: false, talker: null, speaking: false, deciding: null, routed: null, waiting: null, holding: null, muted: false, playOnMac: true, catchingUp: 1 },
      /state\.catchingUp: must be boolean/,
    ],
    [{ v: 1, type: "talk_start", talkId: "" }, /talk_start\.talkId: shorter/],
    [{ v: 1, type: "type", text: "hi", talkId: 7 }, /type\.talkId: must be string/],
    [{ v: 1, type: "talk_status", talkId: "t", stage: "sent" }, /talk_status\.stage: must be one of/],
    [{ v: 1, type: "talk_status", stage: "heard" }, /talk_status: missing talkId/],
    [{ v: 1, type: "talk_status", talkId: "t", stage: "delivered", queued: "yes" }, /talk_status\.queued: must be boolean/],
    [{ v: 1, type: "welcome", hubName: "h", phoneId: "p", playOnPhone: false, playOnMac: true, versions: [1], talkStatus: 1 }, /welcome\.talkStatus: must be boolean/],
    [{ v: 1, type: "relay_pair", key: "not a key" }, /relay_pair\.key: doesn't match/],
    [{ v: 1, type: "relay_pair" }, /relay_pair: missing key/],
    [
      { v: 1, type: "relay_paired", url: "https://relay.example.com", room: "0".repeat(32), macKey: `${"A".repeat(43)}=`, signingKey: `${"A".repeat(43)}=`, credential: `${"A".repeat(43)}=` },
      /relay_paired\.url: doesn't match/,
    ],
    [{ v: 1, type: "relay_paired", url: "wss://relay.example.com", room: "0".repeat(32), macKey: `${"A".repeat(43)}=`, signingKey: `${"A".repeat(43)}=` }, /relay_paired: missing credential/],
    [
      {
        v: 1,
        type: "welcome",
        hubName: "h",
        phoneId: "p",
        playOnPhone: false,
        playOnMac: true,
        versions: [1],
        addresses: [{ kind: "relay", host: "r.example.com", port: 443, url: "wss://r.example.com", room: "ROOM" }],
      },
      /welcome\.addresses\[0\]\.room: doesn't match/,
    ],
    [{ v: 1, type: "welcome", hubName: "h", phoneId: "p", playOnPhone: false, playOnMac: true, versions: [1], relay: "yes" }, /welcome\.relay: must be boolean/],
    [{ v: 1, type: "account", signedIn: true, ownKey: false, plan: "free" }, /account\.plan: must be one of/],
    [{ v: 1, type: "account", signedIn: true, plan: "trial" }, /account: missing ownKey/],
    [{ v: 1, type: "account", signedIn: true, ownKey: false, plan: "trial", usedPct: 101 }, /account\.usedPct: above 100/],
    [{ v: 1, type: "account", signedIn: true, ownKey: false, plan: "trial", endedWhy: "money" }, /account\.endedWhy: must be one of/],
    [{ v: 1, type: "account", signedIn: true, ownKey: false, plan: "none", email: "a@b.c" }, /unexpected field email/],
  ];
  for (const [message, why] of cases) assert.match(invalid(message) ?? "valid", why, JSON.stringify(message));
});

test("who sends what: a hub message from the phone is refused", () => {
  assert.match(invalid({ v: 1, type: "audio_stop" }, "phone") ?? "", /isn't sent by the phone/);
  assert.equal(invalid({ v: 1, type: "audio_stop" }, "hub"), null);
});
