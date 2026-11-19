// Whether Kiko's Rex block is on screen, for the Mac overlay (src/terminals/rex/focus.ts), on fakes:
// no rex or ps is run. Kiko's block is the one Kiko's tmux client runs under (its ancestry, from
// ps's pids); shown when it's drawn in the active window of the session the Rex app shows, whichever
// block of it has the focus (the "visible" rule, the user's, 2026-11-05); not shown in another tab,
// behind another block's zoom or in a minimized layer; not known when Rex can't tell. Shaped as the
// real one answered (2026-11-06: Kiko Dev's tmux client 41259 under kiko-dev, in block …f1d7, one
// of four in the tab shown, the focus in …a635; Rex's server 6406).
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ancestry, FOCUS, type FocusAnswer, focusFrom, parents, parseFocus, rexFocuser, type RexFocusDeps, type Shown } from "../../../src/terminals/rex/focus.ts";

const S1 = "session:01a1ae00-b1c7-7cec-9baf-9cb5300d11b4";
const S2 = "session:01a1ae00-b1c7-7cec-9baf-9cb5300d11b5";
const TAB = "window:01a1ae00-e4e2-7700-a8e7-a17676188591";
const KIKO = "block:01a1ae01-292d-7586-9ff5-960e6775f1d7";
const OTHER = "block:01a1ae00-e4c4-7864-9b47-fab3c6caa635";
const THIRD = "block:01a1ae1f-805d-7acd-ad5c-643ea6bcd492";
const APP = "client:01a1ae02-cede-7196-9442-0e9341d751cf";

/** ps -A -o pid=,ppid=: launchd, Rex's server, Kiko's block (zsh 6415 → zsh 6420 → kiko-dev 26763 → tmux client 26791), another block (6418 → 6419 → claude 7569). */
const PS = ["    1     0", " 6406     1", " 6415  6406", " 6420  6415", "26763  6420", "26791 26763", " 6418  6406", " 6419  6418", " 7569  6419", "26778 26775"].join("\n");
const CHAIN = ancestry([26791], parents(PS));

const kikoBlock = { block: KIKO, pids: [26763, 6420, 6415, 6415] };
const otherBlock = { block: OTHER, pids: [7569, 6419, 6418, 6418] };
const thirdBlock = { block: THIRD, pids: [9001, 9000] };
/** The tab shown: Kiko's block and two others, the focus in `focused`. */
const tab = (focused: string, ...blocks: Shown["blocks"]): Shown => ({ session: S1, window: TAB, focused, blocks: blocks.length ? blocks : [otherBlock, thirdBlock, kikoBlock] });
/** Another tab shown: Kiko's block isn't in it. */
const otherTab: Shown = { session: S1, window: "window:01a1ae00-b1df-73ef-9440-3d5a9b89d13d", focused: OTHER, blocks: [otherBlock] };
const answer = (...sessions: Shown[]): FocusAnswer => ({ server: 6406, clients: [{ client: APP, sessions }] });

