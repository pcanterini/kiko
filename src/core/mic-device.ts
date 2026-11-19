/**
 * Which microphone to use (settings: Listening → Microphone), kept apart from the helper so it can
 * be tested. The choice is a Core Audio device UID plus its name: a USB mic's UID can change with
 * the port it's in, so the name finds it again. Nothing chosen means the system default: whatever
 * macOS has as its default input, followed as it changes (2026-11-14: nothing of Kiko's own; before,
 * the built-in mic stood in for a Bluetooth default). A chosen mic that isn't there (unplugged, the
 * iPhone out of reach, AirPods in their case) falls back to the system default until it's back;
 * native/macos/mic.swift decides the same way when it opens the mic, and moves over while open.
 * A Bluetooth mic in use, chosen or the system default, is held open while it's the one in use
 * (heldMic: mic.swift held), so a press finds its call link up, and the setting says so. One that
 * gives no link (listed, but out of your ears or with the iPhone: `away`) counts as not there.
 *
 * A Bluetooth mic coming and going is normal, not a problem (since 2026-11-14: it should just work
 * when it's there, with nothing to say it's gone):
 * nothing is shown or said about it, only logged. A wired mic you chose and unplugged is still said.
 */

/**
 * An input device, as native/macos/mic.swift lists it. `transport`: how it's connected ("built-in",
 * "bluetooth", "usb"…; absent from a helper older than 2026-11-12).
 */
export type MicDevice = { uid: string; name: string; isDefault: boolean; transport?: string };
/** What you picked; null: the system default. */
export type MicChoice = { uid: string; name: string } | null;
/**
 * What it uses: the device (null when there's no input at all), and whether that's a fallback (a
 * mic was chosen, and another stands in). `bluetooth`: the mic you chose is a Bluetooth one, there
 * or not, so its being away isn't said. `noLink`: the mic that would be used is listed but gave no
 * link, and this one stands in.
 */
export type MicInUse = { device: MicDevice | null; fallback: boolean; wanted: MicChoice; bluetooth?: boolean; noLink?: boolean };

/** The chosen device, by UID then name, if it's there. */
export function findMic(choice: MicChoice, devices: MicDevice[]) {
  if (!choice) return null;
  return devices.find((d) => d.uid === choice.uid) ?? devices.find((d) => choice.name && d.name === choice.name) ?? null;
}

/** A Bluetooth audio device's UID as Core Audio gives it: its address, then ":input" ("18-3F-70-00-00-01:input"). */
const BLUETOOTH_UID = /^[0-9a-f]{2}([-:][0-9a-f]{2}){5}(:(input|output))?$/i;
/** Choices seen listed as Bluetooth in this run, by the UID chosen: one that names no address (KIKO_MIC by name) is still known once it's gone. */
const seenBluetooth = new Set<string>();

/**
 * Whether the mic you chose is a Bluetooth one: as it's listed while it's there; away, by its UID (a
 * Bluetooth address) or by having been seen as one in this run. Only the choice's UID and name are
 * kept in the settings, and a mic that's away isn't listed to ask.
 */
export function bluetoothChoice(choice: MicChoice, devices: MicDevice[]) {
  if (!choice) return false;
  const chosen = findMic(choice, devices);
  if (chosen?.transport === "bluetooth") seenBluetooth.add(choice.uid);
  // Listed without saying how it's connected (a helper before 2026-11-12): as when it's away.
  if (chosen?.transport) return chosen.transport === "bluetooth";
  return BLUETOOTH_UID.test(choice.uid) || seenBluetooth.has(choice.uid);
}

/**
 * The chosen device if it's there, else the system default (a fallback when one was chosen): what
 * macOS has, Bluetooth or not (mic.swift choose, which this mirrors). `away`: the UID of a mic that's
 * listed but gave no link (only the helper knows: the app is told as its hold ends with "no link").
 * It's passed over: the system default if that's another device, else the built-in mic; with no other
 * mic at all, it's used all the same.
 */
