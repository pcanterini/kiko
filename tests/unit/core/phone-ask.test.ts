// "Pair my phone" to the app (src/core/routing-rules.ts asksPhone): while the iPhone app isn't out
// (core/env.ts phoneLive off), app/deliver.ts answers it with one line ("The iPhone app isn't out
// yet.") before anything is decided; live, it goes on as any words do. Only the request itself, the
// whole of what was said: words for a session that mention a phone stay that session's.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asksPhone } from "../../../src/core/routing-rules.ts";

describe("asksPhone", () => {
  test("asking the app to pair or set up the phone", () => {
    for (const text of [
      "Pair my phone.",
      "pair my iPhone",
      "Pair my i phone with Kiko.",
      "Connect my phone to this Mac.",
      "Can you pair my phone?",
      "How do I set up the iPhone app?",
      "I want to connect my iPhone.",
      "Set up the phone app, please.",
      "Turn on the phone.",
      "turn the phone on",
      "Show me the pairing code.",
      "the QR code for my phone",
      "phone pairing",
      "Okay, link my phone.",
    ])
      assert.ok(asksPhone(text), text);
  });

  test("words for a session, or about something else, aren't", () => {
    for (const text of [
      "connect the phone number field to the form",
      "add a phone number to the signup page",
      "tell pixie to pair my phone",
      "the phone app's layout is broken on small screens",
      "pair program with me on this",
      "turn on the microphone",
      "call my phone",
      "what's on my phone",
      "fix the iPhone build",
    ])
      assert.ok(!asksPhone(text), text);
  });
});
