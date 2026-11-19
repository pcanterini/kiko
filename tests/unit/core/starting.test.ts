// Sessions the app opened that haven't started yet (src/core/starting.ts): listed as starting under
// an ID of their own, matched to the session their agent lists once it starts (by pane, else by
// folder), needing you past the wait, and ended when their pane says so.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { STARTING, isStarting, type Session } from "../../../src/core/sessions.ts";
import { calledOf, STARTING_GIVE_UP_MS, startingWaitMs, StartingSessions } from "../../../src/core/starting.ts";
import { sessionStatus } from "../../../src/core/ui-store.ts";

const SCRATCH = "/Users/me/Kiko/scratch/2026-10-29-dozer";

/** A session as listSessions() gives it once its agent lists it. */
const listed = (sessionId: string, cwd: string, pane: string | null, extra: Partial<Session> = {}): Session => ({
  sessionId,
  name: "x",
  givenName: "",
  title: "",
  nameSetBy: "claude",
  cwd,
  kind: "interactive",
  status: "idle",
  lastActiveAt: 1,
  desktop: false,
  place: pane ? { via: "tmux", id: pane, keys: true, pid: 4242 } : null,
  mapping: pane ? "process" : "none",
  ...extra,
});

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, pass: (ms: number) => (t += ms) };
}

describe("a session the app opened, until it starts", () => {
  test("listed as starting, by its given name, its pane its place (never typed into: no pid)", () => {
    const s = new StartingSessions();
    const e = s.add({ cwd: SCRATCH, name: "Dozer", via: "tmux", handle: "%12", known: [] });
    const [dozer] = s.sessions();
    assert.ok(isStarting(dozer));
    assert.equal(dozer.sessionId, e.id);
    assert.match(dozer.sessionId, /^starting-[0-9a-f]{8}$/);
    assert.deepEqual([dozer.givenName, dozer.status, dozer.kind], ["Dozer", STARTING, "interactive"]);
    assert.deepEqual(dozer.place, { via: "tmux", id: "%12", keys: false });
    assert.equal(dozer.place?.pid, undefined);
    assert.equal(sessionStatus(dozer, { permission: null, waiting: null }), "starting");
  });

  test("matched by its pane once listed; the ID it had becomes an alias", () => {
    const s = new StartingSessions();
    const e = s.add({ cwd: SCRATCH, name: "Dozer", via: "tmux", handle: "%12", known: [] });
    // Another session in the same folder in another pane isn't it.
    const other = listed("other", SCRATCH, "%9");
    const dozer = listed("real-dozer", SCRATCH, "%12");
    const matched = s.match([other, dozer]);
    assert.deepEqual(
      matched.map((m) => [m.entry.id, m.session.sessionId, m.by]),
      [[e.id, "real-dozer", "pane"]],
    );
    assert.deepEqual(s.sessions(), []);
    assert.deepEqual(s.withAliases([dozer])[0].aliases, [e.id]);
    // Matched once: listed again, nothing new.
    assert.deepEqual(s.match([dozer]), []);
  });

  test("no pane (opened in Ghostty): by its folder, a session there that wasn't listed when it opened", () => {
    const s = new StartingSessions();
    const e = s.add({ cwd: SCRATCH, name: "", via: "ghostty", handle: null, known: ["was-there"] });
    assert.equal(s.sessions()[0].name, "2026-10-29-dozer");
    assert.equal(s.sessions()[0].place, null);
    assert.deepEqual(s.match([listed("was-there", SCRATCH, null)]), []);
    assert.deepEqual(s.match([listed("elsewhere", "/Users/me/git/pixie", null)]), []);
    assert.deepEqual(
      s.match([listed("new", SCRATCH, null)]).map((m) => [m.entry.id, m.by]),
      [[e.id, "folder"]],
    );
  });

  test("two opened in one folder: each its own session", () => {
    const s = new StartingSessions();
    const a = s.add({ cwd: SCRATCH, name: "A", via: "ghostty", known: [] });
    const b = s.add({ cwd: SCRATCH, name: "B", via: "ghostty", known: [] });
    const matched = s.match([listed("one", SCRATCH, null), listed("two", SCRATCH, null)]);
    assert.deepEqual(
      matched.map((m) => [m.entry.id, m.session.sessionId]),
      [
        [a.id, "one"],
        [b.id, "two"],
      ],
    );
  });

  test("past the wait it needs you, once; listed as blocked (needs you)", () => {
    const c = clock();
    const s = new StartingSessions(c.now);
    s.add({ cwd: SCRATCH, name: "Dozer", via: "tmux", handle: "%12", known: [] });
    c.pass(startingWaitMs() - 1);
    assert.deepEqual(s.due(), []);
    c.pass(1);
    assert.equal(s.due().length, 1);
    assert.deepEqual(s.due(), [], "said once");
    const [dozer] = s.sessions();
    assert.equal(dozer.status, "blocked");
    assert.ok(isStarting(dozer), "still one starting");
    assert.equal(sessionStatus(dozer, { permission: null, waiting: null }), "needs_you");
  });

  test("ended: its pane gone; its shell back after its program ran; the shell alone past the wait", () => {
    const c = clock();
    const s = new StartingSessions(c.now);
    const e = s.add({ cwd: SCRATCH, name: "Dozer", via: "tmux", handle: "%12", known: [] });
    // The login shell still starting it (rc files): not ended.
    assert.equal(s.ended(e, "shell"), false);
    assert.equal(s.ended(e, "running"), false);
    // "No, exit" at the trust prompt: the shell is in front again.
    assert.equal(s.ended(e, "shell"), true);
    const f = s.add({ cwd: SCRATCH, name: "Rex", via: "tmux", handle: "%13", known: [] });
    assert.equal(s.ended(f, "gone"), true);
    const g = s.add({ cwd: SCRATCH, name: "Max", via: "tmux", handle: "%14", known: [] });
    c.pass(startingWaitMs());
    assert.equal(s.ended(g, "shell"), true, "never seen running, and the wait is over");
  });

  test("said by its name, else its folder without a scratch folder's date", () => {
    assert.equal(calledOf({ name: "Dozer", cwd: SCRATCH }), "Dozer");
    assert.equal(calledOf({ name: "", cwd: "/x/2026-10-29-look-readme" }), "look readme");
    assert.equal(calledOf({ name: "", cwd: "/x/pixie" }), "pixie");
  });

  test("given up on after a long while", () => {
    const c = clock();
    const s = new StartingSessions(c.now);
    s.add({ cwd: SCRATCH, name: "Dozer", via: "ghostty", known: [] });
    c.pass(STARTING_GIVE_UP_MS);
    assert.equal(s.stale().length, 1);
    assert.deepEqual(s.all(), []);
  });

  test("opened for the trust prompt: kept, but not listed", () => {
    const s = new StartingSessions();
    s.add({ cwd: "/Users/me/Kiko/scratch", name: "", via: "tmux", handle: "%15", known: [], purpose: "trust" });
    assert.equal(s.all().length, 1);
    assert.deepEqual(s.sessions(), []);
  });
});
