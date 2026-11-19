// The app's one Account (./account.ts): Settings → Account, the twice-daily check, and the model
// calls through the account (core/model-route.ts) share it, so the access token held in memory is
// one. Null while accounts aren't open (core/env.ts accountsLive). With no Keychain (KIKO_KEYCHAIN=off)
// it's there, signed out: there's nowhere to keep a sign-in.
import { keyStore } from "../../platform/keys.ts";
import { accountsLive, accountUrl } from "../env.ts";
import { log } from "../log.ts";
import { Account } from "./account.ts";
import { accountClient } from "./client.ts";
import { planActive, planRunsAi } from "./plan-words.ts";

let account: Account | null = null;

export function appAccount(): Account | null {
  if (!accountsLive()) return null;
  account ??= new Account({ store: keyStore, client: accountClient(accountUrl()), log });
  return account;
}

/**
 * Whether the account's plan runs Kiko's model calls now, as last known (account.json): accounts
 * open, signed in, a trial or Pro not past its end (nor Pro past its month's allowance: paused until
 * it renews). Asked with no OpenRouter key of your own (yours always wins).
 */
export function accountRunsModels(now = Date.now()): boolean {
  const v = appAccount()?.view();
  return v?.state === "signed-in" && planRunsAi(v.plan, now);
}

/**
 * Whether the account's plan means no key of your own is needed to start (config.ts noModelKey), as
 * last known: signed in, a trial or Pro in effect, Pro past its month's allowance included (paused
 * until it renews, its AI calls waiting meanwhile: never a reason to ask for a key, setup's choice).
 */
export function accountHasPlan(now = Date.now()): boolean {
  const v = appAccount()?.view();
  return v?.state === "signed-in" && planActive(v.plan, now);
}
