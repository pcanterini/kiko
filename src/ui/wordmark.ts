// Kiko's own row at the top of the window's list (./window-list.ts): the brand's periwinkle square as
// its icon, in the icon column every session's agent mark has (marks.ts MARK_SLOT), then "Kiko" bold
// in the site's pale text colour (logo.ts BRAND), its name in the names' column like every row's. The
// site's mark (kiko.sh .brand-dot) is "a small rounded square in the accent colour, on the baseline",
// 0.22em: ▪ (U+25AA) is that square at terminal size (in Fira Mono 0.29em, on the baseline; Menlo
// 0.39em), where ■ (U+25A0) fills the cell (0.54em in Fira Mono, 0.59em in Menlo), reads as a block
// cursor (worse pulsing) and is close to OpenCode's ▣. ▪ is one cell as Ink counts it (East Asian
// width ambiguous, narrow, as ■'s) and a text glyph (no emoji presentation without U+FE0F), in every
// macOS terminal font checked (Fira Mono, Menlo, Meslo). It stays with the Nerd Font icons setting on
// too: it's the brand's mark, and it takes the slot's cells as a Nerd Font icon does. Narrow, the
// row gives way as the others do: the name cut with "…" (Ink's truncate-end), the square kept.
//
// The square is Kiko's state: steady while it's idle, a gentle pulse while it listens (the talk key
// held, or hands-free taking your words) or speaks. The pulse steps it between the accent and the
// shades either side of it on the brand's indigo ramp, PULSE_MS a step (2.5 a second), never off or
// far from the accent, so it breathes rather than blinks. Only in truecolor: in xterm's 256 the three
// shades are too coarse to step gently, so it stays the accent's nearest; with no colour (NO_COLOR,
// TERM=dumb: cli-style.ts colorDepth) it's a plain ▪ and the name only bold. The splash
// (./splash.ts) has the whole pane while it shows, so there's no row under it.
//
// Cheap to keep going: the pulse is the square's own state on a timer of its own (a Clock, so a test
// moves it by hand), so a step re-renders the square and nothing else, and the timer runs only while
// it pulses.
import React, { memo, useEffect, useState } from "react";
import { Text } from "ink";
import { realClock, type Clock } from "../core/clock.ts";
import { NAME } from "../core/name.ts";
import type { UiState } from "../core/ui-store.ts";
import type { ColorDepth } from "./cli-style.ts";
import { BRAND, hexTo256 } from "./logo.ts";
import { slotted } from "./marks.ts";

const h = React.createElement;

/** Kiko's icon on its row: the brand's square (above: why ▪). */
export const KIKO_SQUARE = "▪";

/** How long the square keeps each shade while it pulses. */
export const PULSE_MS = 400;

/** The square's shades while it pulses, one a step, round and round: the accent, a lighter one, the accent, a darker one (indigo ramp 3, 2, 3, 4). */
export const PULSE = [BRAND.indigo[3], BRAND.indigo[2], BRAND.indigo[3], BRAND.indigo[4]] as const;

/** Whether the square pulses: Kiko listening (the talk key held, hands-free taking your words) or speaking out loud (not muted). */
export const wordmarkPulses = (s: Pick<UiState, "listening" | "speaking" | "muted">): boolean => s.listening || (s.speaking && !s.muted);

/** A colour as Ink takes it at `depth`: the hex in truecolor, xterm's nearest in 256, none without colour. */
const inDepth = (hex: string, depth: ColorDepth): string | undefined => (depth === 24 ? hex : depth === 256 ? `ansi256(${hexTo256(hex)})` : undefined);

/** The square's colour `step` steps into a pulse (`pulsing`), or steady (the accent); none without colour. */
export function squareColor(depth: ColorDepth, pulsing: boolean, step: number): string | undefined {
  const shade = pulsing && depth === 24 ? PULSE[step % PULSE.length] : BRAND.accent;
  return inDepth(shade, depth);
}

type SquareProps = {
  /** Pulsing (wordmarkPulses), else steady. */
  pulsing: boolean;
  /** The terminal's colours (cli-style.ts colorDepth). */
  depth: ColorDepth;
  /** The pulse's time (tests/support/clock.ts FakeClock in a test). */
  clock?: Clock;
};

/** The square alone, pulsing while Kiko listens or speaks. Memoised: the list re-rendering leaves it be unless its props change. */
export const KikoSquare = memo(function KikoSquare({ pulsing, depth, clock = realClock }: SquareProps) {
  const steps = pulsing && depth === 24;
  const [step, setStep] = useState(0);
  useEffect(() => {
    // Steady: back to the accent. Pulsing: the next shade every PULSE_MS, from the accent.
    setStep(0);
    if (!steps) return;
    let timer: unknown = null;
    const next = () => {
      setStep((n) => (n + 1) % PULSE.length);
      timer = clock.setTimeout(next, PULSE_MS);
    };
    timer = clock.setTimeout(next, PULSE_MS);
    return () => clock.clearTimeout(timer);
  }, [steps, clock]);
  return h(Text, { color: squareColor(depth, steps, step) }, KIKO_SQUARE);
});

/**
 * Kiko's icon and name, as a session's mark and name are drawn (marks.ts slotted): "▪  Kiko", the
 * square in the icon column, the name bold in the site's pale text colour. Put inside a Text with
 * wrap "truncate-end" for the name to give way in a narrow row.
 */
export function Wordmark({ pulsing, depth, clock }: SquareProps) {
  return h(
    Text,
    null,
    h(KikoSquare, { pulsing, depth, clock }),
    slotted(""), // the slot's blanks after the glyph
    h(Text, { bold: true, color: inDepth(BRAND.text, depth) }, NAME),
  );
}
