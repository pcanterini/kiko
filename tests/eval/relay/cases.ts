// Relay eval cases: what the user said, the sessions open, and where it should go. The question
// each case asks is what arrives there: the words minus the direction ("Ask MintBox,", "tell Bobby
// to"), reported speech made direct ("Tell Bobby to restart the server" → "Restart the server."),
// meaning and every action kept. What exactly should arrive is the reference's (reference.json, built
// by Opus 5.5 with --build-reference, hand-checked); the session it goes to is the case's own.
//
// The first tag is the case's category (CATEGORIES). The cases here are constructed, with neutral
// sessions (Atlas, Harbor, Juniper, Orbit) or a set shaped like a real day's (MintBox, kiko-dev,
// Bobby, Pixie, Rowan). The ones made from the owner's own words ("log") are private: see the end of
// this file.
//
// reply-exact: a session waits for a reply (it just spoke, Kiko read it out), and the words reply to
// it. They go as said: no rewrite, no reframing; only what today's engine already does to them.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SessionSpec } from "../../support/fixtures.ts";
import type { Case } from "../cases.ts";
import type { Split } from "./splits.ts";

export const CATEGORIES = [
  "opening",
  "relayed",
  "aside",
  "must-keep",
  "meaning",
  "content-vs-direction",
  "kiko-words",
  "plain",
  "stt",
  "ambiguous",
  "multi",
  "about-sessions",
  "reply-exact",
  "reply-near-miss",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Where the words should go: a session (by the case's name), several, or nowhere (null: not sent). */
export type Target = string | string[] | null;

export type RelayCase = {
  id: string;
  /** The category first (CATEGORIES), then any others. */
  tags: [Category, ...string[]];
  /** A short human note: what the case checks, and for "log" cases when it was said. */
  note: string;
  sessions: SessionSpec[];
  /** Recent lines, in the routing eval's Timeline.lines format ("you → atlas: …", "app said (about atlas): …"). */
  recent?: string[];
  /** The session waiting for a reply (Kiko just read what it said; the reply window is open). */
  waiting?: string;
  /** Dealt with last. Defaults to where the last "you → x" line went. */
  last?: string;
  say: string;
  to: Target;
  /** Also right: other places it may go (null: asking back, or answering, instead of sending). */
  alsoOk?: Target[];
};

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────
const atlas = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "atlas",
  title: "Checkout flow refactor",
  status: "idle",
  activeAgoS: 90,
  asked: "Split the checkout form into steps.",
  said: "I split the checkout form into three steps: cart, shipping and payment. The tests pass; nothing is committed yet.",
  ...o,
});
const harbor = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "harbor",
  title: "Staging deploy pipeline",
  status: "busy",
  activeAgoS: 30,
  asked: "Deploy the release branch to staging.",
  said: "The staging deploy is running. I'll report when the smoke tests finish.",
  ...o,
});
const juniper = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "juniper",
  title: "iOS onboarding screens",
  status: "idle",
  activeAgoS: 300,
  asked: "Build the three onboarding screens.",
  said: "The onboarding screens are done and run in the simulator. Want me to test them on a device?",
  ...o,
});
const orbit = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "orbit",
  title: "Billing webhooks",
  status: "idle",
  activeAgoS: 1200,
  codex: true,
  asked: "Handle the invoice webhooks.",
  said: "The invoice.paid and invoice.failed handlers are in, with tests. Refunds aren't handled yet.",
  ...o,
});
// A day's set shaped like real use (names, folders and titles as the app lists them).
const mintbox = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "mintbox",
  title: "Mintbox release signing",
  status: "idle",
  activeAgoS: 600,
  asked: "Looks good. Merge it, then delete the branch.",
  said: "I merged it into main and pushed; main has the crash fix now. No new release yet.",
  ...o,
});
const kikoDev = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "kiko-dev",
  folder: "kiko",
  given: "kiko-dev",
  title: "Window title after restart",
  status: "idle",
  activeAgoS: 120,
  asked: "Okay, do it the way you suggested.",
  said: "Today's work is all merged. Restart Kiko Dev to pick it up.",
  ...o,
});
const bobby = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "Bobby",
  folder: "2026-01-20-internal",
  given: "Bobby",
  status: "idle",
  activeAgoS: 900,
  asked: "Check the Synology apps, please.",
  said: "All the Synology apps are running. The backup ran last night and finished without errors.",
  ...o,
});
const pixie = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "pixie",
  title: "Pixie landing page",
  status: "idle",
  activeAgoS: 1500,
  asked: "Make the hero section shorter.",
  said: "The hero is shorter now, and the page builds. The new logo isn't in the repo yet.",
  ...o,
});
const rowan = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "rowan",
  title: "Rowan task lists",
  status: "idle",
  activeAgoS: 2400,
  asked: "What's next on the project?",
  said: "Next is the weekly digest, then the login page.",
  ...o,
});

const NEUTRAL = (): SessionSpec[] => [atlas(), harbor(), juniper(), orbit()];
const REAL = (): SessionSpec[] => [mintbox(), kikoDev(), bobby(), pixie(), rowan()];

type More = Partial<Omit<RelayCase, "id" | "tags" | "say" | "to" | "note">>;
/** A case with the neutral sessions. */
const n = (id: string, tags: RelayCase["tags"], say: string, to: Target, note: string, more: More = {}): RelayCase => ({ id, tags, note, sessions: NEUTRAL(), say, to, ...more });
/** A case with the user's real sessions. */
const r = (id: string, tags: RelayCase["tags"], say: string, to: Target, note: string, more: More = {}): RelayCase => ({ id, tags, note, sessions: REAL(), say, to, ...more });
/** Just talked with `name`: the last words to it and its summary, read out; dealt with last. */
const talking = (name: string, asked: string, said: string): More => ({ recent: [`you → ${name}: ${asked}`, `app said (about ${name}): ${said}`], last: name });

