// The relay eval's hard checks (tests/eval/relay/checks.ts), its cases and splits, and what its judge
// reads: all in code, no model, no network.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CALIBRATION } from "../../eval/relay/calibration.ts";
import { CATEGORIES, categoryOf, PRIVATE_RELAY_IDS, RELAY_CASES, SPLITS } from "../../eval/relay/cases.ts";
import { checkConditions, checkGone, checkMustKeep, checkNegations, checkNothingAdded, checkReplyExact, checkTarget, hardChecks, hasVerbatim, type Reference } from "../../eval/relay/checks.ts";
import { judgePrompt } from "../../eval/relay/judge.ts";
import { inputHash, readReferences, settle } from "../../eval/relay/reference.ts";
import { assignSplits, SHARE, SPLIT_NAMES } from "../../eval/relay/splits.ts";

const ref = (r: Partial<Reference>): Reference => ({
  intent: "",
  actions: [],
  direction: [],
  kikoParts: [],
  mustKeep: [],
  negations: [],
  conditions: [],
  messages: [],
  isReply: false,
  notes: "",
  ...r,
});
// With the private cases (tests/eval/private/, made from the owner's words) the whole suite is held to
// the full counts; without them (the public repo) the constructed cases alone, to a smaller minimum
// and a looser split balance (a category short of its private cases is a little off its 60/20/20).
const WHOLE = PRIVATE_RELAY_IDS.size > 0;
const MIN_CASES = WHOLE ? 200 : 180;
const SPLIT_SLACK = WHOLE ? 1.5 : 2;
const MINTBOX = "Ask MintBox, what do I have to do to renew the signing certificate that's expiring?";

