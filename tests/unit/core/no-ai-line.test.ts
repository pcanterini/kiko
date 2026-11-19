// A call with neither a key nor a plan (core/model-route.ts NoAiError): its line says why and how to
// get one (core/account/plan-words.ts noAiLine), and the window shows it once a run (ui-store.ts).

import "../../setup.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { type Account } from "../../../src/core/account/account.ts";
import { noAiLine } from "../../../src/core/account/plan-words.ts";
import { ModelCalls, NoAiError } from "../../../src/core/model-route.ts";
import { COMMAND, NAME } from "../../../src/core/name.ts";
import { ui } from "../../../src/core/ui-store.ts";

afterEach(() => {
  process.env.KIKO_PRO = "0";
});

const asAccount = (state: string) => ({ view: () => ({ state }) }) as unknown as Account;
const failing = (account: Account | null) => new ModelCalls({ ownKey: () => undefined, account: () => account, accountActive: () => false });
const why = async (account: Account | null) => {
  try {
    await failing(account).post("chat", {}, { call: "summary" });
  } catch (e) {
    assert.ok(e instanceof NoAiError);
    return e.why;
  }
  assert.fail("the call went through");
};

describe("no key, no plan", () => {
  test("why: accounts closed, signed out, or signed in with no plan", async () => {
    assert.equal(await why(null), "no_accounts");
    assert.equal(await why(asAccount("signed-out")), "signed_out");
    assert.equal(await why(asAccount("signed-in")), "no_plan");
  });

  test("the line says how to go on, never the env var's name; Pro only while it's on sale", () => {
    for (const w of ["no_accounts", "signed_out", "no_plan"] as const) {
      const line = noAiLine(w);
      assert.match(line, new RegExp(`^${NAME}'s AI is off`));
      assert.match(line, new RegExp(`${COMMAND} keys set openrouter, or Settings → Keys`));
      assert.doesNotMatch(line, /OPENROUTER_API_KEY|Pro/);
    }
    assert.match(noAiLine("signed_out"), new RegExp(`Sign in for the free trial \\(${COMMAND} login\\)`));
    process.env.KIKO_PRO = "1";
    assert.match(noAiLine("signed_out"), new RegExp(`the free trial or ${NAME} Pro \\(${COMMAND} login\\)`));
    assert.match(noAiLine("no_plan"), new RegExp(`Get ${NAME} Pro \\(${COMMAND} upgrade\\), or add your own`));
  });

  test("the window shows it once a run, without the call's tag; other errors as ever", () => {
    const errors = () => ui.state.lines.filter((l) => l.kind === "error").map((l) => l.text);
    const before = errors().length;
    ui.error("summary", new NoAiError("signed_out"));
    ui.error("cleanup", new NoAiError("signed_out"));
    ui.error("summary", new Error("boom"));
    const added = errors().slice(before);
    assert.deepEqual(added, [noAiLine("signed_out"), "[summary] boom"]);
  });
});