export function resolveMic(choice: MicChoice, devices: MicDevice[], away?: string | null): MicInUse {
  const chosen = findMic(choice, devices);
  const fallback = devices.find((d) => d.isDefault) ?? null;
  const first = chosen ?? fallback;
  const builtIn = away ? (devices.find((d) => d.transport === "built-in") ?? null) : null;
  const device = [chosen, fallback, builtIn].find((d) => d && d.uid !== away) ?? first;
  return {
    device,
    fallback: choice !== null && (!chosen || device !== chosen),
    wanted: choice,
    ...(bluetoothChoice(choice, devices) ? { bluetooth: true } : {}),
    ...(away && first?.uid === away && device !== first ? { noLink: true } : {}),
  };
}

/**
 * The mic the helper holds open between presses (mic.swift held, which this mirrors): the one in
 * use, while it's a Bluetooth one, chosen or the system default (2026-11-14; before, only one you
 * chose). Null: none (a mic that isn't Bluetooth, one that gave no link: `away`). Its headset stays
 * in its call profile meanwhile: presses start at once, and what it plays is call-quality.
 */
export function heldMic(choice: MicChoice, devices: MicDevice[], away?: string | null): MicDevice | null {
  const { device } = resolveMic(choice, devices, away);
  return device?.transport === "bluetooth" && device.uid !== away ? device : null;
}

/** What a Bluetooth mic does, in the setting's option: "AirPods (mic stays on: instant, call-quality sound)". */
export const HELD_NOTE = "mic stays on: instant, call-quality sound";

/** The system default as the setting shows it: what it is, and that its mic stays on when it's a Bluetooth one. */
const systemDefault = (device: MicDevice | null | undefined) => `System default (${device?.name ?? "none"}${device?.transport === "bluetooth" ? ", mic stays on" : ""})`;

/** The setting from KIKO_MIC (a UID or a name) or the saved one; empty means the system default. */
export function micChoice(uid: string | undefined, name?: string): MicChoice {
  return uid ? { uid, name: name || uid } : null;
}

/**
 * The settings' fields for a mic picked (`uid`; "" is the system default): its UID, with its name to
 * show and to find it by if the UID changes (`label`: the option's, when it isn't listed now).
 * Settings → Listening and setup's mic step both save these.
 */
export function micSetting(uid: string, devices: MicDevice[], label?: string): { mic?: string; micName?: string } {
  if (!uid) return { mic: undefined, micName: undefined };
  return { mic: uid, micName: devices.find((d) => d.uid === uid)?.name ?? label ?? uid };
}

/**
 * The setting's options: the system default (naming it), then every input device. The chosen one
 * stays listed while it's away, to pick again: a Bluetooth one as "used when connected" (away is
 * its normal state, 2026-11-14), any other as "not connected".
 */
export function micChoices(devices: MicDevice[], choice: MicChoice) {
  const options: { value: string; label: string; hint?: string }[] = [
    { value: "", label: systemDefault(devices.find((d) => d.isDefault)), hint: "follows what macOS uses" },
    ...devices.map((d) => ({ value: d.uid, label: d.transport === "bluetooth" ? `${d.name} (${HELD_NOTE})` : d.name, hint: d.isDefault ? "the system default now" : undefined })),
  ];
  if (choice && !findMic(choice, devices)) options.push({ value: choice.uid, label: choice.name, hint: bluetoothChoice(choice, devices) ? "used when connected" : "not connected" });
  return options;
}

/**
 * The setting's value, as the settings screen shows it. A Bluetooth mic in use is held open
 * (heldMic): said ("mic stays on"), since macOS's mic indicator stays on with it. A Bluetooth mic
 * you chose that's away reads as what it is, a mic used when it's there, with what's used now.
 */