export const RELAY_CASES: RelayCase[] = [
  n("open-ask-atlas-comma", ["opening"], "Ask Atlas, why does the checkout test fail on the second step?", "atlas", "'Ask X,' then a direct question: the question alone arrives."),
  n("open-to-harbor-colon", ["opening"], "To Harbor: pause the staging deploy until I say so.", "harbor", "'To X:' opening; 'until I say so' must stay."),
  n("open-hey-juniper", ["opening"], "Hey Juniper, run the onboarding screens on my iPhone 17 instead of the simulator.", "juniper", "'Hey X,' opening; 'instead of the simulator' kept."),
  r("open-for-pixie", ["opening"], "For Pixie, the hero image should be 1440 pixels wide, not 1200.", "pixie", "'For X,' opening; both numbers and the 'not' kept."),
  n("open-for-atlas-colon", ["opening"], "For Atlas: rename the CheckoutStep component to PaymentStep.", "atlas", "'For X:' opening; identifiers kept as said."),
  n("open-bare-name", ["opening"], "Atlas, what's left on the checkout refactor?", "atlas", "Bare vocative up front."),
  n("open-okay-name", ["opening"], "Okay Harbor, roll back the last deploy.", "harbor", "'Okay X,' opening."),
  n("open-name-sentence", ["opening"], "Juniper. Add a skip button to the second onboarding screen.", "juniper", "The name as its own sentence."),
  n("open-ask-no-comma", ["opening"], "Ask Orbit what happens when a webhook arrives twice.", "orbit", "'Ask X what …' with no comma: reported question, made direct."),
  r("open-to-pixie-period", ["opening"], "To Pixie. Can you make the footer links gray?", "pixie", "'To X.' as a sentence of its own."),
  n("open-question-for", ["opening"], "Question for Atlas: is the coupon field still on the first step?", "atlas", "'Question for X:' opening."),
  n("open-message-for", ["opening"], "Message for Harbor: the database migration finished, you can continue the deploy.", "harbor", "'Message for X:' opening."),
  r("open-ask-bobby-backup", ["opening", "must-keep"], "Ask Bobby, does the Synology backup still run at 3 a.m.?", "Bobby", "'Ask X,' with a direct question holding a time."),
  r("open-to-mintbox-uh", ["opening"], "To MintBox, uh, did the crash fix go out in the last release?", "mintbox", "'To X, uh,' opening."),
  n("open-ask-colon", ["opening"], "Ask Juniper: which iOS version is the minimum now?", "juniper", "'Ask X:' opening."),
  n("open-tell-comma", ["opening"], "Tell Atlas, the tests are green on my machine.", "atlas", "'Tell X,' then a statement for it."),
  n("open-quick-one", ["opening", "must-keep"], "Orbit, quick one: is the retry delay 30 seconds or 60?", "orbit", "Vocative plus 'quick one:'; both numbers kept."),
  r("open-ask-pixie-route", ["opening"], "Ask Pixie, does the contact form still use the old API route?", "pixie", "'Ask X,' with a yes/no question."),

  // ── Relayed instructions: reported speech, made direct ───────────────────────────────────
  r("rel-tell-bobby-restart", ["relayed"], "Tell Bobby to restart the server.", "Bobby", "The user's own example: 'Restart the server.'"),
  n("rel-tell-run-suite", ["relayed"], "Tell Atlas to run the full test suite before committing.", "atlas", "'Tell X to …': 'before committing' kept."),
  r("rel-ask-whether", ["relayed"], "Ask MintBox whether the notarization went through.", "mintbox", "'Ask X whether …' becomes a direct question."),
  r("rel-check-with-if", ["relayed"], "Check with Pixie if the new logo is in the repo yet.", "pixie", "'Check with X if …'."),
  n("rel-tell-hold-off", ["relayed"], "Tell Harbor to hold off on the deploy.", "harbor", "Short instruction."),
  n(
    "rel-ask-to-screens",
    ["relayed", "must-keep"],
    "Ask Juniper to take a screenshot of each onboarding screen and save them to the Desktop.",
    "juniper",
    "'Ask X to …' is an instruction; both actions kept.",
  ),
  n("rel-can-you-ask-if", ["relayed"], "Can you ask Atlas if it already pushed the branch?", "atlas", "'Can you ask X if …' (to Kiko) becomes the question itself."),
  r("rel-tell-i-tested", ["relayed"], "Tell Kikodev I tested the overlay and it works now.", "kiko-dev", "'Tell X I …': the user's statement, kept in the first person."),
  n("rel-ask-how-plans", ["relayed"], "Ask Orbit how it plans to handle refunds.", "orbit", "'Ask X how it …': 'it' becomes 'you'."),
  n("rel-let-know", ["relayed"], "Let Harbor know the DNS change is live.", "harbor", "'Let X know …'."),
  n("rel-have-add", ["relayed"], "Have Juniper add dark mode support to the welcome screen.", "juniper", "'Have X do …'."),
  r("rel-ask-needs-from-me", ["relayed"], "Ask Bobby what it needs from me to finish the backup setup.", "Bobby", "'what it needs from me' becomes 'what do you need from me'."),
  n("rel-tell-can-merge", ["relayed", "meaning"], "Tell Atlas it can merge once CI passes.", "atlas", "A permission with a condition."),
  n("rel-could-you-ask-what", ["relayed"], "Could you ask Juniper what the test coverage is now?", "juniper", "Polite wrapper to Kiko."),
  n("rel-tell-test-mode", ["relayed"], "Please tell Orbit to use the test mode for every webhook in the integration tests.", "orbit", "'Please tell X to …'."),

  // ── Asides: the direction in the middle or at the end ────────────────────────────────────
  n("aside-mid-this-is-for", ["aside"], "Can you check why the checkout total is off by a cent, this is for Atlas, I think it's rounding.", "atlas", "Mid aside 'this is for Atlas'."),
  n("aside-end-send-that", ["aside"], "Pause the deploy for now, send that to Harbor.", "harbor", "End aside 'send that to Harbor'."),
  n(
    "aside-end-thats-for",
    ["aside", "must-keep"],
    "The second onboarding screen has a typo in the title, it says welcom. That's for Juniper.",
    "juniper",
    "End sentence 'That's for Juniper.'; the misspelling 'welcom' kept.",
  ),
  n("aside-end-for-x", ["aside"], "What's the retry limit on webhooks? For Orbit.", "orbit", "End fragment 'For Orbit.'"),
  r("aside-mid-this-ones-for", ["aside", "stt"], "Restart the dev server and, uh, this one's for Pixie, clear the cache first.", "pixie", "Mid aside; 'clear the cache first' and the order kept."),
  r(
    "aside-end-thats-for-kikodev",
    ["aside"],
    "I can still see the overlay when Rex Beta is focused. That's for Kikodev.",
    "kiko-dev",
    "'Rex Beta' is content (another app), the end sentence is direction.",
  ),
  r("aside-mid-vocative", ["aside"], "Check the backup logs from last night, Bobby, and tell me if anything failed.", "Bobby", "A vocative in the middle."),
  n(
    "aside-for-the-session",
    ["aside", "stt"],
    "Add a loading spinner to the pay button, uh, for the Atlas session, and disable it while it's loading.",
    "atlas",
    "'for the Atlas session' mid-sentence; both actions kept.",
  ),
  n("aside-thats-yours", ["aside"], "The build is failing on main. Harbor, that one's yours.", "harbor", "'Harbor, that one's yours.' at the end."),
  n("aside-i-mean", ["aside"], "Juniper, I mean, the onboarding one, should use the system font everywhere.", "juniper", "Name, then a self-clarifying aside, then the request."),
  n("aside-send-it-to", ["aside"], "Write a migration for the new refunds table, send it to Orbit.", "orbit", "End 'send it to Orbit'."),
  n("aside-by-the-way", ["aside"], "Can you show me the diff, this is for Atlas by the way.", "atlas", "'this is for Atlas by the way' at the end."),
  r("aside-to-x-end", ["aside"], "Make the header sticky. To Pixie.", "pixie", "'To Pixie.' at the end."),
  n("aside-send-this-colon", ["aside"], "Send this to Juniper: the App Store screenshots need the new tagline.", "juniper", "'Send this to X:' up front."),

  // ── Must-keep details: paths, numbers, versions, branches, commands, quotes, identifiers ─
  n("keep-path-numbers", ["must-keep"], "Ask Atlas to change the timeout in src/checkout/config.ts from 30 to 45 seconds.", "atlas", "Path and both numbers."),
  n("keep-version-not", ["must-keep", "meaning"], "Tell Harbor to deploy v2.14.3 to staging, not production.", "harbor", "Version and 'not production'."),
  n("keep-identifier-event", ["must-keep"], "Ask Orbit why handleWebhook throws on the invoice.paid event.", "orbit", "Function name and event name."),
  n("keep-branches", ["must-keep"], "Tell Juniper to branch off release/1.8 and call the branch fix/onboarding-skip.", "juniper", "Two branch names."),
  n("keep-command", ["must-keep"], "Ask Atlas to run pnpm test --filter checkout and paste the output.", "atlas", "A command with a flag."),
  r("keep-quoted", ["must-keep"], 'Tell Pixie the headline should read exactly: "Plan your week in five minutes."', "pixie", "Quoted text, exactly."),
  n("keep-ports", ["must-keep"], "Ask Harbor whether port 5432 or 6543 is open on the staging box.", "harbor", "Two port numbers."),
  r("keep-versions-not", ["must-keep", "meaning"], "Tell Kikodev the version should be 0.3.2, not 0.4.0.", "kiko-dev", "Two versions, one negated."),
  r("keep-home-path-time", ["must-keep"], "Ask MintBox to check ~/Library/Logs/DiagnosticReports for the mintbox-desktop crash from 8:42 pm.", "mintbox", "A path with ~, a process name and a time."),
  n("keep-ios-version", ["must-keep"], "Tell Juniper to set the minimum deployment target to iOS 17.4.", "juniper", "A version."),
  n("keep-ids-list", ["must-keep"], "Ask Orbit to retry the three failed events: evt_101, evt_102 and evt_107.", "orbit", "Three ids."),
  n("keep-commit-hashes", ["must-keep"], "Tell Atlas to revert commit 9b02a4a and keep cf86f4e.", "atlas", "Two hashes, one kept."),
  r("keep-schedule", ["must-keep"], "Ask Bobby to schedule the backup at 2:30 a.m. every Sunday.", "Bobby", "A time and a day."),
  n("keep-env-name", ["must-keep"], "Tell Harbor to set MAX_WORKERS to 8 in the staging config.", "harbor", "A variable name and a number."),
  r("keep-file-format", ["must-keep"], "Ask Pixie to resize hero.png to 1440 by 900 and export it as WebP at 80% quality.", "pixie", "File name, size, format and a percentage."),
  n("keep-line-file", ["must-keep"], "Tell Atlas the bug is on line 212 of CheckoutForm.tsx.", "atlas", "Line number and file."),
  r("keep-git-command", ["must-keep"], "Ask Kikodev to run git log --oneline -5 on the main branch and read it to me.", "kiko-dev", "A command; 'read it to me' kept."),
  n("keep-single-quoted", ["must-keep"], "Tell Juniper the copy for button two is 'Maybe later', with a lowercase l.", "juniper", "Quoted copy and a casing note."),
  n("keep-http-codes", ["must-keep"], "Ask Orbit what the HTTP status is when the signature check fails, 400 or 401?", "orbit", "Two status codes."),
  n("keep-node-version", ["must-keep"], "Tell Harbor to bump the Node version to 24.11 in the Dockerfile and the CI config.", "harbor", "Version and two places."),

  // ── Meaning flippers: negations, limits, conditions, order ───────────────────────────────
  n("mean-not-yet", ["meaning"], "Tell Harbor not to push yet.", "harbor", "'not to push' must stay a negation ('Don't push yet.')."),
  n("mean-dont-change", ["meaning"], "Ask Atlas to look into it, but don't make any changes yet.", "atlas", "'don't make any changes yet' kept."),
  n("mean-only", ["meaning"], "Tell Juniper to only change the second screen.", "juniper", "'only' kept."),
  n("mean-never", ["meaning"], "Tell Orbit to never retry a refund automatically.", "orbit", "'never' kept."),
  n("mean-unless", ["meaning"], "Tell Harbor to deploy unless the smoke tests fail.", "harbor", "'unless' kept."),
  n("mean-if-done-front", ["meaning"], "If it's done, tell Atlas to open a PR.", "atlas", "A condition before the direction: 'If you're done, open a PR.'"),
  r("mean-order", ["meaning"], "Tell Pixie to commit, then push, then deploy to the preview, in that order.", "pixie", "Three steps and their order."),
  n("mean-if-else", ["meaning"], "Ask Juniper to fix the typo and, if the tests pass, merge it; if not, leave it for me.", "juniper", "Both branches of a condition."),
  n("mean-no-instead", ["meaning"], "Tell Atlas no, don't use a modal, use a new page instead.", "atlas", "'no, don't' and 'instead'."),
  n("mean-nothing-else", ["meaning"], "Tell Harbor to skip the migration this time, nothing else.", "harbor", "'skip' and 'nothing else'."),
  n("mean-without", ["meaning"], "Ask Orbit to add logging without changing the response format.", "orbit", "'without' kept."),
  n("mean-except", ["meaning"], "Tell Juniper to keep the old flow, except on iPad.", "juniper", "'except' kept."),
  n("mean-until", ["meaning"], "Ask Atlas to wait until I've tested it before merging.", "atlas", "'until' and 'before'."),
  n("mean-shouldnt", ["meaning"], "Tell Harbor it shouldn't deploy on Fridays.", "harbor", "'shouldn't' kept."),
  r("mean-dont-just", ["meaning"], "Tell Kikodev don't cut a release, just merge to main.", "kiko-dev", "'don't' and 'just'."),
  r("mean-only-and-not", ["meaning"], "Tell Pixie to remove the banner, but only on mobile, and not the cookie notice.", "pixie", "'only on mobile' and 'not the cookie notice'."),
  n("mean-steps-dont-touch", ["meaning"], "Ask Orbit to first write the tests, then the fix, and don't touch the old handler.", "orbit", "Order and a negation."),
  n("mean-its-not", ["meaning"], "Tell Atlas it's not a rounding bug, it's a currency conversion bug.", "atlas", "'not a rounding bug'."),
  n("mean-when-finishes", ["meaning"], "When Harbor finishes the deploy, tell it to run the smoke tests twice.", "harbor", "A condition naming the session, and 'twice'."),
  n("mean-neither-nor", ["meaning"], "Tell Juniper neither the iPad nor the Mac build needs changes.", "juniper", "'neither … nor'."),

  // ── Content versus direction: another session named as content ───────────────────────────
  r("cvd-tell-that-other-fixed", ["content-vs-direction"], "Tell Bobby that MintBox already fixed the cert.", "Bobby", "The user's example: 'MintBox already fixed the cert.' MintBox stays."),
  n("cvd-ask-whether-other", ["content-vs-direction"], "Ask Atlas whether Harbor's deploy broke the checkout.", "atlas", "Harbor is content."),
  n("cvd-tell-that-other-changed", ["content-vs-direction"], "Tell Juniper that Orbit changed the webhook format, so the app needs updating.", "juniper", "Orbit is content."),
  r("cvd-same-colors", ["content-vs-direction"], "Ask Pixie to use the same colors as the Mintbox website.", "pixie", "Mintbox as a product, not the session."),
  n("cvd-deploy-what-merged", ["content-vs-direction"], "Tell Harbor to deploy what Atlas just merged.", "harbor", "Atlas is content."),
  n("cvd-possessive", ["content-vs-direction"], "Ask Orbit if it can tell Atlas's tests apart from its own in CI.", "orbit", "'tell … apart' isn't direction; Atlas is content."),
  n("cvd-ask-me-before", ["content-vs-direction"], "Tell Atlas to ask me before it deletes anything.", "atlas", "'ask me' is content."),
  n("cvd-tell-me-when", ["content-vs-direction"], "Tell Juniper to tell me when it's done.", "juniper", "'tell me' is content."),
  n("cvd-check-with-team", ["content-vs-direction"], "Ask Harbor to check with the database team about the migration window.", "harbor", "'check with the database team' is content."),
  r("cvd-other-will-handle", ["content-vs-direction"], "Tell MintBox that Bobby will handle the SSH config, so it can skip that.", "mintbox", "Bobby is content."),
  r("cvd-copy-ask", ["content-vs-direction", "must-keep"], "Tell Pixie the button copy should say 'ask your agents anything'.", "pixie", "'ask' inside quoted copy."),
  n("cvd-not-to-other", ["content-vs-direction", "meaning"], "Tell Orbit to send the webhook to the staging URL, not to Harbor's preview.", "orbit", "'send … to' is content; Harbor is content."),
  n("cvd-what-other-needs", ["content-vs-direction"], "Ask Atlas what Juniper needs from the checkout API.", "atlas", "Juniper is content."),

  // ── Words for Kiko mixed in ──────────────────────────────────────────────────────────────
  n("kiko-slow-down", ["kiko-words"], "Tell Atlas to run the tests, and Kiko, slow down when you read the results.", "atlas", "The user's example: 'and Kiko, slow down …' is for Kiko."),
  n("kiko-front-ask", ["kiko-words"], "Kiko, ask Harbor if the deploy finished.", "harbor", "Kiko addressed up front."),
  n("kiko-read-summary", ["kiko-words"], "Ask Juniper which screens are done. Kiko, read me just the summary.", "juniper", "A sentence for Kiko at the end."),
  n("kiko-hey-tell", ["kiko-words"], "Hey Kiko, tell Orbit to add idempotency keys.", "orbit", "'Hey Kiko,' then direction."),
  r("kiko-dont-read", ["kiko-words"], "Tell Pixie to make the button bigger, Kiko, you don't need to read back the reply.", "pixie", "A negation for Kiko must not reach Pixie."),
  n("kiko-speak-faster", ["kiko-words"], "Ask Atlas for the diff, and Kiko, speak a bit faster.", "atlas", "'Kiko, speak a bit faster' is for Kiko."),
  r("kiko-send-this-colon", ["kiko-words"], "Kiko, send this to Bobby: the NAS reboot is scheduled for tonight.", "Bobby", "Kiko, then direction, then the message."),
  n("kiko-thanks", ["kiko-words"], "Tell Harbor to roll back. Thanks Kiko.", "harbor", "'Thanks Kiko.' is for Kiko."),
  n("kiko-okay-to", ["kiko-words"], "Okay Kiko, to Juniper: use SF Symbols for the icons.", "juniper", "Kiko, then 'to X:'."),
  r("kiko-ask-kikodev", ["kiko-words"], "Kiko, ask Kikodev what version we're on.", "kiko-dev", "The app's name and a session named after it."),
  n("kiko-mid-hold-on", ["kiko-words"], "Ask Orbit, hold on Kiko, let me think, which events it retries.", "orbit", "Kiko words in the middle."),
  r(
    "kiko-dont-change-content",
    ["kiko-words", "meaning"],
    "Tell Pixie to make the button bigger, Kiko, don't change the colours.",
    "pixie",
    "After Kiko's name, but 'don't change the colours' is most likely Pixie's: it must arrive (2026-11-07).",
  ),
  n(
    "kiko-never-push-content",
    ["kiko-words", "meaning"],
    "Ask Orbit to fix the retry. Kiko, never push to main.",
    "orbit",
    "'never push to main' is about the work, not Kiko: it must arrive (2026-11-07).",
  ),
  n("kiko-dont-read-log", ["kiko-words"], "Tell Atlas to run the migration, and Kiko, don't read the whole log out loud.", "atlas", "A 'don't' about Kiko's own reading out: for Kiko (2026-11-07)."),

  // ── Plain dictation, no direction: arrives untouched ─────────────────────────────────────
  n(
    "plain-second-option",
    ["plain"],
    "Okay, let's go with the second option.",
    "atlas",
    "Talking with Atlas; nothing to drop.",
    talking("atlas", "Give me two options for the coupon field.", "Atlas suggests either keeping the coupon on the cart step or moving it to payment."),
  ),
  n(
    "plain-add-test",
    ["plain"],
    "Can you also add a test for the empty cart case?",
    "atlas",
    "Plain follow-up.",
    talking("atlas", "Add a test for the shipping step.", "Atlas added the shipping step test, and it passes."),
  ),
  n(
    "plain-run-again",
    ["plain"],
    "Run the smoke tests again and tell me what failed.",
    "harbor",
    "'tell me' is content.",
    talking("harbor", "How did the smoke tests go?", "Harbor says two smoke tests failed on staging."),
  ),
  r(
    "plain-blue-not-green",
    ["plain", "meaning"],
    "I think the button should be blue, not green.",
    "pixie",
    "Plain, with a negation.",
    talking("pixie", "What color is the signup button?", "Pixie says the signup button is green now."),
  ),
  n(
    "plain-commit-that",
    ["plain"],
    "Yes, commit that.",
    "atlas",
    "Plain short instruction (not a waiting reply).",
    talking("atlas", "Is the refactor done?", "Atlas says the refactor is done and the tests pass."),
  ),
  n(
    "plain-same-approach",
    ["plain"],
    "Use the same approach for the refund webhook.",
    "orbit",
    "Plain.",
    talking("orbit", "How did you handle duplicate events?", "Orbit stores each event id and skips ones it has seen."),
  ),
  n(
    "plain-why-slower",
    ["plain"],
    "Why is the onboarding slower on the second launch?",
    "juniper",
    "Plain question.",
    talking("juniper", "Measure the onboarding launch time.", "Juniper measured 1.2 seconds on the first launch and 1.9 on the second."),
  ),
  n(
    "plain-no-saved-card",
    ["plain"],
    "Let's also handle the case where the user has no saved card.",
    "atlas",
    "'the user' is content.",
    talking("atlas", "Handle expired cards on the payment step.", "Atlas now shows an error for expired cards."),
  ),
  r(
    "plain-ask-as-content",
    ["plain"],
    "Can you check the Figma export in the assets folder for the exact spacing? Don't ask the designer.",
    "pixie",
    "'ask the designer' is content.",
    talking("pixie", "Fix the spacing on the pricing cards.", "Pixie asks what spacing you want between the pricing cards."),
  ),
  n(
    "plain-tell-me",
    ["plain"],
    "Tell me what you changed in the last commit.",
    "harbor",
    "'Tell me' is content, not direction.",
    talking("harbor", "Fix the deploy script.", "Harbor fixed the deploy script and committed it."),
  ),
  n(
    "plain-ask-me",
    ["plain"],
    "Ask me before you delete any files.",
    "atlas",
    "'Ask me' is content, not direction.",
    talking("atlas", "Clean up the old checkout code.", "Atlas found four old checkout files it could delete."),
  ),
  n(
    "plain-check-with-docs",
    ["plain"],
    "Check with the API docs whether the endpoint supports pagination.",
    "orbit",
    "'Check with the API docs' is content.",
    talking("orbit", "List the invoices endpoint options.", "Orbit listed the invoices endpoint's filters."),
  ),
  n(
    "plain-send-to-staging",
    ["plain"],
    "Send that to staging when you're ready.",
    "harbor",
    "'Send that to staging' is content: staging isn't a session.",
    talking("harbor", "Build the release.", "Harbor built the release; it's ready to deploy."),
  ),
  r(
    "plain-for-the-settings",
    ["plain"],
    "For the settings screen, it's only using part of the window.",
    "kiko-dev",
    "'For the settings screen' is about a screen (trim.ts's own example).",
    talking("kiko-dev", "How does the settings screen look now?", "Kiko-dev redesigned the settings screen with the toggles grouped."),
  ),
  r(
    "plain-this-is-for-page",
    ["plain"],
    "This is for the landing page, not the docs site: make the hero shorter.",
    "pixie",
    "'This is for the landing page' names no session.",
    talking("pixie", "Which pages use the hero?", "Pixie says the landing page and the docs site both use it."),
  ),

  // ── Speech-to-text slips, rambling, fillers ──────────────────────────────────────────────
  r("stt-mint-box-split", ["stt"], "Ask, uh, Mint box, um, whether the, the crash is fixed in the dev build.", "mintbox", "The name split by speech-to-text, fillers and a stutter."),
  r("stt-kiko-death", ["stt"], "Tell, uh, Kiko death, uh, to check the logs.", "kiko-dev", "'Kiko death' misheard for Kiko Dev. Asking back ('Did you mean kiko-dev?') is right too (2026-11-07).", {
    alsoOk: [null],
  }),
  r("stt-bobbie", ["stt"], "Hey Bobbie, can you, um, check the NAS temperature?", "Bobby", "A spelling slip in the name."),
  n("stt-a-atlas", ["stt"], "Ask a Atlas, uh, what's, what's left to do on the, um, checkout thing?", "atlas", "'Ask a Atlas' slip and a stutter."),
  n(
    "stt-rambling-wait",
    ["stt", "meaning"],
    "Uh, so, um, tell Harbor, like, to, uh, wait on the deploy, I guess, until, uh, I check the logs.",
    "harbor",
    "Fillers around a relayed instruction with 'until'.",
  ),
  n(
    "stt-rambling-idea",
    ["stt"],
    "To Juniper. Uh, I was thinking, maybe, uh, the onboarding could, you know, skip the third screen if the user already has an account, uh, what do you think?",
    "juniper",
    "Rambling idea; the condition and the question kept.",
  ),
  n("stt-self-correct", ["stt"], "Ask Orbit, uh, sorry, ask Atlas, what the coupon logic does.", "atlas", "A corrected name: Atlas, and nothing of 'ask Orbit' arrives."),
  r("stt-pixy", ["stt"], "Tell Pixy to, uh, swap the hero image.", "pixie", "'Pixy' for Pixie. Asking back ('Did you mean pixie?') is right too (2026-11-07).", { alsoOk: [null] }),
  n("stt-no-punctuation", ["stt"], "Hey uh Harbor um the uh staging uh thing is down again can you uh look", "harbor", "No punctuation at all."),
  n("stt-broken-sentences", ["stt", "must-keep"], "Ask Atlas. Um. What the. What the total was. Before the discount.", "atlas", "Sentences broken by pauses."),
  n("stt-repeats", ["stt"], "Tell Orbit to to to add the retry, the retry header.", "orbit", "Repeated words."),

  // ── Ambiguous: "ask it", "tell the other one" ────────────────────────────────────────────
  n("amb-ask-it-last", ["ambiguous"], "Ask it if the tests pass.", "atlas", "'it' is the one just talked with.", talking("atlas", "Run the checkout tests.", "Atlas is running the checkout tests.")),
  n("amb-tell-it-last", ["ambiguous"], "Tell it to commit.", "harbor", "'it' is the one just talked with.", talking("harbor", "Fix the deploy script.", "Harbor fixed the deploy script.")),
  n("amb-the-other-one", ["ambiguous"], "Tell the other one to go ahead with the deploy.", "harbor", "Two sessions, Atlas dealt with last: the other is Harbor.", {
    sessions: [atlas(), harbor()],
    ...talking("atlas", "Is checkout ready?", "Atlas says checkout is ready."),
  }),
  n("amb-other-session", ["ambiguous"], "Ask the other session what it's working on.", "juniper", "Two sessions, Atlas dealt with last.", {
    sessions: [atlas(), juniper()],
    ...talking("atlas", "What's left?", "Atlas says only the coupon field is left."),
  }),
  n("amb-ask-it-nobody", ["ambiguous"], "Ask it whether it pushed.", null, "No one dealt with yet: Kiko should ask which session.", { alsoOk: ["atlas", "harbor", "juniper", "orbit"] }),
  r("amb-that-one", ["ambiguous"], "Tell that one to try again.", "pixie", "'that one' is the one just talked with.", talking("pixie", "Deploy the preview.", "Pixie says the preview deploy failed.")),
  n("amb-by-title", ["ambiguous"], "Ask the checkout one if the coupon works.", "atlas", "Named by its title."),
  n("amb-by-title-deploy", ["ambiguous"], "Tell the deploy session to wait.", "harbor", "Named by its title."),
  n("amb-by-title-ios", ["ambiguous"], "Ask the iOS one what the minimum version is.", "juniper", "Named by its title."),
  n("amb-first-one", ["ambiguous"], "Tell the first one to pull main.", null, "Which is first isn't clear: asking back is right.", { alsoOk: ["atlas"] }),
  n("amb-them", ["ambiguous", "multi"], "Ask them if they're done.", null, "'them' with two sessions: both, or ask which.", { sessions: [atlas(), harbor()], alsoOk: [["atlas", "harbor"]] }),
  n("multi-two-named", ["multi"], "Tell Atlas and Harbor to pull main.", ["atlas", "harbor"], "Two named, one message."),
  n("multi-everyone", ["multi"], "Ask everyone to commit their work.", ["atlas", "harbor", "juniper"], "Three sessions, all asked.", { sessions: [atlas(), harbor(), juniper()], alsoOk: [null] }),
  r("multi-split-messages", ["multi"], "Tell Mintbox to add the export button and Pixie to update the screenshots.", ["mintbox", "pixie"], "Two sessions, a different message each."),
  n("multi-same-question", ["multi"], "Ask Atlas and Orbit whether the refund flow uses the same endpoint.", ["atlas", "orbit"], "One question to two."),
  n("multi-both-of-them", ["multi", "must-keep"], "Tell both of them the review moved to 3 p.m.", ["atlas", "harbor"], "'both of them' with two sessions.", { sessions: [atlas(), harbor()] }),
  r("multi-either", ["multi"], "Ask Bobby and Kikodev if either of them changed the SSH config.", ["Bobby", "kiko-dev"], "Two real sessions."),
  n("multi-two-instructions", ["multi", "must-keep"], "Tell Harbor to deploy and tell Atlas to tag the release v3.2.0.", ["harbor", "atlas"], "Two instructions to two sessions."),

  // ── Questions about the sessions themselves: not sent ────────────────────────────────────
  n("about-working-on", ["about-sessions"], "What is Atlas working on?", null, "About a session: Kiko answers from what it knows.", { alsoOk: ["atlas"] }),
  n("about-which-busy", ["about-sessions"], "Which sessions are busy right now?", null, "About the sessions."),
  n("about-still-deploying", ["about-sessions"], "Is Harbor still deploying?", null, "Status Kiko knows.", { alsoOk: ["harbor"] }),
  n("about-what-said", ["about-sessions"], "What did Juniper say about the device test?", null, "What a session said: Kiko repeats it."),
  n("about-how-many", ["about-sessions"], "How many sessions do I have open?", null, "About the sessions."),
  r("about-which-cert", ["about-sessions"], "Which session was working on the certificate?", null, "About the sessions."),
  r("about-did-it-go", ["about-sessions"], "Did my last message go to Bobby?", null, "About Kiko's own sending.", { recent: ["you → Bobby: Check the NAS temperature.", "app said: To Bobby."] }),
  n("about-repeat", ["about-sessions"], "Repeat what Orbit said.", null, "A repeat."),

  // ── Replies to the waiting session: exactly as said ──────────────────────────────────────
  ...replies(),
];

