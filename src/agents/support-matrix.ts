// Every agent's declaration of what its sessions get (./support.ts, ./<agent>/support.ts), in the
// order of `agents` (./index.ts), and SUPPORT.md drawn from them: a table per group of features,
// ✅ ◐ ⛔ ⬜ — per agent with its reasons as numbered notes, then what isn't built yet for each agent
// (the gaps to work on), what each agent can't do itself, and what's still to check. `pnpm support`
// (scripts/support-doc.ts) writes it; tests/unit/agents/support.test.ts fails while it's out of date.
// Imports no adapter: only their declarations, which import nothing.
import { fileURLToPath } from "node:url";
import { claudeCodeSupport } from "./claude-code/support.ts";
import { codexSupport } from "./codex/support.ts";
import { opencodeSupport } from "./opencode/support.ts";
import { t3codeSupport } from "./t3code/support.ts";
import { type AgentSupport, type Feature, FEATURES, GROUPS, type Status, STATUSES, type Support } from "./support.ts";
import { NAME } from "../core/name.ts";

/** Every agent's, in the order of `agents` (a test checks they match). */
export const SUPPORT: AgentSupport[] = [claudeCodeSupport, codexSupport, opencodeSupport, t3codeSupport];

/** Where the doc goes: the repo's root. */
export const SUPPORT_FILE = fileURLToPath(new URL("../../SUPPORT.md", import.meta.url));

const MARKS: Record<Status, string> = { yes: "✅", partial: "◐", "tool-limit": "⛔", "not-built": "⬜", "n/a": "—" };
const WORDS: Record<Status, string> = { yes: "yes", partial: "partly", "tool-limit": "the agent itself can't (a tool limit)", "not-built": "not built yet", "n/a": "doesn't apply" };

const features = Object.keys(FEATURES) as Feature[];
/** A reason as a sentence. */
const sentence = (why: string) => (/[.!?]$/.test(why) ? why : `${why}.`);
const cell = (s: Support, note: number | null) => `${MARKS[s.status]}${s.unsure ? "?" : ""}${note ? ` ${note}` : ""}`;

/** SUPPORT.md, from `supports`. */
export function supportDoc(supports: AgentSupport[] = SUPPORT): string {
  const out: string[] = [];
  const line = (text = "") => out.push(text);
  line("# What each agent supports");
  line();
  line("<!-- Written by `pnpm support` from src/agents/*/support.ts: change those, then run it. A test fails while this is out of date. -->");
  line();
  line(
    `Every feature ${NAME} has for a session, with Claude Code as the reference, and how each agent's sessions stand on it. Each adapter declares every feature (\`src/agents/<agent>/support.ts\`; the list is \`src/agents/support.ts\`), and a new feature doesn't typecheck until each has. Where it can, a test checks a declaration against the adapter itself (one with \`rename\` can't say renaming isn't built).`,
  );
  line();
  line(
    '**Not verified yet:** every ⬜ / ◐ / ⛔ and every "?" row is our current belief, read from the agents\' source, docs and our fakes, until each is checked against the real tool (start with "To check" below).',
  );
  line();
  line(`${STATUSES.map((s) => `${MARKS[s]} ${WORDS[s]}`).join(" · ")} · ? not checked for sure (see "To check"). A number is a note under its table.`);
  line();
  line(`| | ${STATUSES.map((s) => MARKS[s]).join(" | ")} |`);
  line(`|---|${STATUSES.map(() => ":-:").join("|")}|`);
  for (const a of supports) {
    const count = (s: Status) => features.filter((f) => a.features[f].status === s).length;
    line(`| ${a.name} | ${STATUSES.map(count).join(" | ")} |`);
  }

  let n = 0;
  for (const group of GROUPS) {
    const rows = features.filter((f) => FEATURES[f].group === group);
    const notes: string[] = [];
    line();
    line(`## ${group}`);
    line();
    line(`| Feature | ${supports.map((a) => a.name).join(" | ")} |`);
    line(`|---|${supports.map(() => ":-:").join("|")}|`);
    for (const f of rows) {
      const cells = supports.map((a) => {
        const s = a.features[f];
        if (!s.why) return cell(s, null);
        notes.push(`${++n}. **${a.name} · ${FEATURES[f].label}:** ${sentence(s.why)}`);
        return cell(s, n);
      });
      line(`| ${FEATURES[f].label} | ${cells.join(" | ")} |`);
    }
    if (notes.length) {
      line();
      for (const note of notes) line(note);
    }
  }

  const listOf = (title: string, intro: string, pick: (s: Support) => boolean) => {
    line();
    line(`## ${title}`);
    line();
    line(intro);
    for (const a of supports) {
      const these = features.filter((f) => pick(a.features[f]));
      line();
      line(`**${a.name}**${these.length ? "" : ": none."}`);
      if (!these.length) continue;
      line();
      for (const f of these) line(`- ${FEATURES[f].label}: ${sentence(a.features[f].why ?? "")}`);
    }
  };
  listOf("Not built yet", `What each agent could do and ${NAME} doesn't yet: the gaps to work on, with how.`, (s) => s.status === "not-built");
  listOf("Tool limits", `What the agent itself can't do, so ${NAME} can't either (said, or marked in what a session can do, never worked around).`, (s) => s.status === "tool-limit");
  listOf("To check", "Declarations read from an agent's source or docs, or not known for sure: worth checking with the real agent.", (s) => Boolean(s.unsure));

  line();
  line("## What each feature means");
  line();
  for (const f of features) line(`- **${FEATURES[f].label}:** ${FEATURES[f].about}`);
  return `${out.join("\n")}\n`;
}
