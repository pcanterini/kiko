// Never the real `claude --help`: the help text is T.claudeHelp's (a case sets it, or calls readHelpWith as the
// unit tests do), else none, as a claude whose help can't be read (no mode offered: sessions start in the setting's).
// How it's read (modesInHelp) is the real module's.
import { modesInHelp } from "../../../../../src/agents/claude-code/modes-offered.ts";

export { modesInHelp };

const fromT = async () => String((globalThis as any).T.claudeHelp ?? "");
let reader: () => Promise<string> = fromT;
let offered: Promise<string[] | null> | null = null;

export function modesOffered(): Promise<string[] | null> {
  offered ??= reader().then(modesInHelp, () => null);
  return offered;
}

export const offersMode = async (mode: string): Promise<boolean> => (await modesOffered())?.includes(mode) ?? false;

/** As the real one's, but left out it goes back to T.claudeHelp, never to a real `claude --help`. */
export function readHelpWith(read?: () => Promise<string>) {
  reader = read ?? fromT;
  offered = null;
}
