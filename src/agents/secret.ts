// A secret in memory (an agent's token or password: T3 Code's, ./t3code/auth.ts; OpenCode's service's,
// ./opencode/service.ts): kept in a Secret that never prints, logs or turns into JSON as itself, and
// taken out of any text that might quote it back (`redact`).
import { inspect } from "node:util";

const REDACTED = "[redacted]";

/** A value that never shows itself: printed, logged, inspected or turned into JSON, it's "[redacted]". */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  /** The value itself, for the one place that sends it (an Authorization header). */
  reveal() {
    return this.#value;
  }
  toString() {
    return REDACTED;
  }
  toJSON() {
    return REDACTED;
  }
  [inspect.custom]() {
    return REDACTED;
  }
}

/** `text` with every secret in it replaced: for an error that might quote one back. */
export function redact(text: string, ...secrets: Array<Secret | string | null | undefined>) {
  let out = text;
  for (const s of secrets) {
    const v = s instanceof Secret ? s.reveal() : s;
    if (v && v.length >= 4) out = out.split(v).join(REDACTED);
  }
  return out;
}
