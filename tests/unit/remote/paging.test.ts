// A session's screen paged, through a real server and a fake phone over ws (protocol/README.md, "A
// session's screen"): welcome says `paging`; a phone that pages gets a window of the newest turns
// within its budget (ids, long outputs cut, a cursor), earlier pages before a cursor with `next`
// until the start (every item once, in order), only what changed as the transcript grows
// (history_delta), and Show full's rest of a cut item (show_full → full_text). An older phone gets
// the whole history as before, without ids, and never more than LEGACY_BYTES however long the
// session is. Every message checked against the schema both ways.
import "../../setup.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { ui } from "../../../src/core/ui-store.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { BUDGET, LEGACY_BYTES } from "../../../src/remote/history-window.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const session = (name: string) =>
  ({
    sessionId: name,
    cwd: `/code/${name}`,
    givenName: name,
    kind: "interactive",
    status: "idle",
    desktop: false,
    place: { via: "tmux", id: `%${name}`, keys: true, pid: 1 },
    mapping: "none",
    nameSetBy: "user",
  }) as unknown as Session;

const projects = join(process.cwd(), "paging-projects");
process.env.KIKO_CLAUDE_PROJECTS = projects;
const when = (i: number) => new Date(Date.UTC(2026, 9, 28, 14, 0, 0) + i * 1000).toISOString();
const file = (name: string) => join(projects, `/code/${name}`.replace(/[^a-zA-Z0-9]/g, "-"), `${name}.jsonl`);
const lines = (entries: object[]) => entries.map((l) => `${JSON.stringify(l)}\n`).join("");
function transcript(name: string, entries: object[]) {
  mkdirSync(join(file(name), ".."), { recursive: true });
  writeFileSync(file(name), lines(entries));
}

const you = (text: string, i: number) => ({ type: "user", timestamp: when(i), message: { role: "user", content: text } });
const said = (text: string, i: number) => ({ type: "assistant", timestamp: when(i), message: { content: [{ type: "text", text }] } });
const use = (id: string, command: string, i: number) => ({ type: "assistant", timestamp: when(i), message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const result = (id: string, content: string, i: number) => ({
  type: "user",
  timestamp: when(i),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] },
});
const output = (lines: number, tag: string) => Array.from({ length: lines }, (_, l) => `${tag} output line ${l} ${"·".repeat(60)}`).join("\n");

/** A long session: `turns` turns, each your words, a command with 40 lines of output, and a long reply. */
const long = (turns: number) =>
  Array.from({ length: turns }, (_, t) => [
    you(`turn ${t}`, t * 10),
    use(`b${t}`, `pnpm test ${t}`, t * 10 + 1),
    result(`b${t}`, output(40, `t${t}`), t * 10 + 2),
    said(`Reply ${t}. ${"r".repeat(3000)}`, t * 10 + 3),
  ]).flat();

