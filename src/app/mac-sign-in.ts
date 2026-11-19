// The Mac's one sign-in, in the running app (core/account/mac-sign-in.ts): shared by a paired phone
// turned away because this Mac is signed out (remote/server.ts hands it the code, and the phone opens
// the approval page) and by Settings → Kiko account → Sign in (app/settings/account.ts follows the
// same one), which Enter on "Your phone can't connect: this Mac is signed out of Kiko. Press Enter to
// sign in." opens (the window's popup: app/phone-plan.ts asks for it; settings/account.ts
// signInFromPrompt). One code for both: either approval signs this Mac in. What the phone's side says
// here, on screen and out loud: "Signing in from your iPhone… Check the code there matches:
// WDJB-MJHT", then "Signed in as … from your iPhone" (the pane says its own). Approved: the plan
// asked for and a paired phone told before signed_in goes out, so the phone let in next is judged by
// the plan.
import type { Account } from "../core/account/account.ts";
import { appAccount } from "../core/account/app-account.ts";
import { MacSignIn, type MacSignInState } from "../core/account/mac-sign-in.ts";
import { log } from "../core/log.ts";
import { NAME } from "../core/name.ts";
import { ui } from "../core/ui-store.ts";
import { refreshSettings } from "./settings-screen.ts";
import { speakLine } from "./speech.ts";
import { pairing } from "./state.ts";

/** What the sign-in says here: the screen (a line), and out loud (the main moments only). */
export type SignInSay = { line: (text: string) => void; aloud: (text: string) => void };

const said: SignInSay = {
  line: (text) => ui.info(`(${text})`),
  aloud: (text) => void speakLine(text),
};
let say: SignInSay = said;

/** The phone opened its page for the sign-in under way: its end is said here, as from the iPhone. */
let phoneWatching = false;

/** The tests' own account (undefined: the app's one). */
let testAccount: Account | null | undefined;
const theAccount = (): Account | null => (testAccount !== undefined ? testAccount : appAccount());

export const macSignIn = new MacSignIn({
  account: theAccount,
  log,
  after: async (a) => {
    if (pairing.list().length) await a.syncPhone(true).catch(() => {});
    await a.check().catch(() => {});
  },
});

macSignIn.on("state", (s) => stateSaid(s));

function stateSaid(s: MacSignInState) {
  if (s.state === "signed_in") {
    if (phoneWatching) {
      say.line(`Signed in as ${s.email ?? `${NAME}'s account`} from your iPhone. Your phone connects again now.`);
      say.aloud("Signed in from your iPhone.");
    }
    phoneWatching = false;
    return refreshSettings();
  }
  if (s.state === "failed" && phoneWatching) {
    say.line(`The sign-in from your iPhone didn't go through: ${s.said}`);
    phoneWatching = false;
  }
}

/** A phone opened the approval page for the sign-in its connection holds: said here, with the code to check. */
export function phoneOpenedSignIn() {
  phoneWatching = true;
  const s = macSignIn.state();
  const check = s.state === "code" ? ` Check the code there matches: ${s.code}.` : "";
  log("mac_sign_in_opened", {});
  say.line(`Signing in from your iPhone…${check}`);
  say.aloud("Signing in from your iPhone.");
}

/** The tests' own account (undefined: the app's one again): Settings' useAccount sets it too. */
export function useSignInAccount(a: Account | null | undefined) {
  testAccount = a;
}

/** The tests' own lines, and a fresh start (undefined: the app's own lines again). */
export function setSignInSay(s?: SignInSay) {
  say = s ?? said;
  phoneWatching = false;
  macSignIn.stop();
}
