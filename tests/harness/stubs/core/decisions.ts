const T = () => (globalThis as any).T;
export function describeTool(name: string) {
  return `use ${name}`;
}
// T.classifierDelayMs: the classifier takes that long (a press can come before the announcement makes a sound).
const classifierDelay = () => (T().classifierDelayMs ? new Promise((r) => setTimeout(r, T().classifierDelayMs)) : null);
export async function decideStop(_: any) {
  await classifierDelay();
  const n = T().needs.shift() ?? 0.8;
  return { worthSaying: 0.9, needsUser: n, costUsd: 0, ms: 1 };
}
// T.guardKind, when a case sets it: the classifier's read of a call the safety gate couldn't place (else none).
export async function decideGuardKind(input: any) {
  await classifierDelay();
  return { kind: T().guardKind?.(input) ?? null, confidence: 0.9, costUsd: 0, ms: 1 };
}
export const GUARD_NONE_SURE = 0.7;
export async function decideRisk(_: any) {
  await classifierDelay();
  return { risky: 0, costUsd: 0, ms: 1 };
}
// T.approval, when a case sets it: the classifier's read of your answer to a permission (else unclear).
export async function decideApproval(input: any) {
  return { answer: "unclear", confidence: 0, ...T().approval?.(input), costUsd: 0, ms: 1 };
}
// T.utteranceDelayMs: the classifier's read of your words takes that long. T.utterance may give appParts (0 otherwise).
export async function decideUtterance(input: any) {
  if (T().utteranceDelayMs) await new Promise((r) => setTimeout(r, T().utteranceDelayMs));
  return { appParts: 0, ...T().utterance(input), model: "stub", costUsd: 0, ms: 1 };
}
// The phone's full tool call (decisions.ts toolDetail): none in the harness, its cap as the real one.
export const DETAIL_MAX = 8000;
export function toolDetail(_name?: string, _input?: Record<string, unknown>): string | null {
  return null;
}
