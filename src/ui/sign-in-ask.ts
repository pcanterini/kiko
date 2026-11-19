// The popup a paired phone turned away because this Mac is signed out brings up in the Kiko window
// (app/phone-plan.ts asks, ui/window-glue.ts shows it on the terminal used last): the reason, and
// Sign in on Enter (the highlighted item) or s; Esc lets it go. Its answer comes back as a "signIn"
// ask: the ask's id to sign in, "" when let go.
import { NAME } from "../core/name.ts";
import type { MenuData } from "./menu-view.ts";

/** `answer(arg)`: the tmux commands that send the app the "signIn" ask with `arg`. */
export function signInQuestion(ask: string, answer: (arg: string) => string[][]): MenuData {
  return {
    title: ` ${NAME} account `,
    closed: answer(""),
    items: [
      { label: "Your phone can't connect:", tone: "yellow" },
      { label: `this Mac is signed out of ${NAME}.`, tone: "plain" },
      "-",
      { label: "Sign in", note: "  in your browser, with a code", noteTone: "dim", key: "↵", input: ["s", "S"], run: answer(ask) },
      "-",
      { label: "Esc: not now", tone: "dim" },
    ],
  };
}
