// Settings → Phone → Pair a phone: the pairing QR code, drawn in the terminal over the whole settings
// screen (app/phone.ts pairPhone makes it; src/core/qr.ts draws it). Two modules per character cell,
// black on white whatever the terminal's theme, with the standard's quiet zone (4 modules) when the
// window has room, else 2. Under it what to do, how long it works, and the 6-digit code for a phone
// without a camera. Esc closes it (the settings screen's input). A phone paired: "✓ <name> paired".
// Before it, without Kiko Pro or the trial, the offer picked carried out (app/phone-offer.ts):
// signing in with its code, the trial starting, the checkout opened and the payment waited for.
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { NAME } from "../core/name.ts";
import { qrCells, qrFootprint, QUIET, type Qr, type QrCell } from "../core/qr.ts";
import type { PairQr, PlanStep } from "../core/ui-store.ts";

const h = React.createElement;

/** Dark and light modules: pure black and white (truecolor, or the 256-colour palette's own), never the theme's. */
const DARK = "#000000";
const LIGHT = "#ffffff";
/** Lines under the code: what to do, how long, the typed code. */
const TEXT_LINES = 3;

/** The quiet zone that fits in `width` × `height` (4, else 2), or null when even 2 doesn't. */
export function quietThatFits(qr: Qr, width: number, height: number): number | null {
  for (const quiet of [QUIET, 2]) {
    const f = qrFootprint(qr, quiet);
    if (f.columns <= width && f.rows + TEXT_LINES <= height) return quiet;
  }
  return null;
}

/** "482913" as "482 913", easier to read and type. */
const spacedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * One row of cells as runs of the same background: a handful of spans, not one per cell. A "▀" cell's
 * two modules differ, so its foreground is always the other colour from its background, and one
 * colour pair serves the whole run (a blank cell shows only its background).
 */
function row(cells: QrCell[], key: number) {
  const runs: { text: string; dark: boolean }[] = [];
  for (const c of cells) {
    const last = runs[runs.length - 1];
    if (last && last.dark === c.bg) last.text += c.ch;
    else runs.push({ text: c.ch, dark: c.bg });
  }
  return h(Text, { key }, ...runs.map((r, i) => h(Text, { key: i, color: r.dark ? LIGHT : DARK, backgroundColor: r.dark ? DARK : LIGHT }, r.text)));
}

/** The offer's step: what's happening, the code or link it needs, and Esc. */
export function planLines(p: PlanStep): React.ReactNode[] {
  const link = (url: string | null | undefined, opened: boolean | undefined) =>
    url ? h(Text, { key: "url", dimColor: true }, opened ? `Opened ${url.replace(/^https:\/\//, "").replace(/\?.*$/, "")} in your browser` : `Open this link: ${url}`) : null;
  switch (p.step) {
    case "sign-in":
      return [
        h(Text, { key: "what", bold: true }, `Sign in to your ${NAME} account first`),
        p.code
          ? h(Text, { key: "code" }, h(Text, { dimColor: true }, "Check this code in the browser: "), h(Text, { bold: true, color: "cyan" }, p.code))
          : h(Text, { key: "code", dimColor: true }, "Getting a code…"),
        link(p.url, p.opened),
      ].filter(Boolean);
    case "trial":
      return [h(Text, { key: "what", dimColor: true }, "Starting your free trial…")];
    case "checkout":
      return [h(Text, { key: "what", bold: true }, `${NAME} Pro: checkout`), link(p.url, p.opened) ?? h(Text, { key: "url", dimColor: true }, "Opening checkout in your browser…")].filter(Boolean);
    case "waiting":
      return [
        h(Text, { key: "what", bold: true }, "Waiting for payment…"),
        h(Text, { key: "then", dimColor: true }, "The QR code to pair your phone comes up as soon as it's through."),
        link(p.url, true),
      ].filter(Boolean);
    default:
      return [
        h(Text, { key: "why", color: "yellow" }, p.line ?? "That didn't go through."),
        h(Text, { key: "gap" }, " "),
        h(Text, { key: "again", dimColor: true }, "Esc closes; Pair a phone tries again."),
      ];
  }
}

export function PairPhone({ p, width, height }: { p: PairQr; width: number; height: number }) {
  // The countdown, once a second while it's up.
  const [, tick] = useState(0);
  useEffect(() => {
    if (p.phase !== "showing") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [p.phase]);

  const center = (...children: React.ReactNode[]) => h(Box, { flexDirection: "column", alignItems: "center", justifyContent: "center", width, height }, ...children);
  if (p.phase === "starting") return center(h(Text, { dimColor: true }, "Turning Phone on…"));
  if (p.phase === "paired") return center(h(Text, { color: "green", bold: true }, `✓ ${p.phone} paired`));
  if (p.phase === "plan") return center(...planLines(p));

  const left = Math.max(0, Math.ceil((p.until - Date.now()) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const code = p.code ? h(Text, { key: "code" }, h(Text, { dimColor: true }, "No camera? Code: "), h(Text, { bold: true }, spacedCode(p.code))) : null;
  const quiet = p.qr ? quietThatFits(p.qr, width, height) : null;
  if (!p.qr || quiet === null) {
    const need = p.qr ? qrFootprint(p.qr, 2) : null;
    return center(
      h(Text, { key: "why", color: "yellow" }, p.why ?? `Make this window bigger to show the QR code (it needs ${need!.columns}×${need!.rows + TEXT_LINES}; it has ${width}×${height}).`),
      h(Text, { key: "gap" }, " "),
      code ?? h(Text, { key: "code", dimColor: true }, "Pairing is closed: Settings → Phone → Pairing code opens a new code."),
      h(Text, { key: "left", dimColor: true }, `Works for ${clock} more, one phone · Esc closes`),
    );
  }
  const cells = qrCells(p.qr, quiet);
  return center(
    ...cells.map((r, i) => row(r, i)),
    h(Text, { key: "scan" }, `Scan with the ${NAME} app (or the iPhone Camera)`),
    h(Text, { key: "left", dimColor: true }, `Works for 5 minutes, one phone · ${clock} left · Esc closes`),
    code ?? h(Text, { key: "code", dimColor: true }, " "),
  );
}
