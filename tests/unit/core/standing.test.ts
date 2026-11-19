// Permission prompts that stand after their voice window (src/core/standing.ts), on a fake clock:
// every one stands, whether or not you're at the Mac (nothing about presence is read), and stays
// until it's answered (card, voice, phone), it's over (its hook gone, answered in its terminal, its
// session moved on), or its hold limit; two at once in one session; shutting down.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type StandSettled, StandingPrompts } from "../../../src/core/standing.ts";
import { FakeClock } from "../../support/clock.ts";

class Req {
  readonly sessionId: string;
  released = 0;
  closed = false;
  answered = false;
  constructor(id: string) {
    this.sessionId = id;
  }
  get open() {
    return !this.closed && !this.answered && this.released === 0;
  }
  release() {
    if (!this.open) return false;
    this.released++;
    return true;
  }
}

const LIMIT = 60_000;

/** A store on a fake clock. */
function setup() {
  const clock = new FakeClock();
  clock.t = 100_000;
  const stood: string[] = [];
  const settled: Array<[string, StandSettled]> = [];
  const logs: Array<{ event: string } & Record<string, unknown>> = [];
  const store = new StandingPrompts<Req>({
    holdLimitMs: LIMIT,
    stood: (r) => stood.push(r.sessionId),
    settled: (r, how) => settled.push([r.sessionId, how]),
    log: (event, fields) => logs.push({ event, ...fields }),
    clock,
  });
  return {
    clock,
    store,
    stood,
    settled,
    logs,
    /** Its window ended now: asked `askedAgo` ms ago, its hook in `heldAgo` ms ago. */
    stand(req: Req, o: { askedAgo?: number; heldAgo?: number } = {}) {
      const now = clock.now();
      store.stand(req, { askedAt: now - (o.askedAgo ?? 20_000), heldSince: now - (o.heldAgo ?? 21_000) });
    },
  };
}

describe("it stands", () => {
  test("as its window runs out, at once, whoever is at the Mac: still held, listed, logged", () => {
    const f = setup();
    const p = new Req("lacy");
    f.stand(p);
    assert.deepEqual(f.stood, ["lacy"]);
    assert.ok(p.open, "its hook still held");
    assert.equal(p.released, 0);
    assert.deepEqual(f.store.list(), [p]);
    const log = f.logs.find((l) => l.event === "permission_stood");
    assert.deepEqual([log?.sinceAskedMs, log?.limitMs], [20_000, LIMIT - 21_000]);
    assert.equal(f.clock.pending(), 1, "only its hold limit: nothing watched");
    assert.ok(!f.logs.some((l) => l.event === "permission_not_stood"));
  });

  test("you're at the Mac all along: nothing lets it go but an answer, its end, or the limit", () => {
    const f = setup();
    const p = new Req("lacy");
    f.stand(p);
    f.clock.advance(LIMIT - 21_000 - 1);
    assert.ok(p.open, "still standing a moment before its limit");
    assert.deepEqual(f.settled, []);
    assert.ok(!f.logs.some((l) => l.event === "permission_released_back"));
  });

  test("once: standing it again, or one already gone, does nothing", () => {
    const f = setup();
    const p = new Req("lacy");
    f.stand(p);
    f.stand(p);
    const q = new Req("lacy");
    q.closed = true;
    f.stand(q);
    assert.deepEqual(f.stood, ["lacy"]);
    assert.deepEqual(f.store.list(), [p]);
  });
});

describe("answered", () => {
  test("on its card: answered late, taken down, never let go", () => {
    const f = setup();
    const p = new Req("lacy");
    f.stand(p);
    f.clock.advance(5000);
    // The card's y: the app answers it through its hook, then tells the store.
    p.answered = true;
    assert.equal(f.store.answered(p, "card"), true);
    assert.equal(p.released, 0, "never let go");
    assert.deepEqual(f.settled, [["lacy", { kind: "answered", how: "card" }]]);
    const late = f.logs.find((l) => l.event === "permission_answered_late");
    assert.deepEqual([late?.how, late?.stoodMs], ["card", 5000]);
    assert.equal(f.clock.pending(), 0, "its limit gone with it");
  });

  test("from the phone, minutes later: answered late, logged with how", () => {
    const f = setup();
    const p = new Req("lacy");
    f.stand(p);
    f.clock.advance(LIMIT - 21_000 - 1000);
    p.answered = true;
    f.store.answered(p, "phone");
    assert.equal(f.logs.find((l) => l.event === "permission_answered_late")?.how, "phone");
    assert.equal(f.clock.pending(), 0);
  });

  test("in its own window while its hook is still held (Claude Code leaves the hook running): taken down, the hook let go", () => {
    const f = setup();
    const p = new Req("lacy");
    f.stand(p);
    assert.equal(f.store.gone(p, "terminal"), true);
    assert.equal(p.released, 1, "the hook let go: nothing more comes through it");
    assert.deepEqual(f.settled, [["lacy", { kind: "gone" }]]);
    assert.equal(f.logs.find((l) => l.event === "permission_stand_gone")?.how, "terminal");
    assert.equal(f.clock.pending(), 0);
    assert.equal(f.store.answered(p, "phone"), false, "a late answer finds nothing");
  });
});

