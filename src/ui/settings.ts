// The settings screen: the window's list pane zoomed to the whole window (tui.ts). On a wide terminal it has two columns: every
// setting, grouped, on the left, and the highlighted one's options and what it does on the right,
// updating as you move. On a narrow one the options replace the list when you open a setting.
// Changes are saved and applied by the app (a "set" action); the few that need a restart are
// applied when the screen closes. The dictionary's options are its entries: add, edit, remove;
// the pronunciation list's too: add, remove, hear one.
// "Test microphone" has a panel instead: the mic's level and what speech-to-text heard, live.
// "Pair a phone" covers the whole screen with its QR code (pair-phone.ts) until a phone pairs or Esc.
// `/` filters the list (filterSettings), as `/` searches the Ctrl+Space menu, with its matcher
// (menu-view.ts searchScore): a filter line at the top (`/ voi▏`), and from then on what's typed is
// the filter, never a setting's key; the sections with a match keep their headings, the others go.
// ↑ ↓ move among the matches, Enter (or →) opens the one chosen; Backspace edits it (with nothing
// left, it closes), Esc clears it (the whole list again, on the setting chosen), and Esc again closes.
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { micHeader } from "../core/mic-device.ts";
import { choicesFor, SETTING_ABOUT, SETTING_FACTS, SETTING_GROUPS, type Choice, type ChoiceSet } from "../core/settings-options.ts";
import { KEYS } from "../core/keys.ts";
import { nameWarning } from "../core/wake.ts";
import { searchScore } from "./menu-view.ts";
import { Meter } from "./meter.ts";
import { PairPhone } from "./pair-phone.ts";
import { ui, type SettingFact, type SettingRow, type UiState } from "../core/ui-store.ts";

const h = React.createElement;

const WIDE = 90; // columns needed for two columns

type Item = Choice<unknown> & { special?: "capture" | "path" | "add" | "key" | "name" };
/**
 * Typing in the options pane: a folder for new sessions, the name you call it, a dictionary entry (what's heard, then
 * what to write), a pronunciation (the word, then what to say), or an API key (never shown: dots,
 * and kept only here until Enter hands it to the app to check and save). A key for an option that
 * needs one (`pick`, its key `id`): the option is set once the key is saved; Esc leaves the setting as it was.
 */
type Typing = { for: "path" | "name" | "heard" | "write" | "word" | "say" | "key"; text: string; heard?: string; id?: string; pick?: Item };
type Line = { gap: true } | { heading: string } | { row: SettingRow };

/** What a setting is found by in the filter (`/`): its name, its value, its section's name, its note, its pane's values. */
const settingFinds = (row: SettingRow, section: string) => [row.label, row.value, section, row.note ?? "", ...(row.facts ?? []).map((f) => f.value)];

/**
 * The settings the filter shows, by section in the screen's order (a section with none left out):
 * those `query` matches (the Ctrl+Space menu's matcher, searchScore, on settingFinds), or all of
 * them with no filter (null) or nothing typed yet.
 */
export function filterSettings(rows: SettingRow[], query: string | null): { title: string; rows: SettingRow[] }[] {
  const found = (r: SettingRow, section: string) => query === null || settingFinds(r, section).some((words) => words.trim() !== "" && searchScore(query, words) !== null);
  return SETTING_GROUPS.map((g) => ({ title: g.title, rows: rows.filter((r) => g.keys.includes(r.key) && found(r, g.title)) })).filter((g) => g.rows.length > 0);
}

/** The slice of a list that fits, keeping the cursor in view. */
function windowAround<T>(list: T[], cursor: number, size: number) {
  const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), list.length - size));
  return { start, items: list.slice(start, start + size) };
}

/** How far a pane's label and value rows (SettingRow.facts) sit in from its edge. */
const FACT_INDENT = 2;