/** The reply-exact cases and their near misses: a session waits for a reply, its question just read out. */
function replies(): RelayCase[] {
  /** `name` waits, having asked `asked` (its summary, read out): its turn done, those its last words. */
  const waits = (name: string, asked: string): More => ({ waiting: name, last: name, recent: [`app said (about ${name}): ${asked}`] });
  const asking = (sessions: SessionSpec[], name: string, asked: string) => sessions.map((s) => (s.name === name ? { ...s, status: "idle" as const, activeAgoS: 5, said: asked } : s));
  const reply = (id: string, sessions: SessionSpec[], name: string, asked: string, say: string, note: string, tags: string[] = []): RelayCase => ({
    id,
    tags: ["reply-exact", ...tags],
    note,
    sessions: asking(sessions, name, asked),
    say,
    to: name,
    ...waits(name, asked),
  });
  const near = (id: string, sessions: SessionSpec[], name: string, asked: string, say: string, to: Target, note: string, more: More = {}): RelayCase => ({
    id,
    tags: ["reply-near-miss"],
    note,
    sessions: asking(sessions, name, asked),
    say,
    to,
    ...waits(name, asked),
    ...more,
  });
  const N = NEUTRAL;
  const R = REAL;
  return [
    reply("reply-yes", N(), "juniper", "Juniper finished the onboarding screens. Want me to test them on a device?", "Yes.", "A bare yes."),
    reply("reply-only-staging", N(), "harbor", "Harbor built the release. Should I deploy it now?", "Go ahead, but only on staging.", "A short answer with a limit."),
    reply("reply-no-dont-push", N(), "atlas", "Atlas committed the refactor. Should I push the branch?", "No, don't push yet.", "A short no with a negation."),
    reply("reply-own-name-juniper", N(), "juniper", "Want me to add a skip button to every screen?", "Juniper, yes, do it.", "Starts with the session's own name: as said."),
    reply("reply-own-name-bobby", R(), "Bobby", "Should I delete the old backup snapshots?", "Bobby, yes do it.", "The user's example: starts with the session's own name."),
    reply("reply-own-name-wait", N(), "harbor", "The smoke tests passed. Deploy to production now?", "Harbor, no. Wait until I'm back.", "Own name, a no and a condition."),
    reply(
      "reply-other-as-content",
      N(),
      "juniper",
      "Should the onboarding use a new layout or an existing pattern?",
      "Do it the way Atlas did the checkout, same pattern.",
      "Another session named as content in a reply.",
      ["content-vs-direction"],
    ),
    reply(
      "reply-details-version",
      N(),
      "harbor",
      "Which version should I deploy?",
      "Use version 2.14.3, the one we tagged yesterday, and keep the old config in config/legacy.yml.",
      "A reply with a version and a path.",
      ["must-keep"],
    ),
    reply(
      "reply-long-details",
      N(),
      "atlas",
      "Do you want the coupon field on step one or step two?",
      "Step two, right after the shipping address. And keep the apply button disabled until the code is at least six characters, and show the error under the field, not in a toast.",
      "A long reply with details and a negation.",
      ["meaning"],
    ),
    reply("reply-option-three", N(), "orbit", "I see three ways to handle duplicate events. Which one should I use?", "Option three.", "A two-word answer."),
    reply("reply-fillers", R(), "pixie", "Pixie can ship the new hero today. Should it go ahead?", "Uh, yeah, sure, um, go for it.", "Fillers in a reply: as said (today's engine may leave them).", [
      "stt",
    ]),
    reply("reply-ask-me-tomorrow", N(), "atlas", "Should I start on the payment step now?", "Not now. Ask me again tomorrow.", "'Ask me' in a reply is content."),
    reply("reply-tell-me-more", N(), "orbit", "There are two retry strategies. Should I pick one?", "Tell me more about the second one first.", "'Tell me' in a reply is content."),
    reply(
      "reply-own-name-details",
      R(),
      "Bobby",
      "Should I delete the old mini key or keep it?",
      "Bobby, delete the old key, the SSH one for the mini, and keep the backup of the config.",
      "Own name up front, then details.",
    ),
    reply(
      "reply-same-as-other",
      R(),
      "kiko-dev",
      "The fix is ready on a branch. Merge it?",
      "Yes, same as MintBox: merge it and then delete the feature branch.",
      "Another session named as content.",
      ["content-vs-direction"],
    ),
    reply(
      "reply-for-others-tests",
      N(),
      "juniper",
      "Should I keep the old onboarding behind a flag?",
      "Keep it. And for Atlas's tests, leave them as they are.",
      "'for Atlas's tests' is content, not direction.",
      ["content-vs-direction"],
    ),
    reply("reply-please-dont", N(), "juniper", "Should I reset the simulator's data?", "Juniper, please don't.", "Own name and a bare negation."),
    reply("reply-force-only-if", N(), "harbor", "The migration is stuck. Should I run it with --force?", "Sure, run it with --force only if the normal run fails.", "A flag, 'only if'.", [
      "must-keep",
      "meaning",
    ]),
    reply("reply-unsure", N(), "atlas", "Should I use a modal or a new page for the coupon?", "Hmm, I'm not sure. What would you recommend?", "A reply that asks back."),
    reply(
      "reply-first-but-only-if",
      N(),
      "juniper",
      "I can either keep the tab bar or move to a sidebar. Which one?",
      "I'd say the first, but only if it doesn't break the iPad layout.",
      "A choice with a condition.",
      ["meaning"],
    ),
    // Not replies, though a session waits.
    near(
      "near-ask-other-cert",
      R(),
      "kiko-dev",
      "Should the overlay hide when Rex Beta is focused?",
      "Ask MintBox about the cert.",
      "mintbox",
      "The user's example: a session waits, the words address another.",
    ),
    near("near-tell-other", N(), "juniper", "Want me to test the screens on a device?", "Tell Atlas to run the tests.", "atlas", "Addresses another session while Juniper waits."),
    near("near-ask-other-whether", N(), "harbor", "Should I deploy now?", "Ask Atlas whether the checkout tests pass.", "atlas", "Another session, while Harbor waits."),
    near("near-time", N(), "juniper", "Want me to test the screens on a device?", "What time is it?", null, "Clearly unrelated: for Kiko, not Juniper."),
    near("near-hey-other", R(), "mintbox", "Should I make a new release now?", "Hey Kikodev, why did the overlay come back?", "kiko-dev", "'Hey X' to another session while MintBox waits."),
    near("near-weather", N(), "orbit", "Should I add refunds next?", "What's the weather in Lisbon?", null, "Clearly unrelated (log 2026-10-26 07:57 shape).", { alsoOk: [] }),
    near("near-name-other", R(), "kiko-dev", "Do you want the phone icon on the left?", "Bobby, check the NAS.", "Bobby", "Another session's name up front while kiko-dev waits."),
  ];
}