describe("its limits", () => {
  test("the hold limit: let go before the hook's own timeout, counted from when its hook came in", () => {
    const f = setup();
    const p = new Req("lacy");
    f.stand(p, { heldAgo: 21_000 });
    f.clock.advance(LIMIT - 21_000 - 500);
    assert.ok(p.open, "not yet");
    f.clock.advance(500);
    assert.equal(p.released, 1);
    assert.deepEqual(f.settled, [["lacy", { kind: "released", how: "hold_limit" }]]);
    assert.equal(f.logs.find((l) => l.event === "permission_released_back")?.how, "hold_limit");
    assert.deepEqual(f.store.list(), []);
    assert.equal(f.clock.pending(), 0);
  });

  test("its hook went away while it stood (the session interrupted, the hook's own timeout): settled at once, nothing let go", () => {
    const f = setup();
    const p = new Req("lacy");
    f.stand(p);
    p.closed = true;
    assert.deepEqual(f.store.list(), [], "off the cards even before it's told");
    assert.equal(f.store.gone(p), true);
    assert.equal(p.released, 0);
    assert.deepEqual(f.settled, [["lacy", { kind: "gone" }]]);
    assert.equal(f.logs.find((l) => l.event === "permission_stand_gone")?.how, "hook_closed");
    assert.equal(f.clock.pending(), 0, "its limit gone");
    assert.equal(f.store.gone(p), false, "once");
  });

  test("its session moved on (its next Stop) or ended: taken down, its hook let go", () => {
    const f = setup();
    const a = new Req("lacy");
    const b = new Req("rex");
    f.stand(a);
    f.stand(b);
    f.store.gone(a, "turn_ended");
    f.store.gone(b, "session_ended");
    assert.deepEqual([a.released, b.released], [1, 1]);
    assert.deepEqual(
      f.logs.filter((l) => l.event === "permission_stand_gone").map((l) => l.how),
      ["turn_ended", "session_ended"],
    );
  });

  test("let go at its limit when its hook was already gone: settled as gone, not as let go", () => {
    const f = setup();
    const p = new Req("lacy");
    f.stand(p);
    p.closed = true; // its close not told yet
    f.clock.advance(LIMIT);
    assert.deepEqual(f.settled, [["lacy", { kind: "gone" }]]);
    assert.equal(f.logs.find((l) => l.event === "permission_released_back")?.gone, true);
  });

  test("a Codex safety-gate ask: stands like any other, you at the Mac or not, until its own hook's limit ends it (280 s, under the hold limit)", () => {
    const f = setup();
    const p = new Req("codex");
    f.stand(p);
    f.clock.advance(30_000);
    assert.ok(p.open, "still standing");
    assert.equal(p.released, 0, "never let go here (letting go denies it)");
    // Its own hook ends it (it denies the call itself): gone.
    p.closed = true;
    f.store.gone(p);
    assert.deepEqual(f.settled, [["codex", { kind: "gone" }]]);
  });
});

describe("several", () => {
  test("two prompts of one session standing at once: listed oldest first, each answered on its own, the other stays", () => {
    const f = setup();
    const first = new Req("lacy");
    const second = new Req("lacy");
    f.stand(second, { heldAgo: 5_000, askedAgo: 4_000 });
    f.stand(first, { heldAgo: 40_000, askedAgo: 30_000 });
    assert.deepEqual(f.stood, ["lacy", "lacy"]);
    assert.deepEqual(f.store.list(), [first, second], "oldest first, by when its hook came in");
    first.answered = true;
    f.store.answered(first, "phone");
    assert.deepEqual(f.store.list(), [second]);
    assert.ok(second.open);
    // Each has its own limit, from its own hook: the second's comes later.
    f.clock.advance(LIMIT - 5_000 - 1);
    assert.ok(second.open);
    f.clock.advance(1);
    assert.equal(second.released, 1);
    assert.equal(first.released, 0);
    assert.deepEqual(f.settled, [
      ["lacy", { kind: "answered", how: "phone" }],
      ["lacy", { kind: "released", how: "hold_limit" }],
    ]);
  });

  test("shutting down lets every one go", () => {
    const f = setup();
    const a = new Req("a");
    const b = new Req("b");
    f.stand(a);
    f.stand(b);
    f.store.releaseAll();
    assert.deepEqual([a.released, b.released], [1, 1]);
    assert.deepEqual(
      f.settled.map(([, how]) => how),
      [
        { kind: "released", how: "shutdown" },
        { kind: "released", how: "shutdown" },
      ],
    );
    assert.equal(f.clock.pending(), 0);
  });
});