export function micValue(inUse: MicInUse) {
  if (!inUse.wanted) return systemDefault(inUse.device);
  if (inUse.fallback) return inUse.bluetooth ? `${inUse.wanted.name} when connected (${inUse.device?.name ?? "no mic"} now)` : `${inUse.wanted.name} (not connected)`;
  return inUse.device?.transport === "bluetooth" ? `${inUse.device.name} (mic stays on)` : (inUse.device?.name ?? inUse.wanted.name);
}

/**
 * Said when the chosen mic is away: what's used meanwhile. Null when nothing fell back, and for a
 * Bluetooth mic (2026-11-14): AirPods in their case aren't something to be told about.
 */
export function fallbackNote(inUse: MicInUse) {
  if (!inUse.fallback || !inUse.wanted || inUse.bluetooth) return null;
  // The stand-in is the system default, but for one that gave no link itself (`noLink`: the built-in mic then).
  const meanwhile = !inUse.device ? "and there's no other mic" : `using ${inUse.device.name}${inUse.noLink ? "" : ", the system default,"} until it's back`;
  return `${inUse.wanted.name} isn't connected: ${meanwhile}`;
}

/**
 * Said when the key went up before the mic gave any sound (2026-11-12: a Bluetooth mic still
 * switching to its call profile): which mic, and what to do, never an empty transcript and
 * silence. `tap`: push to talk is a tap to start and one to stop.
 */