/** The labels' column: the longest label and two spaces (0 with no labels). */
const factLabelWidth = (facts: SettingFact[]) => {
  const longest = Math.max(0, ...facts.map((f) => f.label?.length ?? 0));
  return longest ? longest + 2 : 0;
};

/** `text` in lines at most `width` wide, broken between words (a word longer than a line, inside it). */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(" ").filter(Boolean)) {
    while (word.length > width) {
      if (line) lines.push(line);
      lines.push(word.slice(0, width));
      word = word.slice(width);
      line = "";
    }
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return line || !lines.length ? [...lines, line] : lines;
}

/**
 * A pane's label and value rows (SettingRow.facts, settings-options.ts SETTING_FACTS), the values in
 * one column as the list's are: the label as the list has it, the value plain (yellow when `warn`),
 * its `more` lines dim under it; a value too long for the pane wraps in its own column, never back
 * under the label. A fact without a label is a line across the pane. And how many lines they take.
 */
function factRows(facts: SettingFact[], width: number): { nodes: React.ReactNode[]; lines: number } {
  const labelWidth = factLabelWidth(facts);
  let lines = 0;
  const nodes = facts.map((f, i) => {
    const column = Math.max(10, width - FACT_INDENT - (f.label === undefined ? 0 : labelWidth));
    const value = wrapWords(f.value, column);
    const more = (f.more ?? []).flatMap((line) => wrapWords(line, column));
    lines += value.length + more.length;
    return h(
      Box,
      { key: `fact${i}`, paddingLeft: FACT_INDENT },
      f.label === undefined ? null : h(Box, { width: labelWidth, flexShrink: 0 }, h(Text, { wrap: "truncate-end" }, f.label)),
      h(
        Box,
        { flexDirection: "column", flexGrow: 1, flexShrink: 1 },
        ...value.map((line, j) => h(Text, { key: `v${j}`, color: f.warn ? "yellow" : f.ok ? "green" : undefined, wrap: "truncate-end" }, line)),
        ...more.map((line, j) => h(Text, { key: `m${j}`, dimColor: true, wrap: "truncate-end" }, line)),
      ),
    );
  });
  return { nodes, lines };
}

/**
 * A few lines of text in a setting's pane (its about, its note): in from the edge as the label and
 * value rows are, broken between words (each "\n" a line of its own, so a command never wraps), dim
 * or in a colour. And how many lines they take.
 */
function textLines(key: string, text: string, width: number, look: { dim?: boolean; color?: string }): { nodes: React.ReactNode[]; lines: number } {
  const lines = text.split("\n").flatMap((line) => wrapWords(line, Math.max(10, width - FACT_INDENT)));
  const nodes = lines.map((line, i) => h(Box, { key: `${key}${i}`, paddingLeft: FACT_INDENT }, h(Text, { dimColor: look.dim, color: look.color, wrap: "truncate-end" }, line)));
  return { nodes, lines: lines.length };
}

/** Where the options' hints start: after the longest label (and its "needs a key"), but never past `most`. */
function hintColumn(items: Array<{ label: string; needsKey?: unknown }>, most: number): number {
  return Math.max(0, ...items.map((item) => item.label.length + (item.needsKey ? NEEDS_KEY.length : 0)).filter((n) => n <= most));
}

/** The list's labels column: the longest label and two spaces, up to LIST_LABEL_MOST (a longer one is cut short). */
const LIST_LABEL_MOST = 30;
const listLabelWidth = (rows: SettingRow[]) => Math.min(LIST_LABEL_MOST, Math.max(0, ...rows.map((r) => r.label.length))) + 2;
const fitLabel = (label: string, width: number) => (label.length > width - 2 ? `${label.slice(0, width - 3).trimEnd()}…`.padEnd(width) : label.padEnd(width));

/** After an option whose key is missing (yellow). */
const NEEDS_KEY = " · needs a key";

