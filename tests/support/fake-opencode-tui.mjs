// A fake OpenCode TUI: a process named opencode (run through a link of that name, in a terminal of
// its own: `script`), in its folder, that does what Kiko looks at: it runs, and quits on SIGHUP as
// OpenCode 2.0.32's does (tui/src/app.tsx: its terminal closing puts the screen back and ends it).
// Its sessions are the fake service's (tests/support/fake-opencode.ts), made by the test. What it
// saw goes to FAKE_OPENCODE_LOG, a line each: "started <pid>", "sighup", "sigterm".
import { appendFileSync } from "node:fs";

const note = (line) => {
  if (process.env.FAKE_OPENCODE_LOG) appendFileSync(process.env.FAKE_OPENCODE_LOG, `${line}\n`);
};

note(`started ${process.pid}`);
process.on("SIGHUP", () => {
  note("sighup");
  process.exit(0);
});
process.on("SIGTERM", () => {
  note("sigterm");
  process.exit(143);
});
setInterval(() => {}, 1000);
