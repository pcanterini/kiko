// An agent's version, compared: what each adapter's setup and health read off the program they
// were checked against (Codex's CODEX_CHECKED, OpenCode's service from 2.0).

/** Whether version `a` ("0.170.1") is newer than `b`, by its numbers. */
export function newerThan(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}