describe("relay hard checks", () => {
  test("target: the same sessions, any case, or nowhere; alsoOk counts", () => {
    assert.equal(checkTarget("mintbox", [{ to: "MintBox", text: "x", via: "terminal", action: "send" }]).pass, true);
    assert.equal(checkTarget(["atlas", "harbor"], [{ to: "harbor", text: "x", via: "terminal", action: "send" }]).pass, false);
    assert.equal(
      checkTarget(
        ["atlas", "harbor"],
        [
          { to: "harbor", text: "x", via: "terminal", action: "send" },
          { to: "atlas", text: "x", via: "terminal", action: "ask" },
        ],
      ).pass,
      true,
    );
    assert.equal(checkTarget(null, []).pass, true);
    assert.match(checkTarget(null, [{ to: "atlas", text: "x", via: "terminal", action: "send" }]).why!, /went to atlas, wanted nowhere/);
    assert.equal(checkTarget(null, [{ to: "atlas", text: "x", via: "terminal", action: "send" }], ["atlas"]).pass, true);
    assert.match(checkTarget("atlas", []).why!, /went nowhere/);
  });

  test("direction: the 2026-11-07 incident fails, the question alone passes, a name left behind fails", () => {
    const ideal = "What do I have to do to renew the signing certificate that's expiring?";
    assert.equal(checkGone("direction", MINTBOX, ["Ask MintBox,"], ideal).pass, false);
    assert.equal(checkGone("direction", ideal, ["Ask MintBox,"], ideal).pass, true);
    const left = checkGone("direction", "MintBox, what do I have to do to renew the signing certificate that's expiring?", ["Ask MintBox,"], ideal);
    assert.equal(left.pass, false);
    assert.match(left.why!, /mintbox/);
  });

  test("direction: a session named as content stays when the ideal has it", () => {
    const ideal = "MintBox already fixed the cert.";
    assert.equal(checkGone("direction", "MintBox already fixed the cert.", ["Tell Bobby that"], ideal).pass, true);
    assert.equal(checkGone("direction", "Tell Bobby that MintBox already fixed the cert.", ["Tell Bobby that"], ideal).pass, false);
    // "ask me" kept as content: the ideal has the run too.
    assert.equal(checkGone("direction", "Ask me before you delete anything.", ["Tell Atlas to"], "Ask me before you delete anything.").pass, true);
  });

  test("Kiko's words gone", () => {
    const c = checkGone("kiko-words", "Run the tests, and Kiko, slow down when you read the results.", ["and Kiko, slow down when you read the results"], "Run the tests.");
    assert.equal(c.pass, false);
    assert.equal(c.name, "kiko-words");
  });

  test("must-keep: verbatim, case kept for identifiers, sentence punctuation aside", () => {
    assert.equal(checkMustKeep("Deploy v2.14.3 to staging, not production.", ["v2.14.3"]).pass, true);
    assert.equal(checkMustKeep("Deploy v2.14 to staging.", ["v2.14.3"]).pass, false);
    assert.equal(checkMustKeep("Rename checkoutstep to PaymentStep.", ["CheckoutStep"]).pass, false);
    assert.equal(checkMustKeep("Change src/checkout/config.ts from 30 to 45 seconds.", ["src/checkout/config.ts", "30", "45 seconds"]).pass, true);
    assert.equal(hasVerbatim('The banner should read exactly: "Fresh bread every morning."', '"Fresh bread every morning."'), true);
    assert.equal(hasVerbatim("Only change the second screen.", "only change"), true);
  });

  test("negations: each kind kept, however it's worded", () => {
    assert.equal(checkNegations("Don't push yet.", ["not to push yet"]).pass, true);
    assert.equal(checkNegations("Push yet.", ["not to push yet"]).pass, false);
    assert.equal(checkNegations("Remove the banner on mobile, and not the cookie notice.", ["only on mobile", "not the cookie notice"]).why, "lost: only ×1");
    assert.equal(checkNegations("Never retry a refund automatically.", ["never retry"]).pass, true);
    assert.equal(checkNegations("Deploy if the smoke tests pass.", ["unless the smoke tests fail"]).pass, false);
  });

  test("conditions: the condition word and its content words kept (stemmed)", () => {
    assert.equal(checkConditions("If you're done, open a PR.", ["If it's done"]).pass, true);
    assert.equal(checkConditions("Fix the typo and merge it.", ["if the tests pass"]).pass, false);
    assert.equal(checkConditions("Commit, then push, then deploy.", ["then push"]).pass, true);
    assert.equal(checkConditions("When the deploy is finished, run the smoke tests twice.", ["When Harbor finishes the deploy"]).pass, false);
  });

  test("nothing added: framing words may change, content words may not", () => {
    assert.equal(checkNothingAdded("Tell Bobby to restart the server.", "Restart the server.").pass, true);
    assert.equal(checkNothingAdded("Ask MintBox whether the notarization went through.", "Did the notarization go through?").pass, true);
    assert.equal(checkNothingAdded("Ask Orbit how it plans to handle refunds.", "How do you plan to handle refunds?").pass, true);
    assert.equal(checkNothingAdded("Tell Harbor not to push yet.", "Don't push yet.").pass, true);
    const added = checkNothingAdded("Ask Atlas to rename the component.", "Rename the component and run the tests.");
    assert.equal(added.pass, false);
    assert.match(added.why!, /run/);
  });

  test("reply-exact: as said, less fillers, a stutter and the session's own name", () => {
    assert.equal(checkReplyExact("Go ahead, but only on staging.", "Go ahead, but only on staging.", ["harbor"]).pass, true);
    assert.equal(checkReplyExact("Bobby, yes do it.", "Yes do it.", ["Bobby"]).pass, true);
    assert.equal(checkReplyExact("Uh, yeah, sure, um, go for it.", "Yeah, sure, go for it.", ["pixie"]).pass, true);
    assert.equal(checkReplyExact("Go ahead, but only on staging.", "Deploy it, but only to staging.", ["harbor"]).pass, false);
    assert.match(checkReplyExact("No, don't push yet.", "No, push yet.", ["atlas"]).why!, /dropped: dont/);
    assert.equal(checkReplyExact("Do it the way Atlas did the checkout.", "Do it the way did the checkout.", ["juniper"]).pass, false);
  });

  test("all together: the MintBox case as typed today fails direction only", () => {
    const reference = ref({
      direction: ["Ask MintBox,"],
      messages: [{ to: "mintbox", text: "What do I have to do to renew the signing certificate that's expiring?" }],
    });
    const checks = hardChecks({ said: MINTBOX, sent: [{ to: "mintbox", text: MINTBOX, via: "terminal", action: "send" }], want: "mintbox", reference, reply: null });
    assert.deepEqual(
      checks.filter((c) => !c.pass).map((c) => c.name),
      ["direction"],
    );
    // No reference: the target only.
    assert.deepEqual(
      hardChecks({ said: MINTBOX, sent: [{ to: "mintbox", text: MINTBOX, via: "terminal", action: "send" }], want: "mintbox", reference: null, reply: null }).map((c) => c.name),
      ["target"],
    );
  });

  test("several sessions, a message each: each judged on its own part", () => {
    const reference = ref({
      direction: ["Tell Mintbox to", "and Pixie to"],
      mustKeep: [],
      negations: [],
      messages: [
        { to: "mintbox", text: "Add the export button." },
        { to: "pixie", text: "Update the screenshots." },
      ],
    });
    const checks = hardChecks({
      said: "Tell Mintbox to add the export button and Pixie to update the screenshots.",
      sent: [
        { to: "mintbox", text: "Add the export button.", via: "terminal", action: "send" },
        { to: "pixie", text: "Update the screenshots.", via: "terminal", action: "send" },
      ],
      want: ["mintbox", "pixie"],
      reference,
      reply: null,
    });
    assert.ok(
      checks.every((c) => c.pass),
      JSON.stringify(checks.filter((c) => !c.pass)),
    );
  });
});

