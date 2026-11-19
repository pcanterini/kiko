// The plan's notices (core/model-route.ts: the trial ended, today's share used, almost used up…),
// shown and said, and the Kiko window's offer of your own OpenRouter key while the plan refuses
// Kiko's AI (core/account/plan-words.ts KeyOffer): its key (ADD_KEY_KEY) in the list and in the
// Ctrl+Space menu opens Settings → Keys → OpenRouter with its paste open (the addKey action), the
// same paste, check and Keychain as ever (core/keys.ts KeySettings). Without the window (--plain)
// the notice says the command instead, and nothing is offered.
//
// The offer stands (UiState keyOffer: a line in the list, an item in the menu) until an OpenRouter
// key is saved (keySaved: let go, and "Key saved…" shown and said; the settings screen it opened
// closed again), the plan runs a call again (planBack: today's share back, Pro bought), or, for
// today's share, the time it's back. Your own key is read at each call (core/key-values.ts keyOf),
// so the next one goes on it: nothing restarts.
import { KEY_BACK_LINE, type KeyOffer, type Notice } from "../core/account/plan-words.ts";
import { ui } from "../core/ui-store.ts";

export type KeyOfferDeps = {
  /** A line on Kiko's page. */
  show: (line: string) => void;
  /** Said, and the phone's words for it when they differ (`phone`). */
  say: (text: string, phone?: string) => void;
  /** The app's log (never a key). */
  log: (event: string, data: Record<string, unknown>) => void;
  /** The Kiko window's list is there to take the key (false: --plain). */
  window: () => boolean;
  /** Closes the settings screen (the app's closeSettings). */
  closeSettings: () => void;
  now: () => number;
};

const NONE: KeyOfferDeps = { show: () => {}, say: () => {}, log: () => {}, window: () => false, closeSettings: () => {}, now: Date.now };

export class KeyOffers {
  private d: KeyOfferDeps;
  /** Lets the offer go when today's share is back (its `until`). */
  private timer: NodeJS.Timeout | null = null;

  constructor(d: Partial<KeyOfferDeps> = {}) {
    this.d = { ...NONE, ...d };
  }

  /** The app's own (app.ts), once it has them. */
  wire(d: Partial<KeyOfferDeps>) {
    this.d = { ...this.d, ...d };
  }

  /** A plan's notice: shown and said; in the window, its offer's words, and the offer stands. */
  notice(n: Notice) {
    const offer = this.d.window() ? n.offer : undefined;
    this.d.log("account_notice", { notice: n.key.split(":")[0], ...(offer ? { offer: offer.why } : {}) });
    this.d.show(`(${offer?.line ?? n.line})`);
    this.d.say(offer?.spoken ?? n.spoken, offer && offer.phone !== offer.spoken ? offer.phone : undefined);
    if (offer) this.stand(offer);
  }

  /** An OpenRouter key saved and in use now (core/keys.ts KeySettings, any way it was entered): the offer let go, and said. */
  keySaved(id: string) {
    if (id !== "openrouter" || !ui.state.keyOffer) return;
    // Opened by the offer: closed again, back where you were.
    const opened = ui.state.screen === "settings" && Boolean(ui.state.settingsPaste);
    this.letGo("key");
    if (opened) this.d.closeSettings();
    this.d.show(`(${KEY_BACK_LINE})`);
    this.d.say(KEY_BACK_LINE);
  }

  /** A call went through the plan again (today's share back, Pro bought): the offer let go, quietly. */
  planBack() {
    if (ui.state.keyOffer) this.letGo("plan");
  }

  private stand(offer: KeyOffer) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const left = offer.until === null ? null : offer.until - this.d.now();
    if (left !== null && left <= 0) return;
    ui.set({ keyOffer: { why: offer.why, until: offer.until } });
    if (left === null) return;
    this.timer = setTimeout(() => this.letGo("time"), Math.min(left, 2 ** 31 - 1));
    this.timer.unref();
  }

  private letGo(why: "key" | "plan" | "time") {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!ui.state.keyOffer) return;
    this.d.log("key_offer_done", { offer: ui.state.keyOffer.why, why });
    ui.set({ keyOffer: null });
  }
}

/** The app's. */
export const keyOffers = new KeyOffers();