/** The settings. `paused`: its keys wait (quitting's hint is up: tui.ts SettingsScreen). */
export function Settings({ s, width, height, paused = false }: { s: UiState; width: number; height: number; paused?: boolean }) {
  const rows = SETTING_GROUPS.flatMap((g) => g.keys.map((k) => s.settings.find((r) => r.key === k))).filter((r): r is SettingRow => Boolean(r));
  const wide = width >= WIDE;
  // Opened on a setting when asked to (the Kiko key, from a key clash's question), else the first.
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      rows.findIndex((r) => r.key === s.settingsAt),
    ),
  );
  // Opened for a key's paste (the window's offer of your own key: UiState settingsPaste): its row's options, the paste open.
  const pasting = Boolean(s.settingsPaste && s.settingsAt?.startsWith("key:") && rows.some((r) => r.key === s.settingsAt));
  const [focus, setFocus] = useState<"list" | "options">(pasting ? "options" : "list");
  const [loaded, setLoaded] = useState<{ for: string; set: ChoiceSet } | null>(null);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [typing, setTyping] = useState<Typing | null>(pasting ? { for: "key", text: "" } : null);
  // The list's filter (`/`): what's typed since, null while it's closed. (`filter` is a setting's options' search.)
  const [query, setQuery] = useState<string | null>(null);
  const tts = String(rows.find((r) => r.key === "tts")?.raw ?? "cartesia");
  const groups = filterSettings(rows, query);
  const matches = groups.flatMap((g) => g.rows);
  // The setting chosen: one the filter shows (the first when the one chosen isn't), none when nothing matches.
  const chosen = rows[Math.min(index, rows.length - 1)];
  const row = query === null ? chosen : (matches.find((r) => r.key === chosen?.key) ?? matches[0]);

  // The options on show: the highlighted setting's on a wide screen, the opened one's on a narrow one.
  const shown = row && (wide || focus === "options") ? row : null;
  // The mic's options change as devices come and go.
  const loadKey = shown ? `${shown.key}|${tts}|${String(shown.raw)}${shown.key === "mic" ? `|${JSON.stringify(s.micDevices)}` : ""}` : "";
  const set = loaded && loaded.for === loadKey ? loaded.set : null;

  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    void choicesFor(shown.key, {
      tts,
      current: shown.raw,
      currentLabel: shown.value,
      micDevices: s.micDevices,
      mic: s.mic?.wanted ?? null,
    }).then((choices) => {
      if (cancelled) return;
      // The same setting's options again (a dictionary entry added or removed): stay where you were.
      const again = loaded?.for.startsWith(`${shown.key}|`) && (choices.dictionary || choices.pronunciation);
      setLoaded({ for: loadKey, set: choices });
      setFilter("");
      setCursor((c) =>
        again
          ? Math.min(c, choices.choices.length)
          : Math.max(
              0,
              choices.choices.findIndex((x) => x.value === shown.raw),
            ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  const needle = filter.toLowerCase();
  const items: Item[] = set
    ? [
        ...(set.apiKey && !filter ? [{ value: "", label: "Enter a key…", hint: `checked with ${set.apiKey}, then kept in the Keychain`, special: "key" as const }] : []),
        ...(set.capture && !filter ? [{ value: "", label: "Press the key you want…", special: "capture" as const }] : []),
        ...((set.dictionary || set.pronunciation) && !filter ? [{ value: "", label: "Add a word…", special: "add" as const }] : []),
        ...set.choices.filter((c) => !needle || `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(needle)),
        ...(set.path && !filter ? [{ value: "", label: "Type a path…", special: "path" as const }] : []),
        ...(set.name && !filter ? [{ value: "", label: "Type a name…", special: "name" as const }] : []),
      ]
    : [];

  /** The highlight `by` settings up (−1) or down (1), over those the filter shows. */
  const moveList = (by: number) => {
    const at = matches.findIndex((r) => r.key === row?.key);
    const next = matches[Math.max(0, Math.min(matches.length - 1, at + by))];
    if (next) setIndex(rows.indexOf(next));
  };
  /** The filter typed: the first setting it finds chosen (as the menu's search chooses its first result). */
  const narrow = (next: string) => {
    setQuery(next);
    const first = filterSettings(rows, next)[0]?.rows[0];
    if (first) setIndex(rows.indexOf(first));
  };

  const backToList = () => {
    setFocus("list");
    setFilter("");
    setCursor(Math.max(0, set?.choices.findIndex((c) => c.value === row?.raw) ?? 0));
  };

  useInput(
    (input, key) => {
      // Pair a phone's QR code is up: Esc (or q) closes it, and nothing else does anything.
      if (s.pairQr) {
        if (key.escape || input === "q") ui.act({ type: "set", key: "phonePair", value: "close" });
        return;
      }
      if (s.capturing) return;
      // The filter's open: what's typed goes into it, never to a setting's own keys (j, k, q, s…).
      if (focus === "list" && query !== null) {
        if (key.escape) return setQuery(null);
        if (key.backspace || key.delete) return query ? narrow([...query].slice(0, -1).join("")) : setQuery(null);
        if (key.upArrow) return moveList(-1);
        if (key.downArrow) return moveList(1);
        if (!key.return && !key.rightArrow) {
          // One character (or a paste), without control ones; Ctrl or ⌘ with a key types nothing.
          const typed = key.ctrl || key.meta ? "" : input.replace(/\p{C}/gu, "");
          if (typed) narrow(query + typed);
          return;
        }
        // Enter or →: the setting chosen, as without a filter (below).
      } else if (focus === "list" && input === "/" && !key.ctrl && !key.meta) {
        return setQuery("");
      }
      if (!row) return;
      if (typing !== null) {
        if (key.escape) return setTyping(null);
        if (key.return) {
          const text = typing.text.trim();
          if (typing.for === "key") {
            if (!text) return;
            const pick = typing.pick;
            const then = pick ? { key: row.key, value: pick.value, label: pick.label } : undefined;
            ui.act({ type: "apiKey", id: typing.id ?? row.key.slice("key:".length), key: text, ...(then ? { then } : {}) });
            setTyping(null);
            return backToList();
          }
          if (typing.for === "path") {
            ui.act({ type: "set", key: row.key, value: text });
            setTyping(null);
            return backToList();
          }
          if (typing.for === "name") {
            if (!text) return;
            ui.act({ type: "set", key: row.key, value: text });
            setTyping(null);
            return backToList();
          }
          if (!text) return;
          if (typing.for === "heard") return setTyping({ for: "write", text: "", heard: text });
          if (typing.for === "word") return setTyping({ for: "say", text: "", heard: text });
          if (typing.for === "say") ui.act({ type: "pronunciation", op: "add", word: typing.heard!, say: text });
          else ui.act({ type: "dictionary", op: "add", heard: typing.heard!, write: text });
          return setTyping(null);
        }
        if (key.backspace || key.delete) return setTyping((t) => t && { ...t, text: t.text.slice(0, -1) });
        // A key: pasted, so only what a key is made of (no spaces, line ends or escapes).
        const typed = typing.for === "key" ? input.replace(/[^\x21-\x7e]/g, "") : input;
        if (typed && !key.ctrl && !key.meta) setTyping((t) => t && { ...t, text: t.text + typed });
        return;
      }
      if (focus === "list") {
        if (key.escape || input === "q" || input === "s") return ui.act({ type: "closeSettings" });
        if (key.upArrow || input === "k") return moveList(-1);
        if (key.downArrow || input === "j") return moveList(1);
        if (key.return || key.rightArrow) setFocus("options");
        // Enter on "Test microphone" starts it at once; on "Pair a phone", its QR code shows (without
        // Kiko Pro or the trial, its PRO badge: the offer's choices open instead, as any setting's).
        if (key.return && row.key === "micTest") ui.act({ type: "micTest" });
        if (key.return && row.key === "phonePair" && !row.tag) {
          setFocus("list");
          return ui.act({ type: "set", key: "phonePair", value: "open" });
        }
        return;
      }
      if (key.escape || key.leftArrow) {
        if (filter) return setFilter("");
        // Something under way that Esc stops (Settings → Account's sign-in): stopped, the pane kept.
        if (key.escape && set?.escape !== undefined) return ui.act({ type: "set", key: row.key, value: set.escape });
        return backToList();
      }
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(items.length - 1, c + 1));
      const item = items[cursor];
      // A dictionary entry: d (or delete) takes it out.
      if (set?.dictionary && item && !item.special && (input === "d" || key.backspace || key.delete)) {
        return ui.act({ type: "dictionary", op: "remove", heard: String(item.value) });
      }
      // A pronunciation: d (or delete) takes yours out or turns a built-in one off; tab or enter says it.
      if (set?.pronunciation && item && !item.special) {
        if (input === "d" || key.backspace || key.delete) return ui.act({ type: "pronunciation", op: "remove", id: String(item.value) });
        if (key.tab || key.return) return ui.act({ type: "pronunciation", op: "test", id: String(item.value) });
      }
      if (key.tab && set?.previewable && item && !item.special) {
        return ui.act({ type: "preview", value: String(item.value), label: item.label });
      }
      if (key.return && item) {
        if (set?.test) return ui.act({ type: "micTest" });
        if (item.special === "capture") {
          ui.act({ type: "captureKey" });
          return backToList();
        }
        if (item.special === "path") return setTyping({ for: "path", text: "" });
        if (item.special === "name") return setTyping({ for: "name", text: "" });
        if (item.special === "key") return setTyping({ for: "key", text: "" });
        if (item.special === "add") return setTyping({ for: set?.pronunciation ? "word" : "heard", text: "" });
        // Enter on an entry changes what it writes.
        if (set?.dictionary) return setTyping({ for: "write", text: item.label.slice(String(item.value).length + 3), heard: String(item.value) });
        // An option whose key is missing: the key first, then it's set.
        if (item.needsKey) return setTyping({ for: "key", text: "", id: item.needsKey, pick: item });
        ui.act({ type: "set", key: row.key, value: item.value, label: item.label });
        return backToList();
      }
      if (set?.searchable) {
        if (key.backspace || key.delete) return setFilter((f) => f.slice(0, -1));
        if (input && /^[\x20-\x7e]+$/.test(input) && !key.ctrl && !key.meta) {
          setFilter((f) => f + input);
          setCursor(0);
        }
      }
    },
    { isActive: s.screen === "settings" && !paused },
  );

  const inner = { width: width - 4, height: Math.max(3, height - 4) }; // inside the border, title and hints

  /** Every setting (or those the filter finds, under its line), under its section's heading. */
  function list(paneWidth: number) {
    const lines: Line[] = [];
    for (const group of groups) {
      if (lines.length) lines.push({ gap: true });
      lines.push({ heading: group.title });
      for (const r of group.rows) lines.push({ row: r });
    }
    const labelWidth = listLabelWidth(rows);
    const selected = lines.findIndex((l) => "row" in l && l.row.key === row?.key);
    // The filter's line, as the menu's search line: `/`, what's typed, the cursor while typing goes there.
    const head =
      query === null
        ? []
        : [
            h(Text, { key: "filter", wrap: "truncate-end" }, h(Text, { color: "cyan", bold: true }, "/"), " ", h(Text, { bold: true }, query), focus === "list" ? "▏" : ""),
            ...(lines.length ? [] : [h(Text, { key: "none", dimColor: true, wrap: "truncate-end" }, `No settings match “${query}”`)]),
          ];
    const { start, items: visible } = windowAround(lines, selected, Math.max(1, inner.height - head.length));
    return h(
      Box,
      { flexDirection: "column", width: paneWidth, flexShrink: 0 },
      ...head,
      ...visible.map((line, i) => {
        if ("gap" in line) return h(Text, { key: `g${start + i}` }, " ");
        if ("heading" in line) {
          return h(Text, { key: `h${start + i}`, bold: true, color: "gray", wrap: "truncate-end" }, line.heading.toUpperCase());
        }
        const on = line.row.key === row?.key;
        const lit = on && focus === "list";
        return h(
          Text,
          { key: line.row.key, wrap: "truncate-end" },
          h(Text, { color: "cyan", dimColor: !lit }, on ? "▸ " : "  "),
          h(Text, { bold: on }, fitLabel(line.row.label, labelWidth)),
          h(Text, { color: on ? "cyan" : undefined, dimColor: !on }, line.row.value),
          // A short mark after it (Pair a phone's PRO), in the yellow the options' "needs a key" has.
          line.row.tag ? h(Text, { color: "yellow", bold: true }, ` ${line.row.tag}`) : null,
          line.row.restart ? h(Text, { dimColor: true }, " ↻") : null,
          // Its note after it, on a narrow screen (not beside a mark: Pair a phone's PRO says it, and its pane has the offer).
          !wide && line.row.note && !line.row.tag ? h(Text, { color: "yellow" }, `  ${line.row.note}`) : null,
        );
      }),
    );
  }

  /**
   * The highlighted setting: what it does (a line or two, dim), its label and value rows, its note
   * (yellow), whether it restarts the app, then its options. All in from the edge by the same two
   * columns, wrapped between words.
   */
  function options(paneWidth: number) {
    if (!row) return null;
    const about = SETTING_ABOUT[row.key] ?? "";
    const facts = [...(SETTING_FACTS[row.key] ?? []), ...(row.facts ?? [])];
    const active = focus === "options";
    const top: React.ReactNode[] = [];
    let used = 0;
    const add = (part: { nodes: React.ReactNode[]; lines: number }) => {
      top.push(...part.nodes);
      used += part.lines;
    };
    if (wide) {
      top.push(h(Text, { key: "label", bold: true }, row.label));
      used++;
    }
    // A row with a mark (Pair a phone's PRO): its note, the offer, first.
    const noteFirst = Boolean(row.tag && row.note);
    if (noteFirst) add(textLines("note", row.note!, paneWidth, { color: "yellow" }));
    if (about) add(textLines("about", about, paneWidth, { dim: true }));
    if (facts.length) add(factRows(facts, paneWidth));
    if (row.note && !noteFirst) add(textLines("note", row.note, paneWidth, { color: "yellow" }));
    if (row.detail) add(textLines("detail", row.detail, paneWidth, { dim: true }));
    if (row.restart) add(textLines("restart", "↻ restarts the app when you close settings", paneWidth, { dim: true }));
    top.push(h(Text, { key: "gap" }, " "));
    used++;

    let body: React.ReactNode[];
    if (s.capturing) {
      body = [h(Text, { key: "capture", color: "yellow" }, "Press the key you want to hold while talking…")];
    } else if (typing !== null) {
      const ask = {
        path: "Folder for new sessions:",
        name: "What do you want to call it?",
        heard: "What speech-to-text writes:",
        write: `What “${typing.heard}” should be:`,
        word: "The word, as it's written:",
        say: `How to say “${typing.heard}”, for the voice in use:`,
        key: typing.pick ? `${typing.pick.label} needs your ${KEYS.find((k) => k.id === typing.id)?.name} key (paste it; it stays hidden):` : `Your ${row.label} key (paste it; it stays hidden):`,
      }[typing.for];
      const example = { path: "~/git/my-project", name: "Jarvis", heard: "clip kit", write: "clipkit", word: "nginx", say: "engine-x", key: "paste it here" }[typing.for];
      // A key is never drawn: a dot for each character, up to a line's worth.
      const shown = typing.for === "key" ? "•".repeat(Math.min(typing.text.length, 40)) : typing.text;
      body = [
        h(Text, { key: "ask" }, ask),
        typing.text ? h(Text, { key: "typed", color: "cyan" }, `${shown}▏`) : h(Text, { key: "typed", dimColor: true }, `▏ ${typing.for === "key" ? example : `e.g. ${example}`}`),
      ];
      // A name likely to wake it by accident: said, not refused.
      const warning = typing.for === "name" && typing.text.trim() ? nameWarning(typing.text.trim()) : null;
      if (warning) body.push(h(Text, { key: "warn", color: "yellow" }, warning));
    } else if (set?.test) {
      body = [
        ...micTestPanel(s),
        ...items.map((item, i) => {
          const at = active && i === cursor;
          const label = s.micTest?.phase === "done" ? "Test again" : item.label;
          return h(
            Text,
            { key: `o${i}`, wrap: "truncate-end", dimColor: !active || Boolean(s.micTest && s.micTest.phase !== "done") },
            h(Text, { color: "cyan" }, at ? "▸ " : "  "),
            h(Text, { bold: at }, label),
          );
        }),
      ];
    } else if (!set) {
      body = [h(Text, { key: "loading", dimColor: true }, row.key === "voice" ? "Loading voices…" : " ")];
    } else {
      body = [];
      if (set.searchable && active) {
        body.push(h(Text, { key: "search", dimColor: !filter }, filter ? `search: ${filter}▏` : "type to search"));
        used++;
      }
      // Nothing to choose (Connect to, with Phone off): what its row says instead.
      if (!items.length) body.push(h(Text, { key: "none", dimColor: true, wrap: "truncate-end" }, filter ? "Nothing matches." : `    ${row.value}`));
      const { start, items: visible } = windowAround(items, cursor, Math.max(1, inner.height - used));
      // The hints in one column, after the labels (a label too long for it: two spaces after its own).
      const hintAt = hintColumn(items, Math.floor((paneWidth - 4) * 0.6));
      body.push(
        ...visible.map((item, i) => {
          const at = active && start + i === cursor;
          const current = !item.special && item.value === row.raw;
          return h(
            Text,
            { key: `o${start + i}`, wrap: "truncate-end", dimColor: !active && !current },
            h(Text, { color: "cyan" }, at ? "▸ " : "  "),
            h(Text, { color: "green" }, current ? "● " : "  "),
            h(Text, { bold: at, color: item.special ? "yellow" : undefined }, item.label),
            item.needsKey ? h(Text, { color: "yellow" }, NEEDS_KEY) : null,
            item.hint ? h(Text, { dimColor: true }, `${" ".repeat(Math.max(0, hintAt - item.label.length - (item.needsKey ? NEEDS_KEY.length : 0)))}  ${item.hint}`) : null,
          );
        }),
      );
    }
    return h(Box, { flexDirection: "column", width: paneWidth }, ...top, ...body);
  }

  // Pair a phone: its QR code over the whole screen, inside the frame.
  if (s.pairQr) {
    return h(
      Box,
      { flexDirection: "column", flexGrow: 1, height, borderStyle: "round", borderColor: "cyan", paddingX: 1 },
      h(Box, { height: 1 }, h(Text, { bold: true }, "Settings › Pair a phone")),
      h(PairPhone, { p: s.pairQr, width: inner.width, height: inner.height }),
      h(Text, { dimColor: true, wrap: "truncate-end" }, s.pairQr.phase === "paired" ? " " : "esc close"),
    );
  }

  let content: React.ReactNode;
  let hints: string;
  const choosing =
    typing !== null
      ? `enter ${typing.for === "heard" || typing.for === "word" ? "next" : typing.for === "key" ? "check and save" : "save"} · esc cancel`
      : set?.dictionary
        ? "↑↓ move · enter add or edit · d remove · esc back"
        : set?.pronunciation
          ? "↑↓ move · enter or tab hear it · d remove or turn off · esc back"
          : set?.test
            ? "enter test · esc back"
            : `↑↓ move · enter choose${set?.previewable ? " · tab hear it" : ""}${set?.searchable ? " · type to search" : ""} · esc back`;
  if (wide) {
    // As wide as the longest label and value need, up to half the screen.
    const labelWidth = listLabelWidth(rows);
    const natural = 2 + labelWidth + Math.max(...rows.map((r) => r.value.length + (r.restart ? 2 : 0) + (r.tag ? r.tag.length + 1 : 0)));
    const left = Math.min(natural, Math.floor(inner.width / 2));
    content = h(
      Box,
      { flexDirection: "row", flexGrow: 1 },
      list(left),
      h(Box, { borderStyle: "single", borderTop: false, borderRight: false, borderBottom: false, borderColor: "gray", paddingLeft: 2, marginLeft: 1, flexGrow: 1 }, options(inner.width - left - 4)),
    );
    hints = focus === "options" ? choosing : `${query === null ? "/ filter · " : ""}↑↓ move · enter or → choose · ${query === null ? "esc close" : "esc clears"} · ↻ restarts the app`;
  } else if (focus === "options" || s.capturing) {
    content = options(inner.width);
    hints = choosing;
  } else {
    content = list(inner.width);
    hints = `${query === null ? "/ filter · " : ""}↑↓ move · enter change · ${query === null ? "esc close" : "esc clears"} · ↻ restarts the app`;
  }
  if (s.capturing) hints = "";

  return h(
    Box,
    { flexDirection: "column", flexGrow: 1, height, borderStyle: "round", borderColor: "cyan", paddingX: 1 },
    h(
      Box,
      { justifyContent: "space-between", height: 1 },
      h(Text, { bold: true }, !wide && focus === "options" && row ? `Settings › ${row.label}` : "Settings"),
      s.restartPending ? h(Text, { color: "yellow" }, "restarts when you close settings") : null,
    ),
    h(Box, { flexDirection: "column", flexGrow: 1 }, content),
    h(Text, { dimColor: true, wrap: "truncate-end" }, hints),
  );
}

/**
 * The mic test's panel: which mic, then its level while it listens, and what speech-to-text heard
 * (live, then final). Says plainly when nothing came in.
 */
function micTestPanel(s: UiState): React.ReactNode[] {
  const mic = micHeader(s.mic);
  const lines: React.ReactNode[] = [h(Text, { key: "mic", color: mic.warn ? "yellow" : undefined, wrap: "truncate-end" }, mic.text || "🎙 …")];
  const t = s.micTest;
  if (!t) return [...lines, h(Text, { key: "testGap" }, " ")];
  const left = Math.max(0, Math.ceil((t.until - Date.now()) / 1000));
  const doing = t.phase === "listening" ? `listening… ${left}s, say something` : t.phase === "finishing" ? "turning it into text…" : "done";
  lines.push(h(Box, { key: "level", gap: 1 }, h(Meter, { level: t.phase === "listening" ? t.level : 0 }), h(Text, { dimColor: true }, doing)));
  if (t.heard) lines.push(h(Text, { key: "heard" }, h(Text, { dimColor: true }, "heard: "), h(Text, { color: "cyan" }, `“${t.heard}”`)));
  else if (t.phase === "done") lines.push(h(Text, { key: "heard", color: "yellow" }, t.error ? `Speech-to-text failed: ${t.error}` : "Heard nothing."));
  // Barely a flicker the whole time: likely the wrong mic, or muted.
  if (t.phase === "done" && t.peak < 0.2) lines.push(h(Text, { key: "quiet", color: "yellow" }, "Almost no sound came in: is it the right mic, and not muted?"));
  return [...lines, h(Text, { key: "testGap" }, " ")];
}
