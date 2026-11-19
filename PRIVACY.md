# Privacy

*Effective November 5, 2026.*

Kiko runs on your Mac. **You don't need an account:** with your own keys there's no sign-in, no server of ours that sees your words, and no analytics or telemetry. What leaves your Mac goes to the services below, with your own keys.

If you choose the free trial or Kiko Pro, you sign in to a Kiko account, and Kiko's AI requests pass through our server on their way to OpenRouter. [Accounts](#accounts-optional), [Free trial](#free-trial) and [Kiko Pro](#kiko-pro-payments) say what that keeps.

## Your voice

- **Speech-to-text runs on your Mac by default:** Apple's on-device recognizer (macOS 26). Your audio isn't sent anywhere. The first time, macOS may download Apple's English speech model.
- **Kiko's voice runs on your Mac:** Pocket, a local voice model, or the built-in macOS voice while Pocket isn't ready. The install downloads Pocket once (about 1 GB: the model from Hugging Face, its Python packages, and uv from GitHub if you don't have Python or uv).
- **Hands-free mode** keeps the mic open (macOS shows its orange dot), but it's all transcribed on the Mac, and only a phrase that starts with Kiko's name goes further, or your reply right after a session is read out. Other phrases are dropped.
- **A Bluetooth mic in use** (AirPods, whether macOS made them the default microphone or you picked them in Settings → Listening → Microphone) is kept open while it's the mic in use, so it's ready the moment you press (macOS shows its orange dot). What it hears between presses is dropped at once, inside the microphone helper: not transcribed, not kept, not sent anywhere. To keep it closed between presses, pick the Mac's own microphone there.
- **Audio is never saved.**

## What goes to OpenRouter

Your OpenRouter key (or ours, during the [free trial](#free-trial) or with [Kiko Pro](#kiko-pro-payments)) pays for a few small model calls. Each one sends text, never audio:

- **Routing:** what you said, your sessions' names, folders and status, what each was last asked and last said (a few hundred characters), and your recent back-and-forth with Kiko.
- **Summaries:** a session's reply when it finishes a turn, and what you asked it, so Kiko can say it in a sentence or two. "More" sends the same reply again for a longer summary.
- **Clean-up:** what you said, to take out the "uh"s and false starts before a session reads it. Off in **Settings → Listening → Clean up my messages**.
- **The classifier:** quick yes/no decisions: who your words are for, whether a finished reply is worth reading out, whether your answer to a permission prompt is a yes, and how risky that request looks. It sees your words, the reply, and the permission request (the command, file or tool the agent wants to use). For the safety gate (below), it also sees a command or tool call that only looks risky, before it runs: a script's name (`./deploy.sh`), a package script, or an MCP tool's name and its arguments (cut to 600 characters). Clear cases are decided on your Mac, with no model. Off in **Settings → Decisions → Classifier**.
- **Answering a session's multiple-choice question:** what you said, and the question with its options.

OpenRouter passes each call to the model's provider (Claude Haiku by default for routing, summaries and clean-up). Their own privacy policies apply.

## Only if you add their keys

- **Anthropic:** with an Anthropic key, every call above except the classifier can go to Anthropic directly instead of through OpenRouter. The classifier still uses OpenRouter.
- **Deepgram:** with a Deepgram key, speech-to-text runs on Deepgram. Your audio streams to Deepgram while you hold the talk key, with the words to expect (your dictionary, session names and folders).
- **Cartesia:** with a Cartesia key, Cartesia's voice reads things out. The text being said goes to Cartesia.

When you enter a key, Kiko checks it with one small request to that provider. Keys are kept in the macOS Keychain, never in a file, and never shown in full (`kiko keys` shows the last four characters).

## Your coding agents

Kiko acts in your agents for you:

- It **types your words** into your sessions and **answers their permission prompts and questions** with the answers you give by voice or with a key ("always" uses the rule the agent offers).
- It reads your sessions' conversations on your Mac to know what they said.
- To connect an agent, it adds its hooks to the agent's settings file, after asking and with a backup. Your own entries stay.
- Sessions Kiko opens start in **Accept edits** mode: edits go ahead, and everything else asks you (Codex gets its nearest mode). Sessions you start yourself are left as they are. Change it in **Settings → New sessions → Permission mode**.
- What your voice may do is set in **Settings → Control → Voice can.** By default (Everything) it can reply, send messages, and start, stop and rename sessions; turn on the safety gate below to be asked before anything that sends, deletes, pays or posts. "Replies and messages" leaves out starting, stopping and renaming; "Replies only" only answers a session that's waiting for you.
- At Voice can: Everything, a quick question ("how much disk space do I have?") may be answered by a short, look-only Claude Code run (`claude -p`) on your Claude account. Anything beyond looking is asked first, and it never edits files.
- **The safety gate** (off by default; Settings → Permissions turns it on): while Kiko runs with it on, its hooks look at each shell command and MCP tool call your Claude Code and Codex sessions are about to run, on your Mac, and Kiko asks you first about anything that sends, deletes, pays or posts, whatever the session's own permission mode or allow rules. Most calls are decided by rules in code and never leave your Mac; only one that looks risky but unclear goes to the classifier (above). Each ask and answer is logged (`guard_ask`, `guard_answer`), with the command as the permission logs show it. Off, the hooks only read that it's off, in Kiko's settings file on your Mac, and look at nothing else. Settings → Permissions turns it on, and each kind of it off or on.
- If Kiko isn't running, or you don't answer in time, the agent asks in its own window as usual (Codex: a call the safety gate held is not run).

The agents themselves send your conversations to their own providers, as they always do.

## Updates

Once a day, Kiko fetches `https://kiko.sh/releases/latest.json` to see whether there's a new version, and downloads it when there is. The request carries Kiko's version (`kiko/<version>`) and, while Kiko is in its invite-only beta, your invite's install token and a random install id for this Mac (made once, kept beside the install in `~/.local/share/kiko/`; the install script sends the same two). No account and nothing else about you. kiko.sh records, for each use of an invite's link: the invite, the install id, the time, which file and which version of Kiko, and the country and city Cloudflare works out for the request. It never stores your IP address. We use this to see how many Macs each invite is installed on (3 by default) and where, roughly, and to turn off a link that's been shared too widely; the server sees your IP address, as any web request does. **Settings → Updates → Automatic updates** turns the downloads off; Kiko still checks. To stop the check too, set `KIKO_UPDATES=off` in your shell.

## Accounts (optional)

You don't need an account to use Kiko on your Mac with your own keys. You need one for the free trial or Kiko Pro, and so for the iPhone app, which comes with them. `kiko login` opens account.kiko.sh in your browser to sign in.

- **Signing in:** with Google, or with a 6-digit code we email you. From Google we ask only for your email address (no name, no photo), and we keep Google's id for you but none of Google's tokens. Email codes are stored scrambled (hashed), allow 3 tries, and stop working after 5 minutes.
- **The account:** your email address, when the account was made, whether you use Google to sign in, and your plan: none, the free trial (with its dates), or Kiko Pro (with its billing record: [Kiko Pro](#kiko-pro-payments)). Also which version of our [terms](TERMS.md#accepting-these-terms) you accepted, how (signing in, approving a Mac, starting the trial or opening a checkout) and when.
- **Each signed-in Mac or browser:** a session, with the app that signed in (for example "Kiko 0.4 on macOS", or your browser's user agent), your Mac's name as it shows in System Settings → General → Sharing (so the account page can say "Kiko on Lacy's MacBook Pro"; Kiko sends it with each account call, and the session keeps the latest), when it signed in and was last used, and the IP address it signed in from. **The IP address is cleared after 30 days.**
- **The approval page** ("Is this the code on your Mac?") shows the rough location of the Mac asking (a city and country Cloudflare works out from its IP address), so you can tell it's yours. That's kept with the code for at most 10 minutes. The Mac's IP address isn't kept with it.
- **Bot and abuse checks:** Cloudflare Turnstile runs on the sign-in and approval pages. It looks at your browser to tell people from bots. To limit repeated attempts, we count requests per IP address and per email (the email scrambled); those counters are deleted within 2 days.
- **Cookies:** account.kiko.sh sets a sign-in cookie when you sign in there, only to keep you signed in. No analytics or advertising cookies.
- **On your Mac:** the session's token is in the Keychain, and who's signed in (your email, since when) is in `~/.config/kiko/account.json`. No token is ever written to a file or a log.
- **Usage records:** when Kiko's AI requests go through us (the trial and Kiko Pro), we keep the usage records under [Free trial](#free-trial), never what was said.
- **Emails from the account:** only sign-in codes, a code to confirm deleting the account, during a trial one email the day before it ends, and with Kiko Pro one email if a payment fails. No marketing.
- **The iPhone app** isn't available to the public yet: for now it runs only as development builds, and it will come to testers through TestFlight first. It gets its account from your Mac when it pairs, with no sign-in of its own. It comes with Kiko Pro or the free trial: when the phone connects, your Mac checks the plan our server last told it. While a phone is paired, that Mac's session doesn't expire from disuse; it ends only when you sign it out.
- **The relay pass:** away from home, the phone reaches your Mac through our relay (relay.kiko.sh). For the relay to let it in, your Mac gets a pass from our server and shows it to the relay. The pass carries your account's id, your plan (the trial or Kiko Pro) and your Mac's relay room (an id made from your Mac's relay key, which your Mac sends our server so the pass works for your Mac only), and lasts 24 hours. The relay checks them when a phone joins, and doesn't store them. Your Mac keeps the pass in memory only, never on disk or in the Keychain.
- **When access ends sooner:** if you sign a Mac out, delete your account, or your plan ends (or we ban the account), our server writes a short note to a list the relay reads when a phone joins, so a pass issued before then stops working: your account's id (and, when one Mac is signed out, that Mac's relay room) and the time. Nothing else. Each note deletes itself after 26 hours, when every pass it could stop has run out anyway.

## Free trial

- **What it is:** 7 days or $2 of AI usage, whichever comes first, with at most $0.50 a day. No card. At the end it just stops: nothing is charged and nothing renews.
- **Where your requests go:** during the trial, Kiko's AI requests (the same text as under "What goes to OpenRouter" above) go to our server, api.kiko.sh, which passes them to OpenRouter with our key. OpenRouter passes them to the model's provider. **We don't store or log what's in them.** OpenRouter gets at most a scrambled (HMAC) id for your account, never your email. OpenRouter's and the provider's policies apply to what they receive.
- **What we keep:** when your trial started and when it ends, and a record of each AI request: your account's id, your plan, the kind of request (routing, a summary…), the model and its provider, how many tokens and what it cost in dollars, how long it took, whether it worked or failed, your Kiko and macOS versions, and the Cloudflare location and country it came through. It also holds an id for the request (ours, and OpenRouter's, to check the cost against theirs), a finer label for what the request was, the token limit it was sent with, whether the app hung up before the answer ended, and where the cost figure came from (OpenRouter, or our estimate). All of it is about the request, **never what was said:** not your prompts, not the replies. Each day's totals (requests, tokens and cost, by kind of request and model) are added up per account in the account database. A usage counter for your account keeps its own daily totals too, to hold the trial to its limits. We use this to count your trial's usage (and Kiko Pro's), and to understand and improve Kiko. We don't sell it.
- **Limits:** at most 30 AI requests a minute per account, on any plan; we count each account's requests a minute, and each IP address's in memory only: the address is never stored. A daily cap on all free trials together can pause new trials and the trial's AI until 00:00 UTC; it counts the trials' total cost, nothing about you.
- **One trial per person:** when a trial starts, we keep a scrambled (HMAC) copy of your email, with the variations of one mailbox (Gmail's dots, `+tags`) made the same first. We also check that the email's domain isn't a throwaway one and can receive mail (by looking up the domain, not the address), and limit how many trials start from one IP address a day. For that we count under a scrambled (HMAC) copy of the address, never the address itself, for a day.
- **Your own key wins:** add an OpenRouter key any time, and Kiko's requests go straight to OpenRouter again, not through us.

## Kiko Pro (payments)

- **What it is:** Kiko's AI included and the iPhone app, for $8.99 a month or $89 a year, tax included. It includes $5 of AI model use a month; past that, Kiko's AI stops until the allowance renews the next month, and your own OpenRouter key keeps Kiko going. Nothing is sold on the iPhone. The [terms](TERMS.md#kiko-pro) say the rest.
- **Stripe sells it:** Kiko Pro is sold through Stripe Managed Payments, so **Stripe (with its Link service) is the merchant of record**: the seller of record. It takes the payment, works out and pays the tax, sends receipts and invoices, and handles payment support and disputes. At checkout it collects what it needs (such as your name, email, billing address and payment details) under its own privacy policy and Link's. Stripe receives that data in its own right, not only as our processor.
- **What we send Stripe:** your account's email address and its id, when you first open a checkout.
- **What we keep:** the Stripe customer and subscription ids, the subscription's status, monthly or yearly, its dates (when the period started and ends, when a cancellation takes effect), and when a payment failed. **Never your card details or your billing address.** To handle Stripe's notices once each, we keep their ids (no content) for 30 days.
- **Your AI requests:** with Kiko Pro they pass through our server as in the [free trial](#free-trial), with the same usage records, never what was said.
- **Emails:** one from us if a renewal payment fails. Receipts and invoices come from Stripe.

## Who processes account, trial and Kiko Pro data

- **Cloudflare:** hosts account.kiko.sh and api.kiko.sh, keeps the account database, the usage counters and the usage records, sends our emails, and runs Turnstile.
- **Google:** only if you sign in with Google. Google learns that you signed in to Kiko.
- **OpenRouter and the model's provider** (Anthropic's Claude Haiku by default): your trial's and Kiko Pro's AI requests.
- **Stripe and Link:** only if you buy Kiko Pro. They sell it to you as the merchant of record, and get what's under [Kiko Pro](#kiko-pro-payments), under their own privacy policies.

We don't sell personal information or share it for advertising. The data is processed in the United States and wherever Cloudflare runs.

## How long it's kept

- **The account** (email, Google's id, your plan and the trial's dates, Kiko Pro's billing record, the terms you accepted): until you delete it.
- **Sessions:** until you sign out, or 90 days after last use (no limit while a phone is paired with that Mac).
- **Sign-in IP addresses:** 30 days, then cleared.
- **Codes:** 5 minutes (email codes), 10 minutes (`kiko login` codes, with the rough location).
- **Rate-limit counters:** at most 2 days (the trial-start counter's scrambled IP address included). The AI requests' count per IP address is kept in memory only.
- **Usage:** each request's record (under [Free trial](#free-trial)) for 3 months, in Cloudflare's analytics store, which deletes it then; the daily totals in the account database for 400 days after their day, and never longer than the account (they're deleted with it). The usage counter keeps its daily totals for 100 days, and drops everything within a day of the account being deleted, or once the account hasn't made an AI request for 100 days.
- **Daily statistics:** totals per day across all accounts (requests, cost, timings, refusals), with no prompt text, keys or email addresses, and no account id: 400 days.
- **Stripe's notices:** their ids, with no content, for 30 days.
- **Install links (the beta):** each invite (the email it went to, a scrambled form of its token, when it was sent, how many Macs it allows) and its uses (above, under [Updates](#updates)), until the beta ends or you ask us to delete them at support@kiko.sh.
- **Server logs:** our own lines only, with no IP addresses, email addresses, tokens or request contents. Cloudflare deletes them after 7 days.
- **Backups:** the database and the usage counters keep 30 days of history, so deleted data is gone from them within 30 days.
- **After you delete your account:** one scrambled copy of your email, for 3 years from when it was made (below).

## Deleting your account

On the account page (account.kiko.sh/account), **Delete my account**, or `kiko account delete` on your Mac. We email you a code to confirm it. Deleting removes your account, every session (every Mac is signed out), your Google link, and your plan, your trial and its daily usage totals in the account database, at once. The usage counter's own totals go within a day. The per-request usage records (which carry your account's id, not your email) can't be deleted one by one; they go when their 3 months run out.

**With Kiko Pro,** deleting cancels the subscription at Stripe at once, with no refund. To keep Pro to the end of the month or year you paid for, cancel instead (`kiko account billing`, or Manage billing on the account page). Stripe keeps its own records of the sale, as the law requires.

**Beyond those, we keep one thing:** a one-way scrambled copy (HMAC) of your email, for 3 years, whether or not you used the trial, only so the free trial can't be claimed again. The 3 years count from when your trial started, or from the deletion if you never had one. It can't be turned back into your email.

Kiko keeps working on your Mac with your own key. `kiko logout` signs one Mac out (its session on our server ends at once). `kiko uninstall` removes the Mac's sign-in from the Keychain; its session on our server then ends after 90 days unused, or sign it out on the account page.

## Your rights

- **See what we hold:** the account page shows your email and your signed-in Macs. For a copy of everything we hold about you, email support@kiko.sh.
- **Correct, delete or export it:** delete on the account page; anything else at support@kiko.sh. We answer within 30 days.
- **Where you live** (for example the EU, the UK or California), you may have more rights, including to complain to your data protection authority. We'll honor them.
- **Why we use it:** to provide the account, the trial and Kiko Pro you asked for; to stop trial abuse (a legitimate interest), which is why the scrambled email outlives the account; and to understand and improve Kiko from the usage records (a legitimate interest), which never hold what was said.
- **Children:** Kiko isn't for children under 16.

## What's kept on your Mac

- **Logs:** `~/.local/state/kiko/logs/`, one file per run. They hold what you said, what Kiko said and typed into sessions, permission requests, session names and folders, and what each model call cost. They're never uploaded. **They're kept for 30 days by default:** older ones are deleted when Kiko starts and once a day while it runs. **Settings → Logs → Keep logs** changes it (7 days, 30 days, 90 days or Forever), shows how much they take up, and opens the folder in Finder.
- **Settings:** `~/.config/kiko/` (your settings, dictionary, session names, quick-check answers, and small records of running Codex sessions).
- **While it runs:** a socket and a small state file in `/tmp`.
- **Keys:** the macOS Keychain, under the service `sh.kiko.keys`. If you sign in, the account's session token is there too, and `~/.config/kiko/account.json` says who's signed in.
- **The app and its voice:** `~/.local/share/kiko/`.

## Deleting it all

`kiko uninstall` asks first whether macOS should forget Kiko's permissions (microphone, Input Monitoring, speech recognition), then removes Kiko's hooks from your agents, its settings, the app, its voice, the PATH line and its keys in the Keychain (with the account's sign-in), then asks whether to delete the logs too. It doesn't delete your account: do that first with `kiko account delete`, or on the account page. Your scratch folder and the backups of your agents' files are left for you.