describe("Rex: Kiko's block on screen, by its tmux client's ancestry", () => {
  test("ps's pids to each one's parent, and a client's ancestry up to launchd", () => {
    assert.equal(parents(PS).get(26791), 26763);
    assert.deepEqual(CHAIN, [26791, 26763, 6420, 6415, 6406]);
  });

  test("Kiko's block shown while another block of the tab has the focus (the user's four panes): shown", () => {
    assert.deepEqual(focusFrom(answer(tab(OTHER)), CHAIN), { kikoFocused: true, why: "Kiko's block shown, another block focused", block: KIKO });
  });

  test("Kiko's block shown and focused: shown", () => {
    assert.deepEqual(focusFrom(answer(tab(KIKO)), CHAIN), { kikoFocused: true, why: "Kiko's block shown, focused", block: KIKO });
  });

  test("Kiko's block in another tab (not in the window shown): not shown", () => {
    assert.deepEqual(focusFrom(answer(otherTab), CHAIN), { kikoFocused: false, why: "Kiko's block not in the shown window" });
  });

  test("another block zoomed over Kiko's tab: not shown; Kiko's own zoomed: shown", () => {
    const zoomedOther = { ...tab(OTHER, { ...otherBlock }, { ...kikoBlock, hidden: "zoomed" }), zoomed: OTHER };
    assert.deepEqual(focusFrom(answer(zoomedOther), CHAIN), { kikoFocused: false, why: "another block zoomed", block: KIKO });
    const zoomedKiko = { ...tab(KIKO, { ...otherBlock, hidden: "zoomed" }, kikoBlock), zoomed: KIKO };
    assert.equal(focusFrom(answer(zoomedKiko), CHAIN).kikoFocused, true);
  });

  test("Kiko's block in a minimized floating layer: not shown", () => {
    assert.deepEqual(focusFrom(answer(tab(OTHER, otherBlock, { ...kikoBlock, hidden: "minimized" })), CHAIN), { kikoFocused: false, why: "Kiko's block minimized", block: KIKO });
  });

  test("Kiko's client isn't under Rex's server (its window in Ghostty): not known, tmux's flag goes", () => {
    const ghostty = ancestry([26791], parents(PS.replace(" 6415  6406", " 6415   999")));
    assert.equal(focusFrom(answer(tab(OTHER)), ghostty).kikoFocused, null);
    assert.equal(focusFrom({ clients: answer(tab(KIKO)).clients }, CHAIN).kikoFocused, null, "no server pid");
  });

  test("Rex's server pid alone (every block's ancestor) never makes a block Kiko's", () => {
    assert.equal(focusFrom(answer(tab(OTHER, { block: OTHER, pids: [7569, 6406, 1] })), CHAIN).kikoFocused, false);
  });

  test("no Rex app showing a session, or no answer: not known", () => {
    assert.equal(focusFrom({ server: 6406, clients: [] }, CHAIN).kikoFocused, null);
    assert.equal(focusFrom({ server: 6406, clients: [{ client: APP, sessions: [] }] }, CHAIN).kikoFocused, null);
    assert.equal(focusFrom(null, CHAIN).kikoFocused, null);
  });

  test("an app attached to several sessions: Kiko's block shown in one is not known (which it shows isn't said); in none, not shown", () => {
    assert.equal(focusFrom(answer(tab(OTHER), { ...otherTab, session: S2 }), CHAIN).kikoFocused, null);
    assert.equal(focusFrom(answer(otherTab, { ...otherTab, session: S2 }), CHAIN).kikoFocused, false);
  });

  test("two Rex apps that disagree: not known", () => {
    const two: FocusAnswer = { server: 6406, clients: [...answer(tab(OTHER)).clients, { client: "client:2", sessions: [otherTab] }] };
    assert.equal(focusFrom(two, CHAIN).kikoFocused, null);
  });

  test("the answer read whatever fields it has (Lua's empty table as {})", () => {
    assert.deepEqual(
      parseFocus(
        JSON.stringify({
          server: 6406,
          clients: [
            { client: APP, sessions: [{ session: S1, window: TAB, focused: OTHER, blocks: [{ block: KIKO, pids: [26763, "x", -1] }, { block: OTHER, pids: {}, hidden: "zoomed" }, { pids: [1] }] }] },
          ],
        }),
      ),
      {
        server: 6406,
        clients: [
          {
            client: APP,
            sessions: [
              {
                session: S1,
                window: TAB,
                focused: OTHER,
                blocks: [
                  { block: KIKO, pids: [26763] },
                  { block: OTHER, pids: [], hidden: "zoomed" },
                ],
              },
            ],
          },
        ],
      },
    );
    assert.deepEqual(parseFocus(JSON.stringify({ clients: [{ sessions: [{ session: S1, blocks: {} }] }] })), { clients: [{ client: "", sessions: [{ session: S1, blocks: [] }] }] });
    assert.equal(parseFocus("not json"), null);
  });

  test("the script only looks: no input, focus, zoom, resize or close of any block, window or client", () => {
    for (const call of FOCUS.matchAll(/rex\.call\("([^"]+)"/g)) assert.ok(["session.attach_all", "server.status", "client.list", "session.view", "block.method"].includes(call[1]), call[1]);
    for (const method of FOCUS.matchAll(/method = "([^"]+)"/g)) assert.equal(method[1], "process");
  });
});

describe("Rex, asked: one rex call a poll", () => {
  const deps = (over: Partial<RexFocusDeps> = {}) => {
    const calls = { ask: 0, ps: 0 };
    const d: RexFocusDeps = {
      ready: () => true,
      ask: async () => (calls.ask++, JSON.stringify(answer(tab(OTHER)))),
      ps: async () => (calls.ps++, PS),
      ...over,
    };
    return { d, calls };
  };

  test("Kiko's block shown, another focused: shown; one rex call each poll, ps once for the client", async () => {
    const { d, calls } = deps();
    const ask = rexFocuser(d);
    assert.equal((await ask([26791])).kikoFocused, true);
    assert.equal((await ask([26791])).kikoFocused, true);
    assert.deepEqual(calls, { ask: 2, ps: 1 });
  });

  test("another tab in front: not shown", async () => {
    const { d } = deps({ ask: async () => JSON.stringify(answer(otherTab)) });
    assert.deepEqual(await rexFocuser(d)([26791]), { kikoFocused: false, why: "Kiko's block not in the shown window" });
  });

  test("Rex unreachable (its server gone, rex failing, ps failing): not known, never thrown", async () => {
    assert.equal((await rexFocuser(deps({ ask: async () => Promise.reject(new Error("dial unix: no such file\nmore")) }).d)([26791])).why, "Rex: dial unix: no such file");
    assert.equal((await rexFocuser(deps({ ps: async () => Promise.reject(new Error("ps")) }).d)([26791])).kikoFocused, null);
    assert.equal((await rexFocuser(deps({ ask: async () => "garbage" }).d)([26791])).kikoFocused, null);
    const { d, calls } = deps({ ready: () => false });
    assert.deepEqual(await rexFocuser(d)([26791]), { kikoFocused: null, why: "Rex isn't running" });
    assert.deepEqual(calls, { ask: 0, ps: 0 }, "nothing run");
  });

  test("Kiko's client not in Rex: asked once, then not again until the clients change", async () => {
    const { d, calls } = deps({ ps: async () => PS.replace(" 6415  6406", " 6415   999") });
    const ask = rexFocuser(d);
    for (let i = 0; i < 3; i++) assert.equal((await ask([26791])).kikoFocused, null);
    assert.equal(calls.ask, 1);
    await ask([26792]);
    assert.equal(calls.ask, 2, "a new client: asked again");
  });

  test("no tmux client: nothing asked", async () => {
    const { d, calls } = deps();
    assert.equal((await rexFocuser(d)([])).kikoFocused, null);
    assert.deepEqual(calls, { ask: 0, ps: 0 });
  });
});