describe("a session's screen paged, through a real server", () => {
  const hub = {
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
  } as unknown as PhoneHub;
  const pairing = new Pairing(join(process.cwd(), "phones-paging.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network });
  let ws: LocalPhone;
  const got: any[] = [];
  const sizes: number[] = [];
  const send = (m: object) => {
    const message = { v: 1, ...m };
    assert.equal(invalid(message, "phone"), null, JSON.stringify(message));
    ws.send(JSON.stringify(message));
  };
  async function next(type: string, from = 0, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      const m = got.slice(from).find((x) => x.type === type);
      if (m) return m;
      if (Date.now() > end) throw new Error(`no ${type} in ${ms}ms: ${got.slice(from).map((x) => x.type)}`);
      await wait(10);
    }
  }
  const bytesOf = (m: object) => sizes[got.indexOf(m)];

  before(async () => {
    transcript("long", long(200));
    transcript("live", [you("deploy it", 0), said("Deploying.", 1)]);
    ui.set({ sessions: [session("long"), session("live")] });
    const port = await server.start();
    ws = new LocalPhone(`ws://127.0.0.1:${port}`);
    ws.on("message", (data) => {
      const text = String(data);
      const m = JSON.parse(text);
      assert.equal(invalid(m, "hub"), null, text.slice(0, 2000));
      got.push(m);
      sizes.push(Buffer.byteLength(text));
    });
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    await next("sessions");
  });

  after(() => {
    ws.close();
    server.stop();
    ui.set({ sessions: [], permission: null });
  });

  test("welcome says paging", async () => {
    assert.equal((await next("welcome")).paging, true);
  });

  test("a window of the newest turns within 64 KB, ids and a cursor; then pages before it, every item once, to the start", async () => {
    let from = got.length;
    send({ type: "watch", sessionId: "long", paged: true });
    const window = await next("history", from);
    assert.ok(bytesOf(window) <= BUDGET.bytes + 300, `the window is ${bytesOf(window)} bytes`);
    assert.equal(window.truncated, true);
    assert.equal(window.cursor, window.items[0].id);
    assert.equal(window.items[0].kind, "you", "from a turn's start");
    assert.equal(window.items.at(-1).text.slice(0, 10), "Reply 199.");
    const run = window.items.find((i: any) => i.kind === "steps").steps[0];
    assert.equal(run.cut, true, "40 lines of output: a preview, Show full for the rest");
    assert.ok(run.detail.split("\n").length <= 9);
    // Pages back to the start.
    const all = [...window.items];
    let cursor = window.cursor;
    let pages = 0;
    while (cursor) {
      from = got.length;
      send({ type: "history_before", sessionId: "long", before: all[0].at, cursor });
      const page = await next("history_page", from);
      pages++;
      assert.equal(page.cursor, cursor);
      assert.ok(bytesOf(page) <= BUDGET.bytes + 400, `a page is ${bytesOf(page)} bytes`);
      assert.ok(page.items.length > 0);
      all.unshift(...page.items);
      cursor = page.more ? page.next : undefined;
      if (page.more) assert.equal(page.next, page.items[0].id);
      assert.ok(pages < 100);
    }
    assert.ok(pages > 3, `${pages} pages`);
    const ids = all.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, "no item twice");
    assert.equal(all.length, 200 * 3);
    assert.deepEqual(
      all.filter((i) => i.kind === "you").map((i) => i.text),
      Array.from({ length: 200 }, (_, t) => `turn ${t}`),
      "every turn, in order",
    );
    send({ type: "watch", sessionId: null });
  });

  test("Show full: a cut output whole (400 lines at most), a cut reply whole; missing for an item that isn't there", async () => {
    let from = got.length;
    send({ type: "watch", sessionId: "long", paged: true });
    const window = await next("history", from);
    const fold = window.items.find((i: any) => i.kind === "steps");
    from = got.length;
    send({ type: "show_full", sessionId: "long", id: fold.id, step: 0 });
    const full = await next("full_text", from);
    assert.deepEqual([full.id, full.step], [fold.id, 0]);
    assert.equal(full.detail.split("\n").length, 40, "every line");
    assert.equal(full.cut, undefined);
    const reply = window.items.find((i: any) => i.kind === "claude" && i.cut);
    from = got.length;
    send({ type: "show_full", sessionId: "long", id: reply.id });
    const text = await next("full_text", from);
    assert.equal(text.text.length, `Reply 199. `.length + 3000);
    from = got.length;
    send({ type: "show_full", sessionId: "long", id: "12345", step: 1 });
    assert.equal((await next("full_text", from)).missing, true);
    send({ type: "watch", sessionId: null });
  });

  test("live: only what changed (history_delta), after the last item still the same", async () => {
    let from = got.length;
    send({ type: "watch", sessionId: "live", paged: true });
    const window = await next("history", from);
    assert.deepEqual(
      window.items.map((i: any) => i.kind),
      ["you", "claude"],
    );
    assert.equal(window.truncated, false);
    assert.equal(window.cursor, undefined, "nothing before it");
    from = got.length;
    appendFileSync(file("live"), lines([use("d", "pnpm deploy", 2)]));
    const started = await next("history_delta", from);
    assert.equal(started.after, window.items[1].id);
    assert.equal(started.items.length, 1);
    assert.equal(started.items[0].steps[0].running, true);
    assert.equal(started.doing, "Running pnpm deploy");
    assert.ok(bytesOf(started) < 600, `a delta is ${bytesOf(started)} bytes`);
    from = got.length;
    appendFileSync(file("live"), lines([result("d", "Deployed.", 3)]));
    const done = await next("history_delta", from);
    assert.equal(done.after, window.items[1].id, "the fold again, its step done");
    assert.equal(done.items[0].id, started.items[0].id);
    assert.equal(done.items[0].steps[0].detail, "Deployed.");
    assert.equal(done.doing, undefined);
    send({ type: "watch", sessionId: null });
  });

  test("an older phone: the whole history as before, without ids, never more than LEGACY_BYTES; pages by time", async () => {
    transcript(
      "huge",
      Array.from({ length: 60 }, (_, t) => [
        you(`ask ${t}`, t * 100),
        ...Array.from({ length: 40 }, (_, s) => [use(`c${t}-${s}`, `cmd ${s}`, t * 100 + 1), result(`c${t}-${s}`, output(12, `s${s}`), t * 100 + 2)]).flat(),
      ]).flat(),
    );
    ui.set({ sessions: [...ui.state.sessions, session("huge")] });
    let from = got.length;
    send({ type: "watch", sessionId: "huge" });
    const old = await next("history", from);
    assert.ok(bytesOf(old) <= LEGACY_BYTES + 300, `capped: ${bytesOf(old)} bytes`);
    assert.equal(old.truncated, true);
    assert.equal(old.cursor, undefined);
    for (const item of old.items) assert.equal(item.id, undefined, "no ids: as it always had it");
    from = got.length;
    send({ type: "history_before", sessionId: "huge", before: old.items[0].at });
    const page = await next("history_page", from);
    assert.ok(bytesOf(page) <= LEGACY_BYTES + 300);
    assert.equal(page.next, undefined);
    for (const item of page.items) assert.equal(item.id, undefined);
    // The same session to a phone that pages: 64 KB.
    from = got.length;
    send({ type: "watch", sessionId: "huge", paged: true });
    assert.ok(bytesOf(await next("history", from)) <= BUDGET.bytes + 300);
    send({ type: "watch", sessionId: null });
  });
});
