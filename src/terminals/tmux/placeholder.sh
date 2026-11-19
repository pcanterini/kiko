#!/bin/sh
# What an empty spot of the Kiko window shows (./window.ts): in the session area only until the
# app puts Kiko's page there, or while the app isn't running. One of these moves between the
# window's session area and the window a session shown there came from (its "home"), so it asks
# tmux where it is now, and again whenever it's resized or restarted: in the Kiko window, how to
# fill the spot; in a session's home, where that session went. $1: tmux's path. tmux finds its
# server and this pane from $TMUX and $TMUX_PANE, which it sets. $2: what the app's options start
# with on this server (tmux.ts appOption: @kiko). $3: the app's title (Kiko, Kiko Dev).
#
# While the app is starting (the window's starting option: window.ts setStarting), the Kiko
# window's spot says that instead, and what it's doing now when that's known; whoever changes it
# sends a SIGWINCH, so it's drawn again then, as on a resize.
tmux=$1
opt=${2:-@kiko}
title=${3:-Kiko}
stty -echo -icanon -isig 2>/dev/null
# Nothing but the drawing on the screen: bash says on stderr each time it kills the nap below.
exec 2>/dev/null
trap '' INT QUIT TSTP

draw() {
  printf '\033[?25l\033[H\033[2J'
  view=$("$tmux" display -p -t "$TMUX_PANE" "#{$opt-view}" 2>/dev/null)
  starting=$("$tmux" display -p -t "$TMUX_PANE" "#{$opt-starting}" 2>/dev/null | tr -d '[:cntrl:]')
  if [ "$view" = 1 ] && [ -n "$starting" ]; then
    printf '\n  %s\n' "$title is starting…"
    # ${starting}, braced: macOS's /bin/sh (bash 3.2) in a UTF-8 locale takes a non-ASCII byte
    # for part of a name: the bare name with "…" right after it read as the unset $starting\342,
    # leaving only the rest of the "…" (two broken bytes, drawn as two "?"). A name right before
    # non-ASCII text is always braced (tests/unit/terminals/starting.test.ts checks every script).
    [ "$starting" != 1 ] && printf '  \033[2m%s\033[0m\n' "${starting}…"
  elif [ "$view" = 1 ]; then
    printf '\n  \033[1m%s\033[0m\n\n' "Kiko"
    printf '  %s\n' "No session shown here." ""
    printf '  %s\n' "Pick one in the list on the left: click it," "or ↑ ↓ and Enter." ""
    printf '  %s\n' "Start one: n in the list, kiko claude in a" "project's folder, or say “open a new session in …”." ""
    key=$("$tmux" display -p -t "$TMUX_PANE" "#{$opt-key-name}" 2>/dev/null | tr -d '[:cntrl:]')
    # The classic look (./classic.ts) has no ☰ button: the footer's menu words are its button.
    if [ "$("$tmux" display -p -t "$TMUX_PANE" "#{$opt-look}" 2>/dev/null)" = classic ]; then
      button="or click “${key:-⌃Space} menu” at the bottom right."
    else
      button="or click ☰ Kiko at the bottom."
    fi
    printf '  \033[2m%s\033[0m\n' "${key:-⌃Space}: the Kiko menu, from anywhere in the window," "$button"
  else
    printf '\n  %s\n  \033[2m%s\033[0m\n' "This session is shown in the Kiko window." "Run kiko to see it there."
  fi
}

# A resize or a change (SIGWINCH) only asks for a draw; the loop draws. Closed or stopped: the
# nap goes too (tmux signals the pane's whole group anyway).
redraw=1
trap 'redraw=1' WINCH
trap 'kill "$sleeper" 2>/dev/null; exit 0' HUP TERM
naps=0
while :; do
  if [ "$redraw" = 1 ]; then
    naps=0
    while [ "$redraw" = 1 ]; do
      redraw=0
      draw
    done
  fi
  # Wait for a signal: `wait` returns at once for a trapped one, and the nap goes. macOS's
  # /bin/sh (bash 3.2) misses one that comes just before `wait` starts (it's kept, and run once
  # the nap ends), and changes come in bursts (the starting steps, a resize): so 1s naps for a
  # while after each draw, then a minute's. The nap holds none of the pane's files: if it's left
  # behind (a child being started just as its group is killed can miss the signal, on macOS),
  # nothing reading the pane waits on it (the unit tests' pipe did, for the day it once slept).
  if [ "$naps" -lt 10 ]; then nap=1; else nap=60; fi
  naps=$((naps + 1))
  sleep "$nap" </dev/null >/dev/null 2>&1 &
  sleeper=$!
  [ "$redraw" = 1 ] || wait "$sleeper"
  kill "$sleeper" 2>/dev/null
done
