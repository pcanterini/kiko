// Replies that only wrap things up ("no thanks", "that's all, thank you"). Sending one to a session
// would start another turn, which would be summarized and asked about again, so they end it instead.
const CLOSERS = [
  "no",
  "nope",
  "nah",
  "thanks",
  "thank you",
  "thanks a lot",
  "thank you so much",
  "that's all",
  "that's it",
  "that's okay",
  "that's ok",
  "that's fine",
  "that's good",
  "i'm good",
  "all good",
  "we're good",
  "never mind",
  "nevermind",
  "nothing",
  "nothing else",
  "not now",
  "bye",
  "i'm done",
  "all done",
  "done for now",
];
// Fine alongside a closer ("okay, thanks"), but not on their own: "okay" alone may mean yes.
const FILLER = ["okay", "ok", "cool", "great", "perfect", "alright", "all right", "sure", "so", "um", "uh", "for now"];

const byLength = (a: string, b: string) => b.length - a.length;
const closers = [...CLOSERS].sort(byLength);
const filler = [...FILLER].sort(byLength);

/** True when the whole reply is closers and filler, with at least one closer. */
export function isClosing(reply: string): boolean {
  let rest = ` ${reply
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
  let closed = false;
  for (let changed = true; changed; ) {
    changed = false;
    for (const phrase of closers) {
      const next = rest.replaceAll(` ${phrase} `, " ");
      if (next !== rest) [rest, closed, changed] = [next, true, true];
    }
    for (const phrase of filler) {
      const next = rest.replaceAll(` ${phrase} `, " ");
      if (next !== rest) [rest, changed] = [next, true];
    }
  }
  return closed && !rest.trim();
}
