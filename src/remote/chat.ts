// A session's screen on the phone (the chat), what the hub does for it beyond the history itself
// (server.ts: history_before, session_action, hear): here, a message's words as Hear it again says
// them. What it reads is a session's reply as written, Markdown and all, and every word of it goes
// through the usual speech (and its pronunciation fixes), so what would be read as symbols goes.

/** Read aloud at most: a long reply is cut where a sentence ends, and said to go on. */
const SPOKEN_MAX = 3000;

/**
 * A message as it's said: Markdown's marks out (headings, bold and italics, inline code's ticks,
 * links as their words, list bullets, quotes, rules), a code block or a table said to be there
 * rather than read, and blank lines between paragraphs kept as sentence breaks. "" when nothing's left.
 */
export function spokenMessage(text: string): string {
  const out: string[] = [];
  let fence = false;
  let table = false;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      if (!fence) out.push("(There's a code block here.)");
      fence = !fence;
      continue;
    }
    if (fence) continue;
    // A table: once, for its first row; its separator and other rows aren't read.
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (!table) out.push("(There's a table here.)");
      table = true;
      continue;
    }
    table = false;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    const line = raw
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`+/g, "")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .trim();
    out.push(line);
  }
  // Paragraphs and list items each end as a sentence would, so the voice pauses between them.
  const said = out
    .join("\n")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?:;)]$/.test(l) ? l : `${l}.`))
    .join(" ");
  if (said.length <= SPOKEN_MAX) return said;
  const cut = said.slice(0, SPOKEN_MAX);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return `${end > SPOKEN_MAX / 2 ? cut.slice(0, end + 1) : cut.trimEnd()} The rest is on the screen.`;
}
