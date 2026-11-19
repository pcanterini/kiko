// The mic's level as a little moving waveform: in the header while you talk, and in the settings
// screen's mic test.
import React, { useRef } from "react";
import { Text } from "ink";

const BARS = "▁▂▃▄▅▆▇█";
/** How many levels the waveform shows. */
export const METER_LENGTH = 10;

/** Levels (0–1) as bars, one each, in the order given (newest last: on the right). */
export const bars = (levels: readonly number[]) => levels.map((l) => BARS[Math.max(0, Math.min(BARS.length - 1, Math.floor(l * BARS.length)))]).join("");

/** `history` (the last METER_LENGTH levels) with `level` added on the right, the oldest gone. */
export const pushLevel = (history: readonly number[], level: number) => [...history, level].slice(-METER_LENGTH);

/** The last ten levels (0–1), one bar each, newest on the right: one more each time it's drawn. */
export function Meter({ level }: { level: number }) {
  const history = useRef<number[]>(Array(METER_LENGTH).fill(0));
  history.current = pushLevel(history.current, level);
  return React.createElement(Text, { color: "red" }, bars(history.current));
}
