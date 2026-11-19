// A pretend tmux for the harness: never the real one. T.tmux unset (the default): not installed, so
// Ghostty opens and types as it did before tmux. T.tmux = { panes, procs }: installed, with these
// panes ({ id, pid, tty, inMode, session, cwd, paste?, role? }) and processes (as `ps` lists them).
// Words typed (a buffer pasted, if tmux's check of the pane holds) go to T.typed ({ terminalId: pane, text }), keys other than Enter to T.keys, Enter to T.tmux.entered,
// new sessions to T.opened ({ via: "tmux", cwd, command, session }) and to T.tmux.panes.
// T.tmux = { fake }: everything goes to that pretend server instead (the Kiko window's cases).
// T.tmux.paneIds: new-session tells the new pane's id (-P), as tmux does; T.tmux.screens: what each
// pane shows (capture-pane); a key pressed into a pane it opened (if-shell … send-keys, its check
// holding), or into a listed session's (send-keys), goes to T.keys and T.tmux.onKey(pane, key).
// T.tmux.global: global options show-options reads ({ "@kiko-new-agent": "codex" }: `kiko codex` ran).
export * from "../../../../../src/terminals/tmux/tmux.ts";

const T = () => (globalThis as any).T;

export function tmuxPath() {
  return T()?.tmux ? "/fake/bin/tmux" : null;
}

export async function processes() {
  return T().tmux.procs;
}

export function tmuxRunner() {
  return async (args: string[], input?: string): Promise<string> => {
    const x = T().tmux;
    if (!x) throw new Error("tmux isn't installed");
    (x.calls ??= []).push(args);
    // T.tmux.fake (tests/support/fake-tmux.ts): a whole pretend server, for the Kiko window.
    if (x.fake) return x.fake.run(args, input);
    const pane = args.includes("-t") ? args[args.indexOf("-t") + 1] : "";
    switch (args[0]) {
      case "list-panes":
        return x.panes
          .map((p: any) => [p.id, p.pid, p.tty, p.inMode ? 1 : 0, 0, p.paste === false ? 0 : 1, p.role ?? "", p.session, p.command ?? "claude", p.title ?? "", p.cwd].join("\t"))
          .join("\n");
      case "list-sessions":
        return x.panes.map((p: any) => p.session).join("\n");
      case "copy-mode":
        for (const p of x.panes) if (p.id === pane) p.inMode = false;
        return "";
      case "send-keys":
        if (args.includes("-l")) T().typed.push({ terminalId: pane, text: args.at(-1) });
        else if (args.at(-1) === "Enter") (x.entered ??= []).push(pane);
        else {
          T().keys.push({ terminalId: pane, key: args.at(-1) });
          // A listed session's key (Shift+Tab's BTab, core/block-override.ts): its pane may redraw.
          x.onKey?.(pane, args.at(-1));
        }
        return "";
      case "load-buffer":
        (x.buffers ??= {})[args[args.indexOf("-b") + 1]] = input;
        return "";
      case "delete-buffer": {
        const name = args[args.indexOf("-b") + 1];
        if (!(name in (x.buffers ?? {}))) throw new Error(`unknown buffer: ${name}`);
        delete x.buffers[name];
        return "";
      }
      case "capture-pane":
        return x.screens?.[pane] ?? "";
      case "if-shell": {
        // tmux's check as it pastes: the pane's first process and what's in front the same, bracketed paste still asked for.
        const [cond, command] = args.slice(4);
        const p = x.panes.find((q: any) => q.id === pane);
        const pid = /#\{==:#\{pane_pid\},(\d+)\}/.exec(cond)?.[1];
        const front = /#\{==:#\{pane_current_command\},((?:[^#}]|#.)*)\}/.exec(cond)?.[1]?.replace(/#(.)/g, "$1");
        const ok = p && String(p.pid) === pid && (p.command ?? "claude") === front && (!cond.includes("bracket_paste_flag") || p.paste !== false);
        const key = /^send-keys -t (%\d+) (\w+)$/.exec(command);
        if (key) {
          if (ok) {
            T().keys.push({ terminalId: pane, key: key[2] });
            x.onKey?.(pane, key[2]);
          }
          return "";
        }
        const buffer = / -b (\S+) /.exec(command)?.[1] ?? "";
        if (ok && buffer in (x.buffers ?? {})) {
          T().typed.push({ terminalId: pane, text: x.buffers[buffer] });
          delete x.buffers[buffer];
        }
        return "";
      }
      case "new-session": {
        const session = args[args.indexOf("-s") + 1];
        const cwd = args[args.indexOf("-c") + 1];
        T().opened.push({ via: "tmux", cwd, command: args.at(-1), session });
        const id = `%${x.panes.length + 100}`;
        x.panes.push({ id, pid: 9000 + x.panes.length, tty: "/dev/ttys900", inMode: false, session, cwd });
        return x.paneIds ? `${id}\n` : "";
      }
      case "show-options":
        // T.tmux.global: the server's global options (the run's agent for new sessions: window.ts NEW_AGENT_OPTION).
        return x.global?.[args.at(-1)!] ?? "";
      default:
        return "";
    }
  };
}
