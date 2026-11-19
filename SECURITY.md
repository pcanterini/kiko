# Security

Kiko hears your microphone, types into your terminals, answers your coding agents' permission prompts, and keeps API keys and an account session in the macOS Keychain. A flaw in any of that matters, so please report it privately.

## Reporting a vulnerability

Use either:

- **Email:** [support@kiko.sh](mailto:support@kiko.sh), with a subject that starts with `[security]`.
- **GitHub:** private vulnerability reporting ("Report a vulnerability" on the repository's Security tab). It will be turned on when the repository goes public.

Please don't open a public issue, pull request or discussion about it. Tell us what you found, how to reproduce it, and which version you ran (`kiko -V`, or the commit for a checkout). A proof of concept helps, but don't test against other people's accounts or data.

## What's in scope

- **The Mac app** (`src/`), its Swift helpers and helper app (`native/macos/`), and the scripts the agents run (`hooks/`, `statusline/`).
- **What Kiko allows or asks:** the safety gate and "Allow read-only commands" (`hooks/guard/`, `src/core/guard.ts`, `src/core/auto-allow.ts`). Anything that gets a write, a send or a secret's read allowed without asking you is in scope.
- **Installing and updating:** `install.sh`, the install links, and the update check (`src/core/updates/`), including anything that gets an installed Kiko to run code that isn't signed by Kiko's developer.
- **The relay** (relay.kiko.sh) that the iPhone app will use to reach your Mac.
- **The account service** (account.kiko.sh and api.kiko.sh): sign-in, sessions, the free trial and Kiko Pro. Its server code isn't in this repository, but reports about it are welcome here too.
- Anything that lets someone else's words, a web page, a file or another program approve a tool call, type into a session, read a key, or reach your sessions.

## What isn't

- The coding agents themselves (Claude Code, Codex, OpenCode, T3 Code), the model providers, and services Kiko uses with your own keys (OpenRouter, Anthropic, Deepgram, Cartesia): report those to their makers.
- What a model decides from words you said yourself, or a permission you approved yourself.
- Attacks that need someone already in control of your Mac account (they can read your keys and settings anyway).
- Denial of service by volume, spam, and reports from automated scanners without a working issue.

## What to expect

Kiko is a small project. We aim to reply within a week, and keep you posted while we work on a fix. We'll tell you before we publish anything about it, and credit you if you'd like. There's no bug bounty.
