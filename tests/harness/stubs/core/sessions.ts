export * from "../../../../src/core/sessions.ts";
import { codex } from "../../../../src/agents/codex/index.ts";
import { opencode } from "../../../../src/agents/opencode/index.ts";
import { t3code } from "../../../../src/agents/t3code/index.ts";
import { findPlaces } from "../../../../src/terminals/index.ts";
// Claude Code's sessions are the case's (T.sessions, placed already); T3 Code's are its fake server's
// (tests/support/fake-t3.ts), and Codex's own listing (its hook's records in out/codex-sessions, and
// the threads its fake daemon has open in out/codex-home: none until a case opens a fake Codex), both
// placed by the real terminal adapters as the app's own listing does.
export async function listSessions() {
  const listings = [t3code.list(), codex.list().then((l) => l.map((s) => ({ ...s, agent: codex.id }))), opencode.list().then((l) => l.map((s) => ({ ...s, agent: opencode.id })))];
  const listed = [];
  for (const listing of listings) {
    const placeOf = await findPlaces(listing);
    listed.push(...(await listing).map(({ titles, ...s }) => ({ ...s, nameSetBy: "user", ...placeOf(s.sessionId) })));
  }
  return [...(globalThis as any).T.sessions, ...listed];
}
