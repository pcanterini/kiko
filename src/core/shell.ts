// Words for a POSIX shell (and zsh). Imports nothing, so anything can use it (hooks/guard.mjs keeps
// its own: the hooks run on their own).

/** Single-quoted for a POSIX shell, always. */
export function shellQuote(text: string) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quoted for a POSIX shell, and zsh, only when it needs to be: a word starting with "=" is quoted
 * too (zsh expands `=pixie` to a command's path: the Terminal.app fallback, show.ts, runs this in
 * the login shell), as is one starting with "%" (a job, to some shells).
 */
export function shellWord(word: string) {
  return /^[A-Za-z0-9_@+:,./-][A-Za-z0-9_@%+=:,./-]*$/.test(word) ? word : shellQuote(word);
}