/** A relay case as a routing-eval case (cases.ts), for world.ts buildState: the same state the app decides on. */
export function asRoutingCase(c: RelayCase): Case {
  return {
    id: c.id,
    tags: c.tags,
    why: c.note,
    sessions: c.sessions,
    ...(c.recent ? { recent: c.recent } : {}),
    ...(c.waiting ? { waiting: c.waiting } : {}),
    ...(c.last ? { last: c.last } : {}),
    voiceCan: "messages",
    say: c.say,
    expect: [],
  };
}

/** The category of a case: its first tag. */
export const categoryOf = (c: RelayCase): Category => c.tags[0];

// ── Splits (splits.ts): fixed per case; new cases get one with `pnpm eval:relay --assign-splits` ──
export const SPLITS: Record<string, Split> = {
  "open-ask-atlas-comma": "train",
  "open-to-harbor-colon": "validation",
  "open-hey-juniper": "train",
  "open-for-pixie": "validation",
  "open-for-atlas-colon": "train",
  "open-bare-name": "train",
  "open-okay-name": "train",
  "open-name-sentence": "test",
  "open-ask-no-comma": "validation",
  "open-to-pixie-period": "test",
  "open-question-for": "train",
  "open-message-for": "train",
  "open-ask-bobby-backup": "train",
  "open-to-mintbox-uh": "train",
  "open-ask-colon": "test",
  "open-tell-comma": "validation",
  "open-quick-one": "train",
  "open-ask-pixie-route": "train",
  "rel-tell-bobby-restart": "train",
  "rel-tell-run-suite": "train",
  "rel-ask-whether": "train",
  "rel-check-with-if": "train",
  "rel-tell-hold-off": "test",
  "rel-ask-to-screens": "train",
  "rel-can-you-ask-if": "test",
  "rel-tell-i-tested": "train",
  "rel-ask-how-plans": "train",
  "rel-let-know": "validation",
  "rel-have-add": "test",
  "rel-ask-needs-from-me": "train",
  "rel-tell-can-merge": "train",
  "rel-could-you-ask-what": "validation",
  "rel-tell-test-mode": "train",
  "aside-mid-this-is-for": "train",
  "aside-end-send-that": "train",
  "aside-end-thats-for": "test",
  "aside-end-for-x": "train",
  "aside-mid-this-ones-for": "train",
  "aside-end-thats-for-kikodev": "test",
  "aside-mid-vocative": "train",
  "aside-for-the-session": "train",
  "aside-thats-yours": "train",
  "aside-i-mean": "validation",
  "aside-send-it-to": "test",
  "aside-by-the-way": "train",
  "aside-to-x-end": "train",
  "aside-send-this-colon": "validation",
  "keep-path-numbers": "validation",
  "keep-version-not": "train",
  "keep-identifier-event": "train",
  "keep-branches": "test",
  "keep-command": "train",
  "keep-quoted": "train",
  "keep-ports": "test",
  "keep-versions-not": "train",
  "keep-home-path-time": "validation",
  "keep-ios-version": "validation",
  "keep-ids-list": "test",
  "keep-commit-hashes": "test",
  "keep-schedule": "train",
  "keep-env-name": "train",
  "keep-file-format": "train",
  "keep-line-file": "train",
  "keep-git-command": "train",
  "keep-single-quoted": "train",
  "keep-http-codes": "validation",
  "keep-node-version": "train",
  "mean-not-yet": "train",
  "mean-dont-change": "train",
  "mean-only": "train",
  "mean-never": "train",
  "mean-unless": "validation",
  "mean-if-done-front": "train",
  "mean-order": "validation",
  "mean-if-else": "train",
  "mean-no-instead": "validation",
  "mean-nothing-else": "test",
  "mean-without": "train",
  "mean-except": "train",
  "mean-until": "test",
  "mean-shouldnt": "train",
  "mean-dont-just": "validation",
  "mean-only-and-not": "train",
  "mean-steps-dont-touch": "train",
  "mean-its-not": "test",
  "mean-when-finishes": "validation",
  "mean-neither-nor": "train",
  "cvd-tell-that-other-fixed": "train",
  "cvd-ask-whether-other": "train",
  "cvd-tell-that-other-changed": "train",
  "cvd-same-colors": "test",
  "cvd-deploy-what-merged": "train",
  "cvd-possessive": "train",
  "cvd-ask-me-before": "train",
  "cvd-tell-me-when": "validation",
  "cvd-check-with-team": "train",
  "cvd-other-will-handle": "validation",
  "cvd-copy-ask": "train",
  "cvd-not-to-other": "train",
  "cvd-what-other-needs": "test",
  "kiko-slow-down": "validation",
  "kiko-front-ask": "train",
  "kiko-read-summary": "train",
  "kiko-hey-tell": "train",
  "kiko-dont-read": "validation",
  "kiko-speak-faster": "train",
  "kiko-send-this-colon": "train",
  "kiko-thanks": "validation",
  "kiko-okay-to": "test",
  "kiko-ask-kikodev": "train",
  "kiko-mid-hold-on": "train",
  "kiko-dont-change-content": "validation",
  "kiko-never-push-content": "train",
  "kiko-dont-read-log": "train",
  "plain-second-option": "train",
  "plain-add-test": "validation",
  "plain-run-again": "train",
  "plain-blue-not-green": "test",
  "plain-commit-that": "train",
  "plain-same-approach": "train",
  "plain-why-slower": "test",
  "plain-no-saved-card": "test",
  "plain-ask-as-content": "validation",
  "plain-tell-me": "train",
  "plain-ask-me": "train",
  "plain-check-with-docs": "train",
  "plain-send-to-staging": "train",
  "plain-for-the-settings": "train",
  "plain-this-is-for-page": "validation",
  "stt-mint-box-split": "test",
  "stt-kiko-death": "test",
  "stt-bobbie": "train",
  "stt-a-atlas": "train",
  "stt-rambling-wait": "train",
  "stt-rambling-idea": "train",
  "stt-self-correct": "test",
  "stt-pixy": "validation",
  "stt-no-punctuation": "train",
  "stt-broken-sentences": "train",
  "stt-repeats": "train",
  "amb-ask-it-last": "train",
  "amb-tell-it-last": "train",
  "amb-the-other-one": "train",
  "amb-other-session": "train",
  "amb-ask-it-nobody": "test",
  "amb-that-one": "train",
  "amb-by-title": "test",
  "amb-by-title-deploy": "validation",
  "amb-by-title-ios": "validation",
  "amb-first-one": "train",
  "amb-them": "train",
  "multi-two-named": "train",
  "multi-everyone": "train",
  "multi-split-messages": "validation",
  "multi-same-question": "train",
  "multi-both-of-them": "test",
  "multi-either": "validation",
  "multi-two-instructions": "train",
  "about-working-on": "test",
  "about-which-busy": "train",
  "about-still-deploying": "test",
  "about-what-said": "validation",
  "about-how-many": "train",
  "about-which-cert": "train",
  "about-did-it-go": "validation",
  "about-repeat": "train",
  "reply-yes": "train",
  "reply-only-staging": "train",
  "reply-no-dont-push": "train",
  "reply-own-name-juniper": "validation",
  "reply-own-name-bobby": "train",
  "reply-own-name-wait": "validation",
  "reply-other-as-content": "validation",
  "reply-details-version": "train",
  "reply-long-details": "test",
  "reply-option-three": "train",
  "reply-fillers": "train",
  "reply-ask-me-tomorrow": "test",
  "reply-tell-me-more": "validation",
  "reply-own-name-details": "train",
  "reply-same-as-other": "train",
  "reply-for-others-tests": "train",
  "reply-please-dont": "train",
  "reply-force-only-if": "train",
  "reply-unsure": "test",
  "reply-first-but-only-if": "validation",
  "near-ask-other-cert": "train",
  "near-tell-other": "train",
  "near-ask-other-whether": "validation",
  "near-time": "train",
  "near-hey-other": "validation",
  "near-weather": "train",
  "near-name-other": "test",
};

// ── The cases made from real speech ──────────────────────────────────────────────────────────
// The owner's own words ("log" cases), with their splits, are private: tests/eval/private/
// relay-cases.ts (their references: relay-reference.json beside it), left out of the public repo
// (export-ignore). When it's there, its cases run with these, and --assign-splits and
// --build-reference write theirs back to it.
export const PRIVATE_RELAY_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "private", "relay-cases.ts");
const PRIVATE = existsSync(PRIVATE_RELAY_FILE) ? ((await import(pathToFileURL(PRIVATE_RELAY_FILE).href)) as { PRIVATE_RELAY_CASES: RelayCase[]; SPLITS: Record<string, Split> }) : null;
/** The private cases' ids (none in the public repo). */
export const PRIVATE_RELAY_IDS: ReadonlySet<string> = new Set((PRIVATE?.PRIVATE_RELAY_CASES ?? []).map((c) => c.id));
if (PRIVATE) {
  RELAY_CASES.push(...PRIVATE.PRIVATE_RELAY_CASES);
  Object.assign(SPLITS, PRIVATE.SPLITS);
}
