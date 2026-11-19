// Kiko's Terms and Privacy Policy, accepted where you start using it (clickwrap): one line right next
// to the action that accepts them, in the same words everywhere (kiko.sh and account.kiko.sh say
// them too). `kiko setup` says AGREE_LINE once per terms version before its first step, and going on
// past that step is accepting them (kept in the settings: termsAccepted). Signing in (`kiko login`,
// setup's sign-in and trial) says agreeLine("signing in") by the code; buying Kiko Pro says PRO_AGREE
// by the plan's question. When the terms' effective date (TERMS_DATE, TERMS.md's) changes, setup and
// the app's start say once that they changed (termsNotice): a notice, never a question.
import { DOMAIN, NAME } from "./name.ts";

/**
 * The terms' effective date (TERMS.md: "Effective November 4, 2026"), as their version. Changed
 * only when the terms' substance changes: tests/unit/core/terms.test.ts checks it against TERMS.md.
 */
export const TERMS_DATE = "2026-11-04";

/** Where they are, as said in a terminal line. */
export const TERMS_AT = `${DOMAIN}/terms`;
export const PRIVACY_AT = `${DOMAIN}/privacy`;

/** "By signing in, you agree to Kiko's Terms (kiko.sh/terms) and Privacy Policy (kiko.sh/privacy)." */
export const agreeLine = (doing: string) => `By ${doing}, you agree to ${NAME}'s Terms (${TERMS_AT}) and Privacy Policy (${PRIVACY_AT}).`;

/** Setup's line before its first step: going on is accepting them. */
export const AGREE_LINE = agreeLine("continuing");

/** By Kiko Pro's plan question (`kiko upgrade`, setup's Pro): subscribing accepts them, Pro's part included. */
export const PRO_AGREE = `By subscribing, you agree to the Terms, including ${NAME} Pro's: ${TERMS_AT}`;

/** What was accepted, as the settings keep it (termsAccepted): the terms' version and when (ISO time). */
export type TermsAccepted = { version: string; at: string };

/** "4 Nov 2026", for a version (an ISO date). */
const dateOf = (version: string) => new Date(`${version}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "Kiko's Terms changed on 4 Nov 2026: kiko.sh/terms" */
export const changedLine = (version = TERMS_DATE) => `${NAME}'s Terms changed on ${dateOf(version)}: ${TERMS_AT}`;

/** termsAccepted as read from the settings: the record, or null when there's none (or it isn't one). */
export function acceptedOf(raw: unknown): TermsAccepted | null {
  if (!raw || typeof raw !== "object") return null;
  const { version, at } = raw as Record<string, unknown>;
  return typeof version === "string" && typeof at === "string" ? { version, at } : null;
}

/**
 * What to say about the terms, for what was accepted: "new" (never accepted here: setup says
 * AGREE_LINE), "changed" (an older version accepted: changedLine, once), or null (these ones).
 */
export function termsNotice(raw: unknown, current = TERMS_DATE): { kind: "new" | "changed"; line: string } | null {
  const had = acceptedOf(raw);
  if (!had) return { kind: "new", line: AGREE_LINE };
  if (had.version !== current) return { kind: "changed", line: changedLine(current) };
  return null;
}

/** The record kept once they're accepted (now). */
export const acceptedNow = (now = new Date(), version = TERMS_DATE): TermsAccepted => ({ version, at: now.toISOString() });
