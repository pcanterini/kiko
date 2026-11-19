# Contributing

Thanks for wanting to help. Kiko is a voice controller for coding agents (Claude Code, Codex, OpenCode, T3 Code) on the Mac. It's TypeScript run directly by Node (no build step), with an Ink TUI, a few Swift helpers, and tmux.

Where to read more:

- [ARCHITECTURE.md](ARCHITECTURE.md): how it's put together, and the rules that hold it together.
- [DEVELOPMENT.md](DEVELOPMENT.md): the working reference (the window, the command line, each agent, how to try things by hand).
- [SUPPORT.md](SUPPORT.md): what each agent supports, feature by feature.
- [README.md](README.md) and [PRIVACY.md](PRIVACY.md): what people who install Kiko read.

Found a security issue? Don't open an issue or a pull request: see [SECURITY.md](SECURITY.md).

## Setup

You need:

- macOS, Node 24 or newer (it runs `.ts` files as they are), pnpm, and tmux 3.3 or newer (`brew install tmux`).
- Xcode's command line tools. The Swift helpers in `native/macos/` are built with `swiftc` the first time they're needed, into `native/macos/.build/` (`rm -r native/macos/.build` forces a rebuild). What `swiftc` says goes to `logs/native-build.log`.

Then:

```sh
pnpm install
pnpm link:dev      # links ~/.local/bin/kiko-dev to this checkout
kiko-dev setup     # the first-run questions: agents, a key or the trial, the mic, the talk key
kiko-dev           # opens the window (or: pnpm start)
```

A checkout runs as **Kiko Dev**: its command is `kiko-dev`, with its own settings (`~/.config/kiko-dev/`), Keychain service, tmux server (`tmux -L kiko-dev`), socket and logs (the repo's `logs/`), so it can sit beside an installed Kiko. Only one of the two runs at a time. macOS asks for its permissions as "Kiko Dev". DEVELOPMENT.md, "Kiko Dev: a checkout beside an installed release", has the details.

## Running the checks

- `pnpm check`: typecheck, lint and format check, then the unit tests. Run it before sending a change.
- `pnpm typecheck` and `pnpm lint` on their own; `pnpm format` formats everything (Biome).
- `pnpm test`: the unit tests (`tests/unit/`), fast and in parallel. Nothing real is started but a few Swift helpers and, on a throwaway keychain, the keychain one.
- `pnpm test:app`: the app harness, the whole app on stubs (`tests/harness/`), with no mic, keys or real agents. It takes about 6 minutes and ends with "app: all passed". It runs in a clean environment, and the real `claude`, `rex`, `tmux`, `osascript`, `security` and `open` are refused there (`tests/harness/run.sh` says how). `pnpm check:full` runs `pnpm check` and then it: run that before sending a change to `src/`.
- `pnpm test:live`: the live tests (`tests/live/`), with real tmux servers, the real `bin/kiko`, fake agents and an install from a release built for the test (that one needs Bun). They run one file at a time. Under load one can time out: run it again on its own (`node --test tests/live/<folder>/<name>.test.ts`) before looking further. `pnpm test:all` runs the unit and live tests.
- `pnpm test:e2e`: the slow end-to-end install and first run.
- `pnpm eval:routing`, `pnpm eval:relay` and `pnpm eval:summary` run real models: they need API keys and cost a little. DEVELOPMENT.md, "Developing", says how each works.

Rules the tests keep, and your own tests should too:

- **Never your real tmux.** Every tmux server a test reaches has its socket in the run's own folder (`tests/setup.ts` sets `TMUX_TMPDIR`), never `-L kiko` or `-L kiko-dev`.
- **Never your real `claude`.** A real Claude Code in a test or a check by hand runs only through `scripts/isolated-claude.sh`, with a config folder of its own, so it never shows in your Kiko or leaves anything in `~/.claude`. Tests use fake agents (`tests/support/`).
- **Never real keys or settings.** The unit tests run with the Keychain off and no saved settings.

CI runs the typecheck, lint, format check and unit tests on Linux, and the Swift helpers' build and the macOS-only unit tests on macOS.

## Where things live

ARCHITECTURE.md, "Layout", has the full map. In short:

- `src/core/`: the app's logic (routing, summaries, settings, the safety gate). It never imports `src/platform/macos/`.
- `src/app/`: the running app, in parts, one per job.
- `src/agents/`: one adapter per coding agent. `src/terminals/`: one per place a session can be typed into (Kiko's tmux, Ghostty, iTerm, Terminal…).
- `src/platform/`: what Kiko needs from the Mac. `native/macos/`: the Swift helpers.
- `src/ui/`: the Ink TUI and the Kiko window.
- `hooks/`, `statusline/`: the scripts the agents run, by absolute path (don't move them).
- `protocol/`: the messages between Kiko and its apps.
- `tests/`: `unit/`, `live/`, `harness/`, `eval/`, and `support/` (the fakes and fixtures they share).
- `scripts/`: developer tools, not part of the app (`pnpm support`, `pnpm smoke`, the release build: [RELEASING.md](RELEASING.md)).

### Adding an agent or a terminal

Read "Agent and terminal adapters" in ARCHITECTURE.md first. An agent adapter implements `Agent` (`src/agents/types.ts`) and is listed in `src/agents/index.ts`. Its `support.ts` says how it stands on each feature (`src/agents/support.ts`), and `pnpm support` writes that into SUPPORT.md (a test fails while SUPPORT.md is out of date). A terminal adapter implements `src/terminals/types.ts` and is listed in `src/terminals/index.ts`. Test it against a fake of the program (see `tests/support/`), never the real one.

## Style

- **Formatting is Biome's** (`biome.json`: 2 spaces, double quotes, semicolons, trailing commas, lines up to 200). Run `pnpm format`; don't hand-format.
- **Match the code around you:** short plain comments that say why, names over abbreviations.
- **Words people see** (what Kiko says, shows or prints, and the docs) are plain, direct sentences. No emoji.
- **A behaviour change comes with a test:** a unit test where the logic can be reached, else a case in the harness.
- **A new feature** is declared for every agent (ARCHITECTURE.md, "Agent and terminal adapters", then `pnpm support`).

## Sending a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Make your change on a branch, with its tests, and update the docs it touches.
3. Run `pnpm check` (and `pnpm check:full` for a change to `src/`).
4. Open a pull request against `main` that says what changed, why, and how you tried it.

By sending a contribution, you agree that it's licensed under the project's [MIT license](LICENSE.md).

Questions: [support@kiko.sh](mailto:support@kiko.sh).