describe("relay cases", () => {
  test("ids unique, categories known, targets among the sessions, enough per category", () => {
    assert.equal(new Set(RELAY_CASES.map((c) => c.id)).size, RELAY_CASES.length);
    assert.ok(RELAY_CASES.length >= MIN_CASES, `${RELAY_CASES.length} cases`);
    for (const c of RELAY_CASES) {
      assert.ok((CATEGORIES as readonly string[]).includes(categoryOf(c)), c.id);
      const names = c.sessions.map((s) => s.name.toLowerCase());
      for (const t of c.to === null ? [] : Array.isArray(c.to) ? c.to : [c.to]) assert.ok(names.includes(t.toLowerCase()), `${c.id}: ${t}`);
      if (categoryOf(c) === "reply-exact") assert.ok(c.waiting && c.to === c.waiting, `${c.id}: a reply goes to the one waiting`);
    }
    for (const cat of CATEGORIES) assert.ok(RELAY_CASES.filter((c) => categoryOf(c) === cat).length >= 7, cat);
  });

  test("every case has its stored split, about 60/20/20 within each category", () => {
    for (const c of RELAY_CASES) assert.ok(SPLITS[c.id], `${c.id} has no split: pnpm eval:relay --assign-splits`);
    for (const cat of CATEGORIES) {
      const of = RELAY_CASES.filter((c) => categoryOf(c) === cat);
      for (const s of SPLIT_NAMES) {
        const n = of.filter((c) => SPLITS[c.id] === s).length;
        assert.ok(Math.abs(n - SHARE[s] * of.length) <= SPLIT_SLACK, `${cat}: ${n} ${s} of ${of.length}`);
      }
    }
  });

  test("assigning splits keeps the ones given and fills the share furthest behind", () => {
    const cases = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, category: "x" }));
    const fresh = assignSplits(cases, {});
    assert.deepEqual(
      SPLIT_NAMES.map((s) => Object.values(fresh).filter((x) => x === s).length),
      [6, 2, 2],
    );
    assert.deepEqual(assignSplits(cases, fresh), fresh);
    const kept = assignSplits([...cases, { id: "c10", category: "x" }], fresh);
    for (const c of cases) assert.equal(kept[c.id], fresh[c.id]);
    assert.ok(kept.c10);
  });

  test("the stored reference: current entries name the case's sessions; a changed case is stale", () => {
    const file = readReferences();
    for (const c of RELAY_CASES) {
      const e = file.cases[c.id];
      if (!e || e.inputHash !== inputHash(c)) continue;
      const names = c.sessions.map((s) => s.name.toLowerCase());
      for (const m of e.reference.messages) assert.ok(names.includes(m.to.toLowerCase()), `${c.id}: ${m.to}`);
      if (categoryOf(c) === "reply-exact") assert.equal(e.reference.messages[0]?.text, c.say, `${c.id}: a reply's ideal is the words as said`);
    }
    const c = RELAY_CASES[0];
    assert.notEqual(inputHash(c), inputHash({ ...c, say: `${c.say} ` }));
  });

  test("the stored reference passes its own hard checks: its ideal messages, typed, pass", () => {
    const file = readReferences();
    const failing: string[] = [];
    for (const c of RELAY_CASES) {
      const e = file.cases[c.id];
      if (!e || e.inputHash !== inputHash(c)) continue;
      const sent = e.reference.messages.map((m) => ({ to: m.to, text: m.text, via: c.waiting === m.to ? "reply" : "terminal", action: "send" }));
      const names = categoryOf(c) === "reply-exact" ? { names: [c.waiting!] } : null;
      const bad = hardChecks({ said: c.say, sent, want: c.to, alsoOk: c.alsoOk, reference: e.reference, reply: names }).filter((x) => !x.pass);
      if (bad.length) failing.push(`${c.id}: ${bad.map((x) => `${x.name} ${x.why}`).join("; ")}`);
    }
    assert.deepEqual(failing, []);
  });

  test("settling a reference: a reply's ideal is the words as said; spans not in the words are flagged", () => {
    const reply = RELAY_CASES.find((c) => c.id === "reply-own-name-bobby")!;
    const { reference, flags } = settle(reply, ref({ messages: [{ to: "bobby", text: "Yes, do it." }], direction: ["Bobby,"], mustKeep: ["snapshots"] }));
    assert.deepEqual(reference.messages, [{ to: "Bobby", text: "Bobby, yes do it." }]);
    assert.deepEqual(reference.direction, []);
    assert.ok(flags.some((f) => f.startsWith("reply rule")));
    assert.ok(flags.some((f) => f.startsWith("mustKeep not in the words")));
  });
});

describe("relay judge input", () => {
  test("the calibration set: labelled both ways, each a known aspect", () => {
    assert.ok(CALIBRATION.length >= 20);
    assert.ok(CALIBRATION.filter((x) => x.label === "pass").length >= 8);
    assert.ok(CALIBRATION.filter((x) => x.label === "fail").length >= 8);
    for (const x of CALIBRATION) assert.equal(x.label === "pass", x.aspect === "none", x.id);
    assert.equal(new Set(CALIBRATION.map((x) => x.id)).size, CALIBRATION.length);
  });

  test("the prompt holds the words, the reference and what Kiko typed", () => {
    const x = CALIBRATION[1];
    const p = judgePrompt({ moment: x.moment, reference: x.reference, did: x.did });
    assert.match(p, /<user_said>Ask MintBox, what do I have/);
    assert.match(p, /"idealMessages"/);
    assert.match(p, /send → mintbox \(terminal\): "Ask MintBox, what do I have/);
    assert.match(judgePrompt({ moment: x.moment, reference: null, did: [] }), /work out what should have happened yourself[\s\S]*- nothing/);
  });
});
