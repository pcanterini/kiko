// The pieces the app starts together (src/app/start-parts.ts; app.ts: the mic, the speaker, speech to text,
// Cartesia, Pocket): one that fails is logged and said once, the rest start all the same, and only an error
// that's fatal on purpose (a helper that won't build) stops it, as before. Fakes only: nothing is started.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startParts, type Part } from "../../../src/app/start-parts.ts";

class BuildError extends Error {}

function world() {
  const started: string[] = [];
  const said: string[] = [];
  const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const part = (name: string, start: () => Promise<unknown> | unknown = async () => void started.push(name)): Part => ({
    name,
    start,
    failed: (why) => void said.push(`${name}: ${why}`),
  });
  const deps = { log: (event: string, fields?: Record<string, unknown>) => void logged.push({ event, fields }), fatal: (err: unknown) => err instanceof BuildError };
  return { started, said, logged, part, deps };
}

describe("starting the app's pieces", () => {
  test("all start: nothing said or logged", async () => {
    const w = world();
    assert.deepEqual(await startParts([w.part("mic"), w.part("speaker"), w.part("stt")], w.deps), []);
    assert.deepEqual(w.started, ["mic", "speaker", "stt"]);
    assert.deepEqual(w.said, []);
    assert.deepEqual(w.logged, []);
  });

  test("the mic's helper failing: logged and said once, with why; the rest start", async () => {
    const w = world();
    const failed = await startParts([w.part("mic", () => Promise.reject(new Error("mic helper exited (1)"))), w.part("speaker"), w.part("stt"), w.part("pocket")], w.deps);
    assert.deepEqual(failed, ["mic"]);
    assert.deepEqual(w.started, ["speaker", "stt", "pocket"]);
    assert.deepEqual(w.said, ["mic: mic helper exited (1)"]);
    assert.deepEqual(w.logged, [{ event: "error", fields: { where: "mic_start", message: "mic helper exited (1)" } }]);
  });

  test("a start that throws at once (not a rejection) is caught the same; two failing are both said, in order", async () => {
    const w = world();
    const failed = await startParts(
      [
        w.part("mic", () => {
          throw new Error("no such helper");
        }),
        w.part("speaker", () => Promise.reject("player helper exited (2)")),
        w.part("stt"),
      ],
      w.deps,
    );
    assert.deepEqual(failed, ["mic", "speaker"]);
    assert.deepEqual(w.started, ["stt"]);
    assert.deepEqual(w.said.sort(), ["mic: no such helper", "speaker: player helper exited (2)"]);
  });

  test("fatal on purpose (a helper that won't build): thrown on, nothing said for it", async () => {
    const w = world();
    await assert.rejects(
      startParts(
        [
          w.part("mic", () => {
            throw new BuildError("couldn't build the mic helper");
          }),
          w.part("speaker"),
        ],
        w.deps,
      ),
      BuildError,
    );
    assert.deepEqual(w.said, []);
  });
});
