# Kiko

**Talk to all your coding agents at once.**

Kiko is a voice controller for the coding agents on your Mac. Hold a key and say what you want: Kiko sends it to the right session, reads the replies back, and lets you answer permission prompts out loud. It's open source, under the MIT license.

<!-- Demo clip goes here. -->

## Features

- **Several sessions, one voice.** Say a session's name ("api, run the tests"), or leave it out and Kiko works out which one you mean.
- **Your words, as you'd type them.** "Tell web to fix the header" arrives in web as "fix the header".
- **Mistakes are easy to fix.** A misheard name still finds its session, or Kiko asks which one you meant. If your words went to the wrong one, say "cancel that", then "that was for web", and they go on to web.
- **Replies read back.** When a session finishes or needs you, Kiko says so in a sentence or two. Say "more" for the details.
- **Permission prompts by voice.** Say "yes", "no" or "always".
- **Ask before risky actions (optional).** Turn on the safety gate and Kiko asks you before a Claude Code or Codex session sends, deletes, pays or posts, whatever the session's own permission settings say.
- **Read-only commands allowed.** On by default: when Claude Code or Codex asks to run a plain read (`ls`, `git log`, `grep`) inside the session's project folder, Kiko allows it once without asking you. Anything unusual, anything outside the folder and anything that touches a secrets file still asks.
- **Hands-free (macOS 26).** Kiko can listen for its name ("Kiko, ask api if the tests pass") instead of a key.
- **Works with** [Claude Code](https://claude.com/claude-code), [Codex CLI](https://github.com/openai/codex), [OpenCode](https://github.com/anomalyco/opencode) and [T3 Code](https://github.com/pingdotgg/t3code). Sessions you start elsewhere are heard too. [SUPPORT.md](SUPPORT.md) says what each agent supports.
- **Updates itself,** in the background, without stopping your sessions. Every update is checked against Kiko's developer signature, and `kiko update --rollback` goes back.

An iPhone app is in the works.

## Requirements

- **macOS 13 or later**, on Apple silicon or Intel. Apple's free on-device speech-to-text needs macOS 26; on older versions, add a Deepgram key.
- **A microphone.** Kiko listens in English.
- **At least one coding agent** from the list above.
- **An AI model for Kiko,** which routes your words and writes the spoken summaries: your own [OpenRouter](https://openrouter.ai/keys) key, the free trial or Kiko Pro (see [Plans](#plans)).

## Install

Run this in a terminal:

```sh
curl -fsSL https://kiko.sh | sh
```

The installer puts Kiko in `~/.local` (no sudo, no Homebrew), checks that the download is signed by Kiko's developer, and runs `kiko setup`. Open a new terminal afterwards if it says so.

### Build from source

You need Node 24 or newer, pnpm, tmux 3.3 or newer (`brew install tmux`) and Xcode's command line tools. Clone this repository (`git clone https://github.com/pcanterini/kiko.git`), then:

```sh
pnpm install
pnpm link:dev        # links ~/.local/bin/kiko-dev to this checkout (~/.local/bin must be on your PATH)
kiko-dev setup
kiko-dev
```

A checkout runs as **Kiko Dev**, with its own settings, keys and permissions, so it can sit beside an installed Kiko (only one runs at a time). It doesn't update itself: `git pull` does. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

## First run

Setup takes a minute. It asks:

1. **Your coding agents.** It adds Kiko's hooks to each agent's settings file, after a backup. Your own entries stay.
2. **How you want to run Kiko:** the free trial, Kiko Pro, your own OpenRouter key, or signing in to an account you have. A key or a sign-in is kept in the macOS Keychain.
3. **The microphone, and the talk key** (Right Option by default).

Then it says hello and opens Kiko. Esc skips a step; `kiko setup` again picks up where you left off.

macOS asks once for the microphone and Input Monitoring for **Kiko** (a small background app that comes with it). Allow both.

## Everyday use

- **`kiko`** opens the Kiko window: your sessions on the left, the one you pick on the right. Closing the terminal doesn't stop Kiko; run `kiko` again to get it back.
- **`kiko claude`** (or `kiko codex`, `kiko opencode`) starts a session in the window.
- **Hold Right Option and talk.** Let go when you're done.
- **Ctrl+Space** opens the menu: `1`–`9` show a session, `c` starts one, `s` opens Settings, `q` quits (press `q` again within 2 seconds; your sessions keep running).
- **Settings → Permissions** has the safety gate (off by default), "Allow read-only commands" (on by default) and "Permissions by voice".
- **Settings → Listening → Listen** turns on hands-free.
- **`kiko help`** lists every command.

## Before you rely on it

Kiko acts for you: it types into your sessions, answers their permission prompts with what it heard, and allows read-only commands by itself unless you turn that off. Speech recognition and AI models make mistakes, so Kiko can mishear you, pick the wrong session, or get a summary wrong, and your agents can do things you didn't mean. **You're responsible for what your agents do**, including what you approve through Kiko. Check before you approve anything that deletes, deploys, pushes, pays or posts, keep your work in version control, and don't point Kiko at systems where a mistake could do real harm. Kiko comes with no warranty; see the [terms](TERMS.md) and the [license](LICENSE.md).

## Plans

- **Your own OpenRouter key: free.** No account. You pay OpenRouter for what Kiko uses (heavy use is about $2–6 a month). `kiko keys set openrouter` adds or changes the key.
- **Free trial:** 7 days or $2 of AI usage, whichever comes first, at most $0.50 a day. No card, nothing renews. It needs a free Kiko account, made in your browser when you pick the trial in setup.
- **Kiko Pro:** $8.99 a month or $89 a year, tax included. Kiko's AI is included, so you don't need a key: $5 of AI model use a month, and past that Kiko's AI pauses until the next month (your own key keeps it going meanwhile). `kiko upgrade` opens the checkout; `kiko account billing` manages or cancels it.

`kiko account` shows who's signed in and the plan. Your own key always works, on any plan. The [terms](TERMS.md) have the details.

## Updating and uninstalling

Kiko checks for a new version once a day and downloads it in the background; it starts the next time Kiko does, or at once with Restart now in Settings → Updates. `kiko update` installs the newest version now, and `kiko update --rollback` goes back one. Settings → Updates → Automatic updates turns the downloads off.

`kiko uninstall` lists what it will remove and asks first. `kiko uninstall claude` (or `codex`, `opencode`) disconnects just that agent. It doesn't delete a Kiko account: `kiko account delete` does.

## Troubleshooting

- **It doesn't hear you:** turn Kiko on in System Settings → Privacy & Security → Microphone. Pick the mic in Settings → Listening → Microphone, and try Test microphone there.
- **The talk key does nothing:** turn Kiko on under Privacy & Security → Input Monitoring. If macOS offers to quit and reopen Kiko, either button is fine.
- **It says there's no key or plan:** run `kiko keys set openrouter`, or `kiko login` for an account.
- **A session isn't heard:** run `kiko setup claude` (or `codex`, `opencode`), or use Settings → Agents, then restart that session.
- **Ctrl+Space doesn't open the menu:** your own tmux, herdr, Warp or macOS may take it first. Kiko uses Ctrl+\ that time and asks whether to keep it; Settings → The Kiko window → Menu key picks your own.

Logs are in `~/.local/state/kiko/logs/`, kept for 30 days unless you change it (Settings → Logs → Keep logs). They contain what you said, so read them before you share them.

## Privacy and terms

Kiko runs on your Mac and sends no analytics or telemetry. With your own keys, nothing goes through a server of ours.

- Privacy: [kiko.sh/privacy](https://kiko.sh/privacy) ([PRIVACY.md](PRIVACY.md)) says what goes where.
- Terms: [kiko.sh/terms](https://kiko.sh/terms) ([TERMS.md](TERMS.md)). Setup shows them before its first step, and going on accepts them, as signing in, starting the free trial and subscribing do.

## License

Kiko is open source under the [MIT license](LICENSE.md).

## Contributing and contact

- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
- Security issues: [SECURITY.md](SECURITY.md). Please report them privately, not in a public issue.
- Everything else: [support@kiko.sh](mailto:support@kiko.sh).