export function notStartedLine(name: string | null | undefined, tap = false) {
  const own = /['’]s\b/.test(name ?? ""); // "Alex's AirPods": no "The"
  const mic = !name ? "The mic" : /\bmic(rophone)?\b/i.test(name) ? (own ? name : `The ${name}`) : own ? `${name} mic` : `The ${name} mic`;
  return `${mic} didn't start in time. ${tap ? "Give it a moment before you talk." : "Hold the key a little longer."}`;
}

/**
 * The mic in the header: its name, or the fallback and what's missing (`warn`). A Bluetooth mic you
 * chose that's away is never "missing": the mic in use, by its name, as any other time.
 */
export function micHeader(inUse: MicInUse | null): { text: string; warn: boolean } {
  if (!inUse) return { text: "", warn: false };
  const name = inUse.device?.name ?? "no mic";
  if (inUse.fallback && inUse.wanted && !inUse.bluetooth) return { text: `🎙 ${name} (${inUse.wanted.name} missing)`, warn: true };
  return { text: `🎙 ${name}`, warn: !inUse.device };
}

/** The device list from the helper's "devices <json>" line or `mic --list`; [] when it's not one. */
export function parseDevices(text: string): MicDevice[] {
  try {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return [];
    return list
      .filter((d) => d && typeof d.uid === "string" && d.uid)
      .map((d) => ({
        uid: d.uid,
        name: typeof d.name === "string" && d.name ? d.name : d.uid,
        isDefault: d.isDefault === true,
        ...(typeof d.transport === "string" && d.transport ? { transport: d.transport } : {}),
      }));
  } catch {
    return [];
  }
}

/** What the helper opened, from its "using <json>" line. */
export type MicUsing = {
  uid: string;
  name: string;
  fallback: boolean;
  switched: boolean;
  wanted: MicChoice;
  /** The device set up anew for this open (not the last press's, kept warm): how long that took, part of "started". */
  setupMs?: number;
  /** It's the mic held open between presses (heldMic); `live`: its link was up as this press began. */
  held?: boolean;
  live?: boolean;
  /** The mic that would be used (chosen, or the system default) is listed but gave no link (out of your ears, with the iPhone): this one stands in. */
  noLink?: boolean;
};

export function parseUsing(text: string): MicUsing | null {
  try {
    const u = JSON.parse(text);
    if (!u || typeof u !== "object") return null;
    const wanted = u.wanted && typeof u.wanted.uid === "string" ? { uid: u.wanted.uid, name: String(u.wanted.name || u.wanted.uid) } : null;
    return {
      uid: String(u.uid ?? ""),
      name: String(u.name ?? ""),
      fallback: u.fallback === true,
      switched: u.switched === true,
      wanted,
      ...(typeof u.setupMs === "number" ? { setupMs: u.setupMs } : {}),
      ...(u.held === true ? { held: true, live: u.live === true } : {}),
      ...(u.noLink === true ? { noLink: true } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The hold, from the helper's "hold <json>" line: it began (`on`, with `why`: "chosen", "default"
 * (the system default set, or as the app starts), "connected", "changed", "woke", "press"; `default`:
 * it's held as the system default, not as a mic you chose; `retry`: tried again after it gave no
 * link), its link came up (`live`, `ms` after it was asked for, `outRate` the headset's output rate
 * then, `after` what had been lost), or it ended (`on` false, `why`: "another mic chosen",
 * "default changed" (macOS moved its default input elsewhere), "chosen mic back", "disconnected",
 * "no link" (listed, but it gave no sound: out of your ears, or with the iPhone; another mic stands
 * in until it's tried again), "cannot open", "quit"; `heldMs`).
 */
export type MicHold = { on: boolean; uid: string; name: string; why?: string; default?: boolean; live?: boolean; ms?: number; outRate?: number; after?: string; heldMs?: number; retry?: boolean };

/**
 * The mic that gave no link, as the app keeps it from the hold's lines (`was`: what it had; null:
 * none): the one whose hold ended with "no link" or "cannot open", until it's held again with its
 * link up, or held anew (not a try after it gave none: those end the same way if it's still away).
 */
export function noLinkAfter(hold: MicHold, was: string | null): string | null {
  if (!hold.on) return hold.why === "no link" || hold.why === "cannot open" ? hold.uid : was;
  return hold.live || !hold.retry ? null : was;
}

export function parseHold(text: string): MicHold | null {
  try {
    const h = JSON.parse(text);
    if (!h || typeof h !== "object" || typeof h.on !== "boolean") return null;
    return {
      on: h.on,
      uid: String(h.uid ?? ""),
      name: String(h.name ?? ""),
      ...(typeof h.why === "string" ? { why: h.why } : {}),
      ...(h.default === true ? { default: true } : {}),
      ...(h.live === true ? { live: true } : {}),
      ...(typeof h.ms === "number" ? { ms: h.ms } : {}),
      ...(typeof h.outRate === "number" ? { outRate: h.outRate } : {}),
      ...(typeof h.after === "string" ? { after: h.after } : {}),
      ...(typeof h.heldMs === "number" ? { heldMs: h.heldMs } : {}),
      ...(h.retry === true ? { retry: true } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Something changed under the hold, from the helper's "hold_lost <json>" line. `what`: "format"
 * (the mic's own rate or channels), "output format" (the headset's output changed rate: it left its
 * call profile), "silent" (exact zeros for half a second), "stalled" (the device stopped calling).
 * The rest is passed on as it came (`from`, `to`, `wasLive`).
 */
export type MicHoldLost = { what: string; uid: string; name: string } & Record<string, unknown>;

export function parseHoldLost(text: string): MicHoldLost | null {
  try {
    const l = JSON.parse(text);
    if (!l || typeof l !== "object" || typeof l.what !== "string") return null;
    return { ...l, what: l.what, uid: String(l.uid ?? ""), name: String(l.name ?? "") };
  } catch {
    return null;
  }
}

/**
 * Tells when the chosen mic goes missing and when it's back, once each, as the device list or the
 * choice changes: the app logs it, and says so unless it's a Bluetooth mic (app/settings/mic.ts
 * refreshMic). Changing the choice starts afresh.
 */
export class MicWatch {
  private missing: string | null = null; // the chosen mic's UID, while it's away

  update(inUse: MicInUse): "fallback" | "back" | null {
    const uid = inUse.wanted?.uid ?? null;
    if (inUse.fallback && uid) {
      if (this.missing === uid) return null;
      this.missing = uid;
      return "fallback";
    }
    if (this.missing && this.missing === uid) {
      this.missing = null;
      return "back";
    }
    this.missing = null;
    return null;
  }
}
