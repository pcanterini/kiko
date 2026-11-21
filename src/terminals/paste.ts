// When words go into a terminal as one bracketed paste rather than typed: the one rule every
// adapter that writes to a terminal follows (tmux, Rex, iTerm; Terminal.app always pastes, Ghostty's
// `input text` is a paste of its own).
//
// Why long words are pasted (2026-11-21): a program reads its terminal at most 1022 bytes at a time
// on macOS (the tty's input queue; measured in a throwaway Rex block and a throwaway tmux server:
// 1100 bytes come as reads of 1022 and 78, 5000 as four of 1022 and one of 912, whoever writes
// them). Typed, a 1158-character dictation reached Claude Code 2.1.327 as two reads, and it kept only
// the second: the last 136 characters were the prompt, the first 1022 lost (logs/ of 2026-11-21,
// reproduced with 2.1.327 in a throwaway Rex: 1100 typed gave 78, 1158 gave 136, two times in
// three). Bracketed, the same reads are one paste between ESC[200~ and ESC[201~, and Claude Code
// took every size whole (800 to 5000, every time). 2.1.330 no longer loses them typed, but a
// session keeps the Claude Code it started with for days. Under LONG_BYTES nothing is cut (one
// read holds it all), and Claude Code shows a paste under 800 characters inline, as typed words.

/** What a program reads of its terminal at once on macOS: longer words reach it in pieces. */
export const TTY_READ_BYTES = 1022;

/** Words of more bytes than this go in as a bracketed paste: well inside one read, so nothing typed is ever in pieces. */
export const LONG_BYTES = 512;

/** Whether `words` are long enough to go in as a bracketed paste. */
export const isLong = (words: string) => Buffer.byteLength(words, "utf8") > LONG_BYTES;

/**
 * Whether `words` go in as one bracketed paste: several lines (typed, each line break would send
 * what came before it), long words (above), or a program that wants every message pasted (Codex:
 * Place.bracketed). `asks`: the program asked for bracketed paste (tmux's and Rex's own look; iTerm
 * can't tell, and pastes anyway): one line that isn't asked for is typed.
 */
export function asPaste(words: string, { asks, always = false }: { asks: boolean; always?: boolean }): boolean {
  if (words.includes("\n")) return true;
  return asks && (always || isLong(words));
}
