# Terms of use

*Effective November 4, 2026. Not yet reviewed by a lawyer.*

These terms cover the Kiko app for the Mac ("Kiko"), the optional Kiko account, the free trial and Kiko Pro, made by Bald Cactus, LLC ("we", "us"). By installing or using Kiko, or signing in to an account, you agree to them ([below](#accepting-these-terms)). The source code is also covered by its [license](LICENSE.md); if the two ever disagree about the code itself, the license wins. What the iPhone app comes with is under [Kiko Pro](#kiko-pro); the app itself will have terms of its own when it launches.

## Accepting these terms

You accept these terms and our [privacy policy](PRIVACY.md) when you:

- **Use Kiko,** including going on past the first step of `kiko setup`, which shows them.
- **Sign in** to a Kiko account, with `kiko login`, in setup or on account.kiko.sh, including approving a Mac's sign-in there.
- **Start the free trial.**
- **Subscribe to Kiko Pro,** in `kiko upgrade`, in setup or on the account page; Kiko Pro's part of these terms applies from then.
- **Pair the iPhone app** with your Mac.

Each of these shows a line saying so, with a link to these terms, next to the step that accepts them. We keep a record of which version you accepted and when: in Kiko's settings on your Mac and, once you have an account, with it on our account server. If you don't agree, don't use Kiko.

## Your account (optional)

You don't need an account to use Kiko on your Mac with your own keys. You need one for the free trial or Kiko Pro, and so for the iPhone app.

- **One person per account.** Don't share it, and don't sign other people's Macs in to it.
- **Use an email address that's yours,** that you can receive mail at, and keep it current.
- **Keep it secure.** Anyone who gets into your Mac, your email or your Google account can use your Kiko account, and you're responsible for what's done with it. Only approve a sign-in code you started yourself.
- **You can delete it any time,** with `kiko account delete` or on the account page (account.kiko.sh/account). Deleting it ends Kiko Pro at once, with no refund ([below](#kiko-pro)). Our [privacy policy](PRIVACY.md) says what's kept and for how long.
- **We may suspend or close an account** that breaks these terms, or to stop abuse.

## The free trial

- **7 days or $2 of AI usage, whichever comes first,** with at most $0.50 a day. No card, and nothing is charged: at the end it just stops. Your own key always works on the Mac after it.
- **The free trial includes the iPhone app,** at home and away from home, as Kiko Pro does ([below](#kiko-pro)).
- **One trial per person.** Don't make more accounts, or use other email addresses, to get more trials.
- **Don't get around its limits,** or try to.
- **Only through Kiko.** No scripts or other programs calling our service (api.kiko.sh) directly, and no reselling or sharing access to it.
- **The providers' rules apply too.** The trial's requests go to OpenRouter and the model's provider, and you must follow their terms and usage policies.
- **We may end a trial for abuse,** with any other trials linked to it, without notice.
- **No promise it's available.** A daily cap on all free trials together can pause new trials and the trial's AI until 00:00 UTC, and we may change the trial or stop offering it to new sign-ups.
- **Buying Kiko Pro during the trial ends the trial,** and Pro starts at once.
- **AI makes mistakes during the trial too.** What the trial's models produce is covered by everything below, as for your own key: it can be wrong, and you're responsible for what your agents do.

## Kiko Pro

Kiko Pro is the paid plan: Kiko's AI included (no key of your own needed) and the iPhone app.

- **Price:** $8.99 a month or $89 a year, tax included.
- **Sold by Stripe.** Kiko Pro is sold through Stripe Managed Payments: Stripe (with its Link service) is the merchant of record, the seller of record for your purchase. Its terms for the sale apply alongside ours, and payment support, receipts and disputes go through it.
- **It renews until you cancel,** every month or year. Cancel any time in Stripe's billing page (`kiko account billing`, or Manage billing on the account page), and Pro stays until the end of the month or year you paid for.
- **No refunds,** including for the rest of a period after you cancel, beyond the 14-day right of withdrawal you may have in the EU or the UK, which Stripe's checkout handles as the seller. If you think you should get a refund, write to [support@kiko.sh](mailto:support@kiko.sh), and we'll look at it.
- **Switching** between monthly and yearly is prorated by Stripe.
- **A failed payment:** Pro keeps working for 7 days, the iPhone app included, while Stripe tries again, and we email you once. If it still hasn't gone through, Pro ends.
- **Deleting your account** cancels the subscription at once, with no refund. To keep Pro to the end of what you paid for, cancel instead.
- **What's included:** $5 of AI model use a month. Once it's used, Kiko's AI stops until the allowance renews the next month; your own OpenRouter key keeps Kiko going meanwhile. The weekly pace Kiko shows is a guide, not a limit.
- **Limits:** at most 30 AI calls a minute per account, as on every plan. The free trial's rules on using it only through Kiko, not getting around its limits and following the providers' rules apply to Kiko Pro too, and we may end Kiko Pro for abuse.
- **The iPhone app:** Kiko Pro and the free trial include it, at home and away from home. Your own key keeps only the Mac app free; without Pro or the trial, the phone doesn't connect.
- **When Pro or the trial ends,** the phone stops connecting at its next connection (one already connected isn't cut off), but it keeps its pairing: renewing brings it back.
- **If our account server can't be reached,** your Mac keeps allowing the phone at home for up to 7 days from its last successful check, and away from home for up to a day (the relay pass it holds lasts 24 hours).
- **Nothing is sold on the iPhone.**
- **Price changes:** we'll tell you before a new price applies to your next renewal, so you can cancel first.

## What Kiko does for you

Kiko listens to you and acts in your coding agents on your behalf. It types your words into your sessions, answers their permission prompts and questions with the answers you give, and can start, stop and rename sessions. To do that it relies on speech recognition and AI models.

**Speech recognition and AI models make mistakes.** Kiko can mishear you, send your words to the wrong session, summarize a reply wrongly or leave out something that matters, take a "yes" meant for one question as the answer to another, or treat a risky command as harmless. Your coding agents are AI too, and they can do things you didn't intend, including deleting files, changing code, running commands, spending money, or sending things to other people and services.

## You're responsible for what your agents do

- You decide what your agents may do, and you're responsible for everything they do, including actions approved through Kiko, by voice or by key.
- Check what an agent is about to do before you approve it, especially anything that deletes, deploys, pushes, pays, sends or posts.
- Keep your work in version control and keep backups.
- The safety gate (Settings → Permissions) is off by default, and when it's on it won't catch everything. Don't rely on it as your only safeguard.
- Don't use Kiko with systems where a mistake could cause serious harm (production systems, money, health, safety, or other people's data) unless you have your own safeguards in place.

## Other services

Outside the free trial and Kiko Pro, Kiko uses services you choose and pay for yourself, such as OpenRouter, Anthropic, Deepgram and Cartesia, and it works with coding agents made by others, such as Claude Code, Codex, OpenCode and T3 Code. Your use of each is governed by its own terms and pricing. You're responsible for the charges on your own keys and accounts. We're not responsible for those services: their availability, what they charge, what they do with your data, or what they produce.

## No warranty

Kiko, your account, the free trial and Kiko Pro are provided "as is" and "as available", without warranties of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose, accuracy and non-infringement. We don't promise that Kiko will be error-free, uninterrupted, or that it will hear, understand, route, summarize or decide correctly.

## Limitation of liability

To the fullest extent the law allows:

- We're not liable for any indirect, incidental, special, consequential or punitive damages, or for any loss of data, code, work, profits, revenue or business, arising from or related to Kiko, your account, the free trial or Kiko Pro, even if we were told they were possible.
- We're not liable for anything your coding agents or other services do, including actions you approved through Kiko and actions taken because Kiko misheard, misrouted, misread or misjudged something.
- Our total liability for all claims related to Kiko, your account, the free trial or Kiko Pro is limited to the greater of the amount you paid for Kiko Pro in the 12 months before the claim, or US$50.

Some places don't allow some of these limits. Where that's the case, they apply as far as the law there allows.

## Indemnity

If someone brings a claim against us because of how you used Kiko, or because of something your agents did through it, you agree to cover our reasonable costs of that claim, to the extent the law allows.

## Ending

You can stop using Kiko, cancel Kiko Pro and delete your account at any time. We may change, pause or end the account service, the free trial or Kiko Pro at any time. If we stop offering Kiko Pro, we'll tell you first, and it won't renew again.

## Changes

We may update these terms. The date at the top changes when we do, Kiko says once that they changed, and if a change is significant we'll say so in the release notes. Using Kiko after a change means you accept the new terms.

## Governing law

These terms are governed by the laws of the State of Delaware, United States, without regard to its conflict-of-law rules.

## Contact

[support@kiko.sh](mailto:support@kiko.sh)
