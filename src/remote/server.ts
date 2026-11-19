// The Mac-side server the phone talks to: a WebSocket on a fixed port, on every interface, so the
// phone reaches it at home (the local address, or found with Bonjour) and anywhere through
// Tailscale (the Tailscale address). Off unless Settings → Phone is on. welcome tells the phone every
// address it can use (addresses.ts), so it pairs once at home and finds the Mac anywhere after.
//
// It only translates, and is the connections and their messages; its pieces are beside it. What
// the phone sees comes from the same UI store the TUI draws (ui-store.ts), told by tell.ts: the
// sessions, what Kiko is doing, the permission prompt being asked, each line it speaks. What
// a session said comes from its agent (src/agents/: core's history watcher, history.ts, on its
// transcript). What the phone does goes back to the app through PhoneHub, which handles it as the
// Mac's own key and keys do (app.ts): routing, the queue, reply windows, "voice can" and
// permissions are decided there, never here or on the phone. Every message is checked against
// protocol/schema.json both ways in and out of tests.
//
// What's said while a paired phone isn't there (not connected, or away: in the background) is kept
// for it and sent as it comes back, read aloud on catch_up, and settled once it no longer needs the
// phone (missed.ts PhonesMissed); catch_up_stop stops a catch-up.
//
// What became of each thing said or typed on a phone that gave it an id (talkId) goes back to that
// phone as it happens (talk_status, from the app: talk-status.ts); a press or typed message turned
// down here (someone else talking, the session gone) is failed at once. A phone that reconnects gets
// each recent talk's latest status again.
//
// Audio is PCM in JSON (base64), as it always was, unless the phone and the hub agree on Opus
// (opus.ts): then it goes both ways in binary frames, decoded here for speech-to-text and encoded
// here for the phone's player. Each connection logs the codec it uses (phone_audio_codec).
//
// A phone can start a new session, as the Mac window's picker does (new-session.ts): it asks what
// the picker offers (get_new_session_options), then new_session, with a first message typed or said
// (a press with talk_start `dictate`: written down, never routed) and a name for it, and hears back
// new_session_status.
//
// A session's screen (the chat): its history carries what it's doing now (`doing`) and each edit's
// diff; earlier messages come a page at a time as the phone scrolls up (history_before,
// history_page); its menu interrupts, renames and closes it as the Mac's window menu does, for what
// each session can do (`can`, core/can.ts), with what came of it said back (session_note); a
// message's Hear it again is read through the app's speech (hear). Only to a phone whose hub said
// `chat` in welcome: an older hub refuses messages it doesn't know. A screen opened on a session
// still starting (its starting-… id) has nothing to show yet; once its agent lists it, the watch
// moves to that agent's record (followStarted), still under the id the phone asked for.
//
// A phone that pages (watch `paged`, to a hub whose welcome says `paging`) gets a window of the
// newest turns within its budget, then only what changes (history_delta), earlier pages before a
// cursor, and Show full's rest of a cut item (show_full → full_text): history-window.ts. An older
// phone gets the whole history as before, capped (LEGACY_BYTES).
//
// Hands-free from the phone (its Settings → Hands-free, while its app is in front): a listener for
// it on the Mac, on the audio it sends while its Hands-free is on (phone-hands-free.ts).
//
// The Mac's plan and trial status (account-status.ts), while Kiko accounts are on: to each phone
// after welcome, then to all of them when it changes (looked at each minute). Accounts off: never.
//
// The iPhone app comes with Kiko Pro or the free trial (core/account/phone-plan.ts), while Pro is on
// sale: at each connect (hello, or pair) the plan is asked (`phonePlan`); one that doesn't include the
// phone gets `plan_required` (why, and whether the trial could still start), and the connection
// closes with 4014. Only at connect: a phone already in is never cut off, and the pairing is kept.
// When the Mac is simply signed out, a paired phone (hello, never pair) is offered to sign it in
// (`signIn`): one that answers `sign_in` within SIGN_IN_ANSWER_MS keeps its connection, gets the
// Mac's sign-in code (`mac_sign_in`, core/account/mac-sign-in.ts: the one shared with Enter on the
// Mac), and once the Mac is signed in hears `signed_in` and is let go with 4015, to connect again at
// once. A refused phone gets nothing but that: never welcome, the sessions or anything after it.
//
// Every direct connection (the home network, Tailscale) is encrypted end to end, as the relay's is
// (local.ts): the phone opens it with a handshake (Noise IK to this Mac's static key, or CPace with
// the pairing code or, once, its token), and after it every frame is a sealed record. The server gets
// a socket (tunnel-socket.ts TunnelSocket) that behaves as the `ws` package's, so nothing past it
// changes. Who may sign in on it follows from the handshake (Conn.way): `pair` only on a code
// handshake; on a keys handshake only the phone with that key (or, with a key no phone has, a phone
// with no key yet, whose key it becomes); on a token handshake only that phone, whose hello brings
// its key. An app from before this, which says hello in the clear, is told to update.
//
// A phone away from home can come through the relay instead (relay-client.ts, on only with
// KIKO_RELAY_URL): each tunnel the Mac's relay client opens is handed here as a socket of its own
// (adopt), and from then on it's a connection like any other, hello and token included. Only a phone
// whose static key did the tunnel's handshake gets in on it: hello with another phone's token is
// refused. relay_pair, on a direct connection, sets a phone up for the relay (its key, a credential).
// The one exception: a phone pairing by the QR code from away comes through the relay on the qr way
// (relay-client.ts), and may `pair` there, then relay_pair on that same connection.
import { WebSocketServer } from "ws";
import { agent, agentOf } from "../agents/index.ts";
import { canDo } from "../core/can.ts";
import { historyBefore, itemAt, itemsBefore, type History, type HistoryItem } from "../core/history.ts";
import { type Budget, budgetOf, deltaOf, fullPart, legacy, type Sent, sentOf, windowOf, windowStart, preview, withIds } from "./history-window.ts";
import { log } from "../core/log.ts";
import { NAME, TITLE } from "../core/name.ts";
import { findSession, isStarting, sessionName } from "../core/sessions.ts";
import { ui, type Line, type UiState } from "../core/ui-store.ts";
import { platform } from "../platform/index.ts";
import type { Advertised, AtComputer, HubAddress, Network, Opus } from "../platform/types.ts";
import { reachableAt, relayAddress } from "./addresses.ts";
import { LocalLink, type ClearRefusal, type LocalWay } from "./local.ts";
import { newIdentity } from "./relay-identity.ts";
import type { X25519Pair } from "./tunnel.ts";
import { MacPresence } from "./at-mac.ts";
import { CODECS, frame, type FrameMarks, KIND, parseFrame, pickCodec, TalkDecoder, VOICE_PACKET, VoiceEncoder, type Codec } from "./opus.ts";
import type { LineMarks, MarkWord, VoicePos } from "../core/voice-marks.ts";
import { PhonesMissed, type Missed, type MissedLog, type SettledHow } from "./missed.ts";
import type { MacUse } from "./seen-on-mac.ts";
import { Pairing, type Phone } from "./pairing.ts";
import { PhoneHandsFree, type HandsFreeState } from "./phone-hands-free.ts";
import { Teller } from "./tell.ts";
import { ACCOUNT_CHECK_MS, type AccountStatus } from "./account-status.ts";
import type { PhonePlan, PlanReason } from "../core/account/phone-plan.ts";
import type { MacSignIn, MacSignInState } from "../core/account/mac-sign-in.ts";
import { askOf, pickKind, type NewSessionAsk, type NewSessionOptions, type NewSessionOutcome } from "./new-session.ts";
import { invalid, PROTOCOL_VERSION } from "./schema.ts";
import type { TalkStatus } from "./talk-status.ts";

export { PROTOCOL_VERSION };
/** Bonjour's service type: the phone browses for it. */
const SERVICE_TYPE = "_kiko._tcp";
/** Why a phone's connection was closed as the server stopped. */
const STOPPED = `${NAME}'s phone server stopped`;
// A phone has this long to say hello (or pair) before it's let go.
const AUTH_MS = 10_000;
/**
 * The most connections the phone server keeps open at once, from one address and in all, paired or
 * not: a phone has one or two (a newer one replaces the last). Past it a new one is closed at once,
 * so a peer on the network opening sockets by the thousand can't use up the app's file descriptors.
 */
const MAX_OPEN = { perAddress: 8, total: 64 };
// A phone says where it is right after welcome (presence: in front, or in the background or locked);
// one that hasn't said by then is an app from before it did, which only ever said away and back as it
// changed: it's taken to be in front.
const PRESENCE_MS = 2_000;
// A change of where the phone is counts once it has held this long: locking the phone sent away,
// back, away within 20ms, and only the last one is the phone's.
const PRESENCE_SETTLE_MS = 300;
// Pings keep a phone that vanished (out of range, asleep) from holding the floor or a watcher.
const PING_MS = 15_000;
// The close code for a connection a newer one of the same phone replaced (supersede): not an error.
const REPLACED = 4000;
// The close code for a phone turned away because the plan doesn't include it (plan_required), as the relay's.
export const PLAN_REQUIRED_CLOSE = 4014;
// The close code for a phone let go because the Mac signed in (from it, or on the Mac): connect again now.
export const SIGNED_IN_CLOSE = 4015;
// A phone offered the sign-in (plan_required signIn) answers sign_in within this long, or is let go as before.
export const SIGN_IN_ANSWER_MS = 3_000;
// A phone waiting on the Mac's sign-in is held this long at most.
export const SIGN_IN_HOLD_MS = 30 * 60_000;
// Audio isn't queued behind this much unsent data: a phone that can't keep up skips some.
const MAX_BUFFERED = 1024 * 1024;
// A phone skipping audio is logged (phone_audio_skipped) at most this often.
const SKIP_LOG_MS = 5_000;
// What the phone says itself (speak), and the most words a voice_marks carries.
const SPEAK_MAX = 8000;
const MAX_MARK_WORDS = 2000;
/** Whether `pos` carries on from where `at` said the next would be. */
const samePos = (at: VoicePos | null | undefined, pos: VoicePos) => Boolean(at && at.line === pos.line && at.at === pos.at);
// Each phone's talks' latest statuses, sent again as it reconnects: this many, this recent, at most.
const TALKS_KEPT = 20;
const TALKS_KEPT_MS = 10 * 60_000;

export type ErrorCode =
  | "version"
  | "invalid"
  | "unauthorized"
  | "auth_timeout"
  | "bad_code"
  | "pairing_closed"
  | "too_many_attempts"
  | "busy"
  | "not_talking"
  | "no_session"
  | "prompt_gone"
  | "bad_answers"
  | "nothing_plays"
  | "internal"
  | "stale_key"
  | "unknown_phone"
  | "qr_used"
  | "qr_expired";

/** What the phone asks of the app. Each returns an error code when it didn't happen. */
export type PhoneHub = {
  /**
   * The talk button went down: the phone holds the floor, as the push-to-talk key would. `talkId`:
   * the phone's id for the press, for its talk_status (null from an app that gives none). `dictate`:
   * a new session's first message (with a talkId, which newSession names): written down, not routed.
   */
  talkStart(sessionId: string | null, phoneId: string, talkId: string | null, dictate?: boolean): ErrorCode | null;
  /** 16 kHz mono 16-bit PCM while it's held. */
  talkAudio(pcm: Buffer): void;
  /** It went up (or the phone went away: `cancel`, nothing is sent). */
  talkEnd(cancel: boolean): void;
  /** Typed words, dealt with like spoken ones. `talkId` as in talkStart. */
  type(text: string, sessionId: string | null, phoneId: string, talkId: string | null): ErrorCode | null;
  /** Allow or deny the permission prompt being asked (or a trust card still up: promptUp); `always`: allowed for good, where it can be. */
  permission(promptId: string, decision: "allow" | "deny" | "always", phoneId: string): ErrorCode | null;
  /**
   * A prompt that stays up until it's settled, even while another is the one shown (Claude Code's
   * trust question): what a phone missed of it still needs it. Optional: without it, none does.
   */
  promptUp?(promptId: string): boolean;
  /** The answers to the questions being asked (permission_prompt `questions`), one per question. */
  answers(promptId: string, answers: Array<{ labels: string[]; text?: string }>, phoneId: string): ErrorCode | null;
  /** The phone holds the floor now. */
  talking(): boolean;
  /** Play on this Mac, switched on the phone: the only place it's switched (saved on the Mac). */
  playOnMac(on: boolean, phoneId: string): void;
  /**
   * Read these lines aloud, in order, through the usual speech (on the phone with Play on phone, on
   * the Mac with Play on this Mac): behind whatever is being said, never cutting it; a press stops them.
   */
  catchUp(lines: string[], phoneId: string): void;
  /** The same, as one short summary of these (unsettled) items; one is read as it is. */
  catchUpSummary(items: Missed[], phoneId: string): void;
  /** The phone's Stop: the catch-up's lines still to come go, and the one being said is cut. False when none was on. */
  catchUpStop(phoneId: string): boolean;
  /**
   * The phone's New session sheet: what the window's picker offers (its projects, where a new one
   * goes), the agents a session can start in, and the one preselected. Optional, with newSession:
   * without them, welcome doesn't offer it.
   */
  newSessionOptions?(): Promise<NewSessionOptions>;
  /**
   * A new session, started as the window's picker starts one: `heard` gets a said first message's
   * words (a dictated press: new-session.ts) before they go in.
   */
  newSession?(ask: NewSessionAsk, phoneId: string, heard: (text: string) => void): Promise<NewSessionOutcome>;

  // ── A session's screen (the chat) ──
  /**
   * A session screen's Interrupt, Rename or Close, as the Mac's window menu does them (only what
   * canDo says it can): what came of it is told to that phone (PhoneServer.sessionNote). An error
   * code when it can't start (no_session). Optional: without it the server says it can't.
   */
  sessionAction?(sessionId: string, action: SessionAction, name: string | null, phoneId: string): ErrorCode | null;
  /** A message's Hear it again: these words read aloud through the usual speech, behind whatever is being said. Optional. */
  hear?(text: string, sessionId: string | null, phoneId: string): void;

  // ── Hands-free from the phone ──
  /**
   * The phone's Hands-free on (its app in front) or off; `why` it went off when it wasn't the phone
   * that said (its app went away, its connection went). Resolves to why it can't listen, or null.
   * Optional, with listenAudio: without them welcome doesn't offer it.
   */
  listen?(phoneId: string, on: boolean, why: "phone" | "away" | "gone"): Promise<string | null>;
  /** What the phone's mic heard while its Hands-free is on: 16 kHz mono 16-bit PCM. */
  listenAudio?(phoneId: string, pcm: Buffer): void;
  /**
   * The phone plays Kiko's voice or a cue now (`playing`), or its mic is back (the playback over, and
   * its own moment after), while its Hands-free is on: its listener is deaf by it. Optional: without
   * it welcome doesn't say `handsFreePlaying`, and the phone doesn't send it.
   */
  listenPlaying?(phoneId: string, playing: boolean): void;
  /** The phone whose hands-free holds the floor now (its words live go to the phones, as a press's do). */
  voiceFrom?(): string | null;
};

/**
 * A connection's socket: the `ws` package's, or a relay tunnel's (relay-client.ts TunnelSocket),
 * which behaves the same: "message" (data, isBinary), "pong", "close", "error".
 */
export interface PhoneSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * The relay, as the server tells phones of it (relay_paired, the relay's entry in addresses): on
 * only with KIKO_RELAY_URL and a device key (relay-identity.ts).
 */
type RelaySide = {
  url: string;
  /** The Mac's room on the relay (tunnel.ts roomOf). */
  room: string;
  /** The Mac's static X25519 public key, base64: the phone's handshake is to it. */
  macKey: string;
  /** The Mac's Ed25519 public key, base64: the room is named after it. */
  signingKey: string;
  /**
   * The account check at relay_pair (protocol/README.md, "Relay": tickets): why a ticket doesn't let
   * this phone use the relay, or null when it does. Unset in phase 1: none is asked for.
   */
  checkTicket?(ticket: string | null, phoneId: string): string | null;
};

/** What a session screen's menu does to its session. */
export type SessionAction = "interrupt" | "rename" | "close";

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  version: `This ${NAME} speaks protocol ${PROTOCOL_VERSION}. Update the app.`,
  unauthorized: `This phone isn't paired with ${NAME} any more. Pair it again.`,
  auth_timeout: "Took too long to say hello.",
  bad_code: "That code isn't right. Check the code in Settings → Phone.",
  pairing_closed: `Pairing isn't open. In ${NAME}: Settings → Phone → Pairing code.`,
  too_many_attempts: `Too many wrong codes. Open a new code in ${NAME}'s settings.`,
  busy: `Someone is talking to ${NAME} already. Try again in a moment.`,
  not_talking: "Not talking: press the button first.",
  no_session: "That session isn't running any more.",
  prompt_gone: "That prompt isn't waiting any more.",
  bad_answers: "Those answers don't fit its questions. Pick an option or write an answer for each.",
  nothing_plays: `Nothing plays what ${NAME} says now: Play on this Mac is off, and no phone has Play on phone on. It still shows on screen.`,
  internal: "Something went wrong on the Mac.",
  stale_key: `This iPhone has an old key for ${NAME} on this Mac: connecting again.`,
  unknown_phone: `${NAME} on this Mac doesn't know this iPhone any more. Pair it again: in ${NAME}, Settings → Phone → Pairing code.`,
  qr_used: `That QR code has paired a phone already: each one pairs one. For a new one, in ${NAME} on the Mac: Settings → Phone → Pair a phone.`,
  qr_expired: `That QR code doesn't work any more: it has expired, or its screen was closed. For a new one, in ${NAME} on the Mac: Settings → Phone → Pair a phone.`,
};

/** What an app from before the encrypted connection is told (in the clear: it reads nothing else). */
const UPDATE_APP = `Update ${NAME} on this iPhone: ${NAME} on the Mac encrypts everything between them now, and this version of the app doesn't.`;

/** A phone's connection, as the server and its pieces (tell.ts, missed.ts, phone-hands-free.ts) see it. */
export type Conn = {
  ws: PhoneSocket;
  address: string;
  // How it came: straight to this server, or through the relay's tunnel.
  via: "direct" | "relay";
  // Through the relay: the phone whose key did the tunnel's handshake, the only one let in on it.
  expect: string | null;
  // Direct: how the phone opened its tunnel (local.ts), which says who may sign in on it.
  way: LocalWay | null;
  phone: Phone | null;
  alive: boolean;
  authTimer: NodeJS.Timeout | null;
  // The session whose screen it shows: the id it asked for, the one that was listed under then (`of`),
  // and what follows it. A phone that pages: its budget, what it was last sent (for history_delta),
  // and the history as its agent last gave it (pages and Show full for an agent with no file).
  watching: { sessionId: string; of: string; watcher: { stop(): void }; paged: Budget | null; sent: Sent | null; latest: HistoryItem[] } | null;
  // Where its app is (presence): here (in front), away (in the background or locked: what's said
  // meanwhile is kept for it, and it doesn't play it, so the Mac does), or not said yet (a connection
  // just made: counted as away until it says, so a phone that (re)connects in the background never
  // silences the Mac; here after PRESENCE_MS for an older app that doesn't say on connect).
  presence: "unsaid" | "here" | "away";
  // Whether the phone itself said where it is on this connection (not assumed): the app says so only
  // on the connection it took (the first to welcome it), so one it said on is the phone's own.
  said: boolean;
  // Let go because a newer connection of the same phone took over (supersede): its close is no news.
  replaced: boolean;
  presenceTimer: NodeJS.Timeout | null;
  // A change it said, acted on once it has held PRESENCE_SETTLE_MS (presenceSaid).
  settling: { to: "here" | "away"; timer: NodeJS.Timeout } | null;
  // What it was sent last, so only changes go out.
  last: { sessions?: string; state?: string; prompt?: string };
  // Its talk_audio that came after its talk_end (or with no press), and when the press ended:
  // logged once a press (phone_audio_late), since that audio never reaches speech-to-text.
  late?: { endedAt: number | null; logged: boolean };
  // The codec its audio goes in both ways (opus.ts): PCM until it asks for another (audio_codecs).
  codec: Codec;
  // On Opus, the press's audio being decoded (made with its first binary frame).
  talk: TalkDecoder | null;
  // What it sent while its press's last audio was still being decoded: handled once that's done.
  held: Array<{ data: Buffer; binary: boolean }> | null;
  // Bytes of audio it sent and was sent (JSON or binary, as on the wire), for phone_disconnected.
  audioIn: number;
  audioOut: number;
  // Its Hands-free is on on this connection (hands_free), and its audio being decoded on Opus.
  listening: boolean;
  listen: TalkDecoder | null;
  // It asked about hands-free on this connection: it's told how its listener is (hands_free_state).
  handsFree: boolean;
  // Bytes of its hands-free audio (as on the wire), for phone_disconnected.
  listenIn: number;
  // Where the next of the voice it's sent starts in the line being said, as it was last told
  // (voice_marks sync): null for audio of no line; undefined when it doesn't know (told with the next).
  voiceAt?: VoicePos | null;
  // Chunks of the voice it didn't get because its send buffer was full, since phone_audio_skipped
  // was last logged for it, and when that was (logged at most every SKIP_LOG_MS).
  skipped?: { chunks: number; loggedAt: number };
  // Turned away because the Mac is signed out, and offered to sign it in: the paired phone (never
  // signed in on this connection: `phone` stays null), whether it took it (`held`: it said sign_in),
  // the timer that lets it go, and its hold on the Mac's sign-in (a code that runs out is replaced).
  signIn?: { phone: Phone; held: boolean; timer: NodeJS.Timeout; release: (() => void) | null } | null;
};

type PhoneServerOptions = {
  hub: PhoneHub;
  pairing: Pairing;
  port: number;
  /** All interfaces when unset. */
  host?: string;
  /** Phones came or went, paired or were forgotten, or switched Play on phone: for the settings screen. */
  changed?: () => void;
  /** A phone paired just now, with the code or the QR code: the pairing screen says so and closes. */
  paired?: (phone: Phone, how: "code" | "qr") => void;
  /** The computer's network (its addresses, Bonjour): the platform's unless a test swaps it. */
  network?: Pick<Network, "addresses" | "advertise" | "hostname">;
  /** Where what each phone missed is kept (missed.json); in memory when unset. */
  missedFile?: string;
  /** How long a new connection has to say where it is (PRESENCE_MS unless a test shortens it). */
  presenceMs?: number;
  /** How long a change of where it is must hold before it counts (PRESENCE_SETTLE_MS unless a test changes it). */
  presenceSettleMs?: number;
  /**
   * Whether someone is at this Mac (the platform's presence): a line for an away phone then goes
   * quietly (at-mac.ts). Unset: never known, so every one notifies, as before.
   */
  atComputer?: () => Promise<AtComputer | null>;
  /**
   * Whether the Mac says what's said out loud now (Play on this Mac, or standing in for the phones,
   * and not muted): a line it said while you were at it was seen there (seen-on-mac.ts). Unset: as
   * the UI store has it (macPlays, muted).
   */
  macHears?: () => boolean;
  /**
   * Opus for the phone's audio: the platform's unless a test swaps it. Null: this hub takes only PCM
   * (welcome lists no codecs), as before.
   */
  opus?: Opus | null;
  /** The relay, when it's on (KIKO_RELAY_URL): phones can be set up for it (relay_pair). */
  relay?: RelaySide;
  /** How often each connection is pinged (PING_MS): shorter for a harness that checks the phone answers. */
  pingMs?: number;
  /**
   * This Mac's static X25519 key (relay-identity.ts, from the Keychain): every direct connection's
   * tunnel is to it, as the relay's is. A throwaway one when unset (tests).
   */
  identity?: { static: X25519Pair };
  /** How long a phone has to open its tunnel (local.ts), for tests. */
  handshakeMs?: number;
  /** The most connections open at once from one address, and in all (MAX_OPEN unless a test lowers them). */
  maxOpen?: { perAddress: number; total: number };
  /**
   * The Mac's plan and trial status for the phones (account-status.ts), as last known: null while
   * accounts aren't open, and then nothing is sent. Unset: never sent.
   */
  account?: () => AccountStatus | null;
  /** How often the status is looked at again (ACCOUNT_CHECK_MS unless a test shortens it). */
  accountCheckMs?: number;
  /**
   * Whether the plan includes the phone now (core/account/phone-plan.ts), asked at each connect.
   * Unset, or null: every paired phone gets in, as before.
   */
  phonePlan?: () => PhonePlan | null;
  /** A phone was turned away for the plan (the paired one, or null for one pairing): for the Mac's line. */
  planRefused?: (phone: Phone | null, plan: { trialAvailable: boolean; reason: PlanReason }) => void;
  /**
   * The Mac's sign-in (core/account/mac-sign-in.ts), offered to a paired phone turned away because
   * the Mac is signed out. Unset: never offered (plan_required closes as ever).
   */
  macSignIn?: MacSignIn;
  /** A phone opened the approval page (sign_in_opened): for the Mac's line, with the code to check. */
  signInOpened?: (phone: Phone) => void;
  /** How long a phone offered the sign-in has to answer, and how long one is held (SIGN_IN_ANSWER_MS, SIGN_IN_HOLD_MS unless a test shortens them). */
  signInMs?: { answer?: number; hold?: number };
};

export class PhoneServer {
  readonly hubName: string;
  private o: PhoneServerOptions;
  private identity: { static: X25519Pair };
  private network: Pick<Network, "addresses" | "advertise" | "hostname">;
  // This Mac's addresses as last looked up (start, and as each phone connects), and the lookup running.
  private found: HubAddress[] = [];
  private lookup: Promise<void> | null = null;
  private wss: WebSocketServer | null = null;
  private conns = new Set<Conn>();
  // The listener's sockets open now, by the address they came from (MAX_OPEN), and how many were turned away since the last said.
  private open = new Map<string, number>();
  private turnedAway = 0;
  private talker: Conn | null = null;
  private advertised: Advertised[] = [];
  private pinger: NodeJS.Timeout | null = null;
  // The account status as last sent to every phone (JSON), and the timer that looks at it again.
  private accountSent: string | null = null;
  private accountTimer: NodeJS.Timeout | null = null;
  // Each phone's talks' latest statuses (talk_status), oldest first, for when it reconnects.
  private talks = new Map<string, Array<{ at: number; status: TalkStatus }>>();
  /** What each paired phone missed while it wasn't there. */
  readonly missed: MissedLog;
  /** What the phones missed, and what of it was settled: kept, sent and read aloud (missed.ts). */
  private phonesMissed: PhonesMissed;
  /** Whether you're at the Mac, for what goes to an away phone; null when it can't be told. */
  private macPresence: MacPresence | null;
  /** What the phones are told: the sessions, the state, the prompt, each line (tell.ts). */
  private teller: Teller;
  /** Hands-free from the phone (phone-hands-free.ts). */
  private handsFree: PhoneHandsFree;
  /** Opus, when this hub has it; the voice encoded once for every phone on it. */
  private opus: Opus | null;
  private voice: VoiceEncoder | null = null;
  private onChange = () => this.teller.schedule();
  // Kept for the phones not there first, then told to the ones that are.
  private onLine = (line: Line) => {
    this.phonesMissed.record(line);
    this.teller.line(line);
  };
  private onInterim = (text: string) => (this.o.hub.talking() || this.o.hub.voiceFrom?.()) && this.broadcast({ type: "heard", text, final: false });
  /** The Mac's sign-in moved on: told to every phone waiting on it, and once signed in, each let go to connect again. */
  private onSignIn = (s: MacSignInState) => {
    for (const c of this.conns) if (c.signIn?.held) this.tellSignIn(c, s);
  };
  /** The port it listens on, once started. */
  port = 0;

  constructor(options: PhoneServerOptions) {
    this.o = options;
    this.identity = options.identity ?? newIdentity();
    this.network = options.network ?? platform.network;
    // "Kiko Dev on …" for a checkout: the phone tells the two apart (each on a port of its own: core/name.ts flavourNames).
    this.hubName = `${TITLE} on ${this.network.hostname().replace(/\.local$/, "")}`;
    const macPresence = options.atComputer ? new MacPresence(options.atComputer) : null;
    this.macPresence = macPresence;
    this.opus = options.opus === undefined ? platform.opus : options.opus;
    const send = (c: Conn, message: Record<string, unknown>) => this.send(c, message);
    this.phonesMissed = new PhonesMissed({
      hub: options.hub,
      pairing: options.pairing,
      conns: this.conns,
      send,
      macPresence,
      macHears: options.macHears,
      file: options.missedFile ?? null,
    });
    this.missed = this.phonesMissed.missed;
    this.teller = new Teller({
      hub: options.hub,
      conns: this.conns,
      send,
      broadcast: (message) => this.broadcast(message),
      macPresence,
      before: (s) => {
        this.phonesMissed.watchSettled(s);
        this.followStarted(s);
      },
    });
    options.macSignIn?.on("state", this.onSignIn);
    this.handsFree = new PhoneHandsFree({
      hub: options.hub,
      conns: this.conns,
      send,
      error: (c, code, message) => this.error(c, code, message),
      sameAs: (c) => this.sameAs(c),
    });
  }

  get pairing() {
    return this.o.pairing;
  }

  /** A new socket from `address`, counted, unless that's over MAX_OPEN (logged: the first, then every hundredth). */
  private admit(address: string) {
    const max = this.o.maxOpen ?? MAX_OPEN;
    const fromThere = this.open.get(address) ?? 0;
    let total = 0;
    for (const n of this.open.values()) total += n;
    if (fromThere >= max.perAddress || total >= max.total) {
      if (this.turnedAway++ % 100 === 0) log("phone_refused", { reason: "too_many_open", address, fromThere, total, turnedAway: this.turnedAway });
      return false;
    }
    this.open.set(address, fromThere + 1);
    return true;
  }

  /** A socket admit() counted has closed. */
  private release(address: string) {
    const n = (this.open.get(address) ?? 1) - 1;
    if (n > 0) this.open.set(address, n);
    else this.open.delete(address);
  }

  /** Phones connected and paired now: each once, as its newest connection has it. */
  connected(): Phone[] {
    const byId = new Map<string, Phone>();
    for (const c of this.conns) if (c.phone && !c.replaced) byId.set(c.phone.id, c.phone);
    return [...byId.values()];
  }

  async start() {
    // Whether you're at the Mac, once now: its helper is built (if it has to be) before a line needs it.
    void this.macPresence?.check();
    await this.lookUp();
    const wss = new WebSocketServer({ port: this.o.port, host: this.o.host, maxPayload: 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    wss.on("error", (err) => log("error", { where: "phone_server", message: err.message }));
    this.wss = wss;
    const address = wss.address();
    this.port = typeof address === "object" && address ? address.port : this.o.port;
    wss.on("connection", (ws, req) => {
      const address = req.socket.remoteAddress ?? "";
      // Over the most open at once: dropped there and then (no closing handshake to wait on).
      if (!this.admit(address)) return void ws.terminate();
      ws.once("close", () => this.release(address));
      new LocalLink(ws, {
        identity: this.identity,
        pairing: this.o.pairing,
        address,
        handshakeMs: this.o.handshakeMs,
        message: (code: ClearRefusal) => (code === "version" ? UPDATE_APP : (MESSAGES[code] ?? code)),
        changed: () => this.o.changed?.(),
        adopt: (socket, way) => {
          if (!this.wss) return socket.close(1001, STOPPED);
          this.connect(socket, address, "direct", way.mode === "token" ? way.phoneId : way.mode === "keys" ? way.phoneId : null, way);
        },
      });
    });
    ui.on("change", this.onChange);
    ui.on("line", this.onLine);
    ui.on("interim", this.onInterim);
    this.pinger = setInterval(() => {
      for (const c of this.conns) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, this.o.pingMs ?? PING_MS);
    this.pinger.unref();
    if (this.o.account) {
      this.accountTimer = setInterval(() => this.accountChanged(), this.o.accountCheckMs ?? ACCOUNT_CHECK_MS);
      this.accountTimer.unref();
    }
    const txt = { v: String(PROTOCOL_VERSION), host: this.network.hostname(), port: String(this.port) };
    this.advertised = [this.network.advertise(this.hubName, SERVICE_TYPE, this.port, txt)];
    log("phone_on", { port: this.port, host: this.o.host ?? "all" });
    return this.port;
  }

  stop() {
    ui.off("change", this.onChange);
    ui.off("line", this.onLine);
    ui.off("interim", this.onInterim);
    if (this.pinger) clearInterval(this.pinger);
    if (this.accountTimer) clearInterval(this.accountTimer);
    this.accountTimer = null;
    this.o.macSignIn?.off("state", this.onSignIn);
    this.teller.stop();
    this.voice?.stop();
    for (const a of this.advertised) a.stop();
    this.advertised = [];
    for (const c of this.conns) c.ws.close(1001, STOPPED);
    this.wss?.close();
    this.wss = null;
    log("phone_off", {});
  }

  /**
   * Every way a phone can reach this Mac (welcome and paired carry it): home addresses, the Bonjour
   * name, Tailscale's address and name. As last looked up: when the server started, and again as each
   * phone connects (one lookup at a time), so a change (a new home address, Tailscale turned on or
   * off) reaches the phone by its next connection at the latest.
   */
  addresses(phone?: Phone | null) {
    const direct = reachableAt(this.found, this.network.hostname(), this.port);
    // The relay's entry only for a phone set up for it (its credential: every phone has a key now): one
    // that isn't can't use it (and an older app would only dial its host and port, and fail).
    const relay = this.o.relay && phone?.relayCredentialHash ? [relayAddress(this.o.relay.url, this.o.relay.room)] : [];
    return [...direct, ...relay];
  }

  /** This Mac's static X25519 public key (welcome's macKey): the pairing QR code carries it. */
  get macKey(): Buffer {
    return this.identity.static.public;
  }

  /** The relay, while it's on: its url and this Mac's room there (the pairing QR code carries them). */
  relayInfo(): { url: string; room: string } | null {
    return this.o.relay ? { url: this.o.relay.url, room: this.o.relay.room } : null;
  }

  /** The relay is on (or off again: undefined), for what welcome and relay_pair say from now on. */
  setRelay(relay: RelaySide | undefined) {
    this.o.relay = relay;
  }

  /**
   * A phone through the relay: its tunnel (a socket of the relay client's), taken as a connection
   * like any other, for `phoneId` only (the phone whose key did the handshake); or, with `way` qr, a
   * phone pairing by the QR code from away (`pair` only, for that code).
   */
  adopt(socket: PhoneSocket, phoneId: string | null, way: LocalWay | null = null) {
    if (!this.wss) return socket.close(1001, STOPPED);
    this.connect(socket, "relay", "relay", phoneId, way?.mode === "qr" ? way : null);
  }

  private lookUp() {
    this.lookup ??= this.network
      .addresses()
      .then(
        (found) => void (this.found = found),
        (err) => log("error", { where: "phone_addresses", message: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => (this.lookup = null));
    return this.lookup;
  }

  /** Forgets paired phones (one, or all): their tokens stop working, and any connected now is let go. */
  forget(id: string | "all") {
    const gone = this.o.pairing.forget(id);
    for (const c of this.conns) if (c.phone && gone.includes(c.phone.id)) this.refuse(c, "unauthorized", "forgotten");
    this.missed.forget(gone);
    for (const id of gone) this.talks.delete(id);
    log("phone_forgotten", { phoneIds: gone });
    this.o.changed?.();
    return gone;
  }

  // ── Spoken output, teed to phones that asked for it ─────────────────────

  /**
   * PCM for the Mac's player (24 kHz mono 16-bit): the voices that stream audio, and the cues. Sent
   * as it's made, whether or not the Mac plays it (Play on this Mac); the phone's player queues it.
   * `pos`: where it is in the line being said (voice-marks.ts), for the phone's read-along: a phone
   * is told (voice_marks `sync`, just before the audio) whenever what it's sent doesn't carry on
   * from what it was sent last: a new line, a gap, a padded Opus packet, a phone that just came.
   */
  audio(pcm: Buffer, pos?: VoicePos) {
    const listeners = this.listeners();
    if (!listeners.length) return;
    const raw = listeners.filter((c) => c.codec === "pcm");
    if (raw.length) {
      const message = this.encode({ type: "audio", data: pcm.toString("base64"), rate: 24000 });
      const n = Math.floor(pcm.length / 2);
      for (const c of raw) {
        if (c.ws.bufferedAmount >= MAX_BUFFERED) {
          c.voiceAt = undefined; // a chunk it won't get: told again with the next
          this.skipped(c);
          continue;
        }
        if (pos && !samePos(c.voiceAt, pos)) this.send(c, { type: "voice_marks", line: pos.line, sync: { at: pos.at, offset: 0 } });
        this.sendAudio(c, message);
        c.voiceAt = pos ? { line: pos.line, at: pos.at + n } : null;
      }
    }
    // On Opus: encoded once for all of them, the first packet of a stretch sent at once (opus.ts).
    if (this.opus && raw.length < listeners.length) {
      this.voice ??= new VoiceEncoder(this.opus, (packets, count, marks) => {
        const message = frame(PROTOCOL_VERSION, KIND.voice, packets);
        for (const c of this.listeners()) {
          if (c.codec !== "opus") continue;
          if (c.ws.bufferedAmount >= MAX_BUFFERED) {
            c.voiceAt = undefined;
            this.skipped(c);
            continue;
          }
          this.voiceSync(c, marks, count * VOICE_PACKET);
          this.sendAudio(c, message);
        }
      });
      this.voice.push(pcm, pos);
    }
  }

  /**
   * Where an Opus frame's audio is in the lines said, told to `c` just before it: each line that
   * starts in it again (`marks`), and, when `c` wasn't told where the frame's start is (it came
   * mid-line, or missed a frame), that too. Then where the next frame will start, for `c`.
   */
  private voiceSync(c: Conn, { marks, head }: FrameMarks, samples: number) {
    // (A mark at the frame's very start says it already.)
    if (head && !samePos(c.voiceAt, head) && marks[0]?.offset !== 0) this.send(c, { type: "voice_marks", line: head.line, sync: { at: head.at, offset: 0 } });
    for (const m of marks) this.send(c, { type: "voice_marks", line: m.line, sync: { at: m.at, offset: m.offset } });
    const last = marks.at(-1);
    c.voiceAt = last ? { line: last.line, at: last.at + samples - last.offset } : head ? { line: head.line, at: head.at + samples } : null;
  }

  /** What's known of the words of a line being said (voice-marks.ts), to the phones it's played on. */
  voiceMarks(m: LineMarks) {
    if (!m.words.length) return;
    for (const c of this.listeners()) this.send(c, { type: "voice_marks", line: m.line, words: m.words, exact: m.exact });
  }

  /**
   * A chunk of the voice `c` won't get: its send buffer is full (a slow network). Logged
   * (phone_audio_skipped) with how many since it was last, at most every SKIP_LOG_MS per connection.
   */
  private skipped(c: Conn) {
    const now = Date.now();
    const s = (c.skipped ??= { chunks: 0, loggedAt: 0 });
    s.chunks++;
    if (now - s.loggedAt < SKIP_LOG_MS) return;
    log("phone_audio_skipped", { phoneId: c.phone?.id, codec: c.codec, chunks: s.chunks, bufferedBytes: c.ws.bufferedAmount });
    s.chunks = 0;
    s.loggedAt = now;
  }

  /** Audio to one connection, counted. */
  private sendAudio(c: Conn, message: string | Buffer) {
    if (c.ws.readyState !== c.ws.OPEN) return;
    c.audioOut += Buffer.byteLength(message);
    c.ws.send(message);
  }

  /**
   * A press's cue (24 kHz PCM) for the phone it was pressed on, and no other: feedback for the person
   * holding it, so it plays there whether or not Play on phone is on.
   */
  cue(pcm: Buffer, phoneId: string) {
    const message = this.encode({ type: "audio", data: pcm.toString("base64"), rate: 24000, cue: true });
    for (const c of this.conns) if (c.phone?.id === phoneId) this.sendAudio(c, message);
  }

  /**
   * A line the macOS voice says by itself, which can't be streamed: the phone says it. `said`: the
   * line, and where each of its written words is in `text` (the phone's synthesizer says which part
   * it's on: its read-along follows that).
   */
  speak(text: string, said?: { line: number; words: MarkWord[] }) {
    const words = said?.words.filter((w) => w.to !== undefined && w.to <= SPEAK_MAX).slice(0, MAX_MARK_WORDS);
    for (const c of this.listeners()) {
      if (said && words?.length) this.send(c, { type: "voice_marks", line: said.line, words, exact: true });
      this.send(c, { type: "speak", text: text.slice(0, SPEAK_MAX), ...(said ? { line: said.line } : {}) });
    }
  }

  /** Barge-in: the phone cuts what's playing too. */
  stopAudio() {
    this.voice?.cut(); // nothing of what was cut goes after audio_stop
    const listeners = this.listeners();
    for (const c of listeners) {
      this.send(c, { type: "audio_stop" });
      c.voiceAt = undefined;
    }
    // Why it was cut is logged just before (speech_cut, by stopTalking; or muting).
    if (listeners.length) log("phone_audio_stop", { phoneIds: listeners.map((c) => c.phone?.id) });
  }

  /** The codecs the voice goes to phones in now (the ones that play it), for speech_done. */
  playingCodecs(): string[] {
    return [...new Set(this.listeners().map((c) => c.codec))].sort();
  }

  /** A connected phone plays the spoken output. */
  audible() {
    return this.listeners().length > 0;
  }

  /** Something every phone connected should know, that it didn't ask about (nothing_plays). */
  tell(code: ErrorCode) {
    for (const c of this.conns) if (c.phone) this.error(c, code);
  }

  private listeners() {
    // Not one in the background or locked: its app can't play, so the Mac plays instead (app/state.ts macPlays).
    // Nor one that hasn't said where it is yet (Conn.presence).
    return [...this.conns].filter((c) => c.phone?.playOnPhone && c.presence === "here");
  }

  // ── Connections ─────────────────────────────────────────────────────────

  private connect(ws: PhoneSocket, address: string, via: Conn["via"], expect: string | null, way: LocalWay | null) {
    const c: Conn = {
      ws,
      address,
      via,
      expect,
      way,
      phone: null,
      alive: true,
      authTimer: null,
      watching: null,
      presence: "unsaid",
      said: false,
      replaced: false,
      presenceTimer: null,
      settling: null,
      last: {},
      codec: "pcm",
      talk: null,
      held: null,
      audioIn: 0,
      audioOut: 0,
      listening: false,
      listen: null,
      handsFree: false,
      listenIn: 0,
    };
    this.conns.add(c);
    void this.lookUp();
    c.authTimer = setTimeout(() => this.refuse(c, "auth_timeout", "auth_timeout"), AUTH_MS);
    c.authTimer.unref();
    ws.on("pong", () => (c.alive = true));
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (c.held) return void c.held.push({ data: buf, binary });
      this.message(c, buf, binary);
    });
    ws.on("close", () => this.closed(c));
    ws.on("error", () => {});
  }

  /** One message from the phone: text (JSON) or binary (Opus audio). */
  private message(c: Conn, data: Buffer, binary: boolean) {
    try {
      if (binary && c.phone) return this.binary(c, data);
      this.receive(c, binary ? null : data.toString());
    } catch (err) {
      log("error", { where: "phone_message", message: err instanceof Error ? err.message : String(err) });
      this.error(c, "internal");
    }
  }

  /** A binary frame: the press's audio (or its hands-free's) in Opus, from a phone that agreed on it. */
  private binary(c: Conn, data: Buffer) {
    const opus = c.codec === "opus" ? this.opus : null;
    const parsed = opus ? parseFrame(data, PROTOCOL_VERSION) : { error: "a binary frame before agreeing on Opus (audio_codec)" };
    if (!("error" in parsed) && parsed.kind === KIND.listen && opus) return this.handsFree.frame(c, opus, parsed.packets, parsed.count, data.length);
    if ("error" in parsed || parsed.kind !== KIND.talk || !opus) {
      const why = "error" in parsed ? parsed.error : "a binary frame of the hub's kind";
      log("phone_invalid", { phoneId: c.phone!.id, why });
      return this.error(c, "invalid", `Not a message ${NAME} understands: ${why}`);
    }
    if (!this.talkAudioFrom(c)) return;
    c.audioIn += data.length;
    const hub = this.o.hub;
    c.talk ??= new TalkDecoder(opus, (pcm) => hub.talkAudio(pcm));
    c.talk.packetsIn(parsed.packets, parsed.count);
  }

  /** Whether talk audio from `c` is taken now (it holds the floor); else said (once a press) and refused. */
  private talkAudioFrom(c: Conn) {
    if (this.talker === c) return true;
    if (!c.late?.logged) {
      const endedAt = c.late?.endedAt ?? null;
      log("phone_audio_late", { phoneId: c.phone!.id, msAfterEnd: endedAt === null ? null : Date.now() - endedAt });
      c.late = { endedAt, logged: true };
    }
    this.error(c, "not_talking");
    return false;
  }

  /**
   * The press is over. On Opus, once what's still being decoded has gone to speech-to-text: until
   * then the floor stays with this phone, and what it sends meanwhile waits, in order, behind it.
   */
  private talkOver(c: Conn, cancel: boolean) {
    const talk = c.talk;
    c.talk = null;
    const end = () => {
      if (this.talker === c) this.talker = null;
      c.late = { endedAt: Date.now(), logged: false };
      this.o.hub.talkEnd(cancel);
    };
    if (!talk || cancel) {
      talk?.close();
      return end();
    }
    c.held = [];
    void talk.drained().then((done) => {
      if (!done) log("error", { where: "phone_opus_decode", message: "a press's audio still decoding after 1 s: ended without the rest" });
      talk.close();
      if (!this.conns.has(c)) return; // gone meanwhile: closed() cancelled the press
      end();
      let held = c.held ?? [];
      c.held = null;
      while (held.length && !c.held) {
        const next = held.shift()!;
        this.message(c, next.data, next.binary);
      }
      // Another press ended among them, still decoding: the rest wait behind it, first.
      if (c.held) c.held = [...held, ...(c.held as Array<{ data: Buffer; binary: boolean }>)];
    });
  }

  private closed(c: Conn) {
    if (!this.conns.delete(c)) return;
    this.letGoSignIn(c);
    this.handsFree.off(c, "gone");
    if (c.authTimer) clearTimeout(c.authTimer);
    if (c.presenceTimer) clearTimeout(c.presenceTimer);
    if (c.settling) clearTimeout(c.settling.timer);
    c.watching?.watcher.stop();
    c.talk?.close();
    c.talk = null;
    c.held = null;
    if (this.talker === c) {
      this.talker = null;
      this.o.hub.talkEnd(true);
    }
    if (c.phone && !c.replaced) {
      log("phone_disconnected", {
        phoneId: c.phone.id,
        name: c.phone.name,
        codec: c.codec,
        audioBytesIn: c.audioIn,
        audioBytesOut: c.audioOut,
        ...(c.listenIn ? { handsFreeBytesIn: c.listenIn } : {}),
        ...(c.via === "relay" ? { via: "relay" } : {}),
      });
      this.o.changed?.();
      this.teller.schedule(); // no phone left to look: what the sessions are doing isn't followed any more
    }
  }

  private receive(c: Conn, text: string | null) {
    let message: any;
    try {
      message = text === null ? null : JSON.parse(text);
    } catch {
      message = null;
    }
    if (message && typeof message.v === "number" && message.v !== PROTOCOL_VERSION) {
      return this.refuse(c, "version", "version", { theirs: message.v });
    }
    const why = invalid(message, "phone");
    if (why) {
      log("phone_invalid", { phoneId: c.phone?.id ?? null, why });
      if (!c.phone) return this.refuse(c, "unauthorized", "invalid_first_message");
      return this.error(c, "invalid", `Not a message ${NAME} understands: ${why}`);
    }
    if (!c.phone) {
      // Turned away while the Mac is signed out: only the sign-in's own messages, until it lets go.
      if (c.signIn) return this.signInMessage(c, message.type);
      if (message.type === "hello") return this.hello(c, message);
      if (message.type === "pair") return this.pair(c, message);
      return this.refuse(c, "unauthorized", "not_signed_in");
    }
    switch (message.type) {
      case "hello":
      case "pair":
        return; // already in
      case "get_sessions":
        c.last.sessions = undefined;
        return this.teller.flush();
      case "watch":
        return this.watch(c, message.sessionId, message.paged === true ? budgetOf(message) : null);
      case "talk_start":
        return this.talkStart(c, message.sessionId ?? null, message.talkId ?? null, message.dictate === true);
      case "talk_audio": {
        if (!this.talkAudioFrom(c)) return;
        c.audioIn += text!.length;
        const pcm = Buffer.from(message.data, "base64");
        // Behind what's still being decoded of the same press, if it began on Opus.
        return c.talk ? c.talk.pcmIn(pcm) : this.o.hub.talkAudio(pcm);
      }
      case "talk_end":
      case "talk_cancel":
        if (this.talker !== c) return this.error(c, "not_talking");
        return this.talkOver(c, message.type === "talk_cancel");
      case "audio_codecs":
        return this.codecs(c, message.codecs);
      case "type": {
        const talkId = message.talkId ?? null;
        const err = this.o.hub.type(message.text, message.sessionId ?? null, c.phone.id, talkId);
        return err ? this.turnedDown(c, err, talkId) : undefined;
      }
      case "permission": {
        const err = this.o.hub.permission(message.promptId, message.decision, c.phone.id);
        return err ? this.error(c, err) : undefined;
      }
      case "answers": {
        const err = this.o.hub.answers(message.promptId, message.answers, c.phone.id);
        return err ? this.error(c, err) : undefined;
      }
      case "play_on_phone":
        // Every connection of this phone (each holds its own copy): one still closing never plays the old choice.
        for (const x of this.conns) if (x.phone?.id === c.phone.id) x.phone.playOnPhone = message.on;
        this.o.pairing.update(c.phone.id, { playOnPhone: message.on });
        log("phone_play", { phoneId: c.phone.id, on: message.on });
        return this.o.changed?.();
      case "play_on_mac":
        return this.o.hub.playOnMac(message.on, c.phone.id);
      case "presence":
        return this.presenceSaid(c, message.state === "away" ? "away" : "here", message.state);
      case "seen":
        this.missed.seen(c.phone.id, message.upTo);
        log("phone_seen", { phoneId: c.phone.id, upTo: message.upTo, unread: this.missed.unread(c.phone.id).length });
        return;
      case "catch_up":
        return this.phonesMissed.catchUp(c, message.ids ?? null, message.summary === true);
      case "catch_up_stop": {
        const stopped = this.o.hub.catchUpStop(c.phone.id);
        log("phone_catch_up_stopped", { phoneId: c.phone.id, stopped });
        return;
      }
      case "get_new_session_options":
        return void this.newSessionOptions(c);
      case "new_session":
        return void this.newSession(c, message);
      // A session's screen (the chat).
      case "history_before":
        return this.historyPage(c, message.sessionId, message.before, message.cursor ?? null, budgetOf(message));
      case "show_full":
        return this.showFull(c, message.sessionId, message.id, message.step);
      case "session_action":
        return this.sessionAction(c, message.sessionId, message.action, message.name ?? null);
      case "hear":
        log("phone_hear", { phoneId: c.phone.id, sessionId: message.sessionId ?? null, chars: message.text.length });
        return this.o.hub.hear?.(message.text, message.sessionId ?? null, c.phone.id);
      case "relay_pair":
        return this.relayPair(c, message.key, message.ticket ?? null);
      // Hands-free from the phone.
      case "hands_free":
        return void this.handsFree.said(c, message.on === true);
      case "listen_audio":
        return this.handsFree.audio(c, message.data, text!.length);
      case "hands_free_playing":
        return this.handsFree.playing(c, message.playing === true);
    }
  }

  // ── Hands-free from the phone (phone-hands-free.ts) ─────────────────────

  /** How a phone's listener is (core/phone-listen.ts): to its connections that asked about hands-free. */
  handsFreeState(phoneId: string, s: HandsFreeState) {
    this.handsFree.state(phoneId, s);
  }

  /**
   * relay_pair, on a direct connection: the phone's static X25519 key, kept with it (phones.json),
   * and a new relay credential for it, sent once (relay_paired: the Mac keeps only its hash, which
   * its relay client registers with its room). With the account check on (phase 2), its ticket
   * must pass first.
   */
  private relayPair(c: Conn, key: string, ticket: string | null) {
    const relay = this.o.relay;
    const phone = c.phone!;
    if (!relay) return this.error(c, "invalid", `This ${NAME} has no relay set up.`);
    // At home only: a new credential through the relay would end the very connection it came on (the
    // old one leaves the room). But a phone that paired through the relay by the QR code came in on the
    // code's own way in, which no credential change touches: it's set up there and then.
    if (c.via === "relay" && c.way?.mode !== "qr") return this.error(c, "invalid", "Set the relay up at home, on the same network as the Mac.");
    const raw = Buffer.from(key, "base64");
    if (raw.length !== 32 || raw.every((b) => b === 0)) return this.error(c, "invalid", "That isn't an X25519 public key.");
    const refused = relay.checkTicket?.(ticket, phone.id) ?? null;
    if (refused) {
      log("phone_relay_refused", { phoneId: phone.id, why: refused });
      return this.error(c, "unauthorized", refused);
    }
    const credential = this.o.pairing.setRelay(phone.id, key);
    if (!credential) return this.error(c, "internal");
    c.phone = this.o.pairing.list().find((p) => p.id === phone.id) ?? { ...phone, relayKey: key };
    log("phone_relay_paired", { phoneId: phone.id, via: c.via });
    this.send(c, { type: "relay_paired", url: relay.url, room: relay.room, macKey: relay.macKey, signingKey: relay.signingKey, credential, addresses: this.addresses(c.phone) });
  }

  private hello(c: Conn, m: { token: string; device: string; key?: string }) {
    const phone = this.o.pairing.check(m.token);
    if (!phone) return this.refuse(c, "unauthorized", "unknown_token");
    // Only the phone whose key (or token) opened the tunnel.
    if (c.expect && phone.id !== c.expect) return this.refuse(c, "unauthorized", "token_of_another_phone");
    const way = c.way;
    // A pairing handshake is for pair: a paired phone opens with its key (or, before it has one, its token).
    if (way?.mode === "code" || way?.mode === "qr") return this.refuse(c, "unauthorized", "hello_on_pairing");
    if (way?.mode === "keys" && way.phoneId === null) {
      // A key no phone has: only a phone the Mac has no key for yet may take it (its token says which).
      // One with another key is another phone, or this one with keys it lost: pair again.
      if (phone.relayKey) return this.refuse(c, "unauthorized", "key_of_another_phone");
      this.setKey(phone, way.key.toString("base64"), "keys");
    }
    if (way?.mode === "token" && m.key) {
      if (!isKey(m.key)) return this.refuse(c, "unauthorized", "bad_key");
      this.setKey(phone, m.key, "token");
    }
    if (this.planRefuses(c, phone, true)) return;
    this.signedIn(c, this.o.pairing.list().find((p) => p.id === phone.id) ?? phone, m.device);
  }

  /**
   * The plan asked at connect (phonePlan): one that doesn't include the phone says `plan_required`
   * (why, and whether the trial could still start) and lets the connection go, politely; a paired
   * phone (`paired`: on hello) of a Mac that's only signed out is offered to sign it in first, and
   * let go if it doesn't answer. True when it was turned away.
   */
  private planRefuses(c: Conn, phone: Phone | null, paired = false): boolean {
    let plan: PhonePlan | null = null;
    try {
      plan = this.o.phonePlan?.() ?? null;
    } catch (err) {
      log("error", { where: "phone_plan", message: err instanceof Error ? err.message : String(err) });
    }
    if (!plan || plan.ok) return false;
    if (c.authTimer) clearTimeout(c.authTimer);
    c.authTimer = null;
    const offer = paired && phone !== null && plan.reason === "mac_signed_out" && this.signInOffered();
    log("phone_refused", {
      reason: "plan_required",
      address: c.address,
      phoneId: phone?.id ?? null,
      via: c.via,
      trialAvailable: plan.trialAvailable,
      why: plan.reason,
      ...(offer ? { signIn: true } : {}),
    });
    this.send(c, { type: "plan_required", trialAvailable: plan.trialAvailable, reason: plan.reason, ...(offer ? { signIn: true } : {}) });
    this.o.planRefused?.(phone, { trialAvailable: plan.trialAvailable, reason: plan.reason });
    if (offer && phone) {
      // Held for its answer (sign_in); an app that doesn't know it never answers, and goes as before.
      const timer = setTimeout(() => this.planClose(c), this.o.signInMs?.answer ?? SIGN_IN_ANSWER_MS);
      timer.unref();
      c.signIn = { phone, held: false, timer, release: null };
      return true;
    }
    this.planClose(c);
    return true;
  }

  /** A phone turned away for the plan let go: 4014. */
  private planClose(c: Conn) {
    c.ws.close(PLAN_REQUIRED_CLOSE, "plan_required");
    this.closed(c);
  }

  /** The sign-in can be offered to a phone: there's one to share, and the Mac is signed out. */
  private signInOffered(): boolean {
    try {
      return this.o.macSignIn?.available() ?? false;
    } catch {
      return false;
    }
  }

  /**
   * From a phone turned away and offered the sign-in: sign_in (keep this connection for it, and the
   * code; again after a failure, to try again), sign_in_opened (it opened the approval page).
   * Anything else is let be.
   */
  private signInMessage(c: Conn, type: string) {
    const s = c.signIn!;
    const signIn = this.o.macSignIn;
    if (type === "sign_in" && signIn) {
      if (!s.held) {
        clearTimeout(s.timer);
        s.held = true;
        s.release = signIn.hold();
        s.timer = setTimeout(() => this.planClose(c), this.o.signInMs?.hold ?? SIGN_IN_HOLD_MS);
        s.timer.unref();
        log("phone_sign_in", { phoneId: s.phone.id, via: c.via });
      }
      // Signed in meanwhile (another phone's approval, the Mac): let go to connect again.
      if (signIn.settle() || !signIn.available()) return this.tellSignIn(c, { state: "signed_in", by: "elsewhere", email: null });
      // A new sign-in tells every waiting phone as it starts (onSignIn); one under way, only this one.
      const before = signIn.state();
      const now = signIn.start("phone");
      return now === before ? this.tellSignIn(c, now) : undefined;
    }
    if (type === "sign_in_opened" && s.held) {
      log("phone_sign_in_opened", { phoneId: s.phone.id });
      return this.o.signInOpened?.(s.phone);
    }
    // Anything else (hello again, a signed-in phone's message): nothing comes of it, and nothing is
    // said: never `unauthorized`, which would have the phone forget its pairing.
    log("phone_ignored", { phoneId: s.phone.id, why: "waiting_sign_in", type });
  }

  /** The Mac's sign-in, as the phone hears it (mac_sign_in): never the email; once signed in, let go with 4015. */
  private tellSignIn(c: Conn, s: MacSignInState) {
    if (s.state === "idle") return;
    if (s.state === "starting") return this.send(c, { type: "mac_sign_in", state: "starting" });
    if (s.state === "code") return this.send(c, { type: "mac_sign_in", state: "code", url: s.url, code: s.code, expiresAt: s.expiresAt });
    if (s.state === "failed") return this.send(c, { type: "mac_sign_in", state: "failed", why: s.why });
    this.send(c, { type: "mac_sign_in", state: "signed_in" });
    log("phone_sign_in_done", { phoneId: c.signIn?.phone.id ?? null });
    c.ws.close(SIGNED_IN_CLOSE, "signed_in");
    this.closed(c);
  }

  /** A connection offered the sign-in goes: its timer and its hold on the sign-in with it. */
  private letGoSignIn(c: Conn) {
    const s = c.signIn;
    if (!s) return;
    clearTimeout(s.timer);
    s.release?.();
    c.signIn = null;
  }

  /** The phone's static key, from now on what it opens its tunnel with (pairing.ts). */
  private setKey(phone: Phone, key: string, from: "keys" | "token") {
    if (phone.relayKey === key) return;
    this.o.pairing.setKey(phone.id, key);
    log("phone_key", { phoneId: phone.id, from, replaced: Boolean(phone.relayKey) });
  }

  private pair(c: Conn, m: { code: string; device: string; key?: string }) {
    const way = c.way;
    // Pairing is on the home network: a phone comes through the relay only once it's paired, or with
    // the QR code (its own way in on the relay, the qr opening through it).
    if (c.via === "relay" && way?.mode !== "qr") return this.refuse(c, "pairing_closed", "pair_through_relay");
    // And only on a pairing handshake (CPace with the code, or the QR code's secret), so neither
    // crosses the network but sealed under the keys it gave.
    if (way?.mode !== "code" && way?.mode !== "qr") return this.refuse(c, "pairing_closed", "pair_without_code_handshake");
    if (m.key !== undefined && !isKey(m.key)) return this.refuse(c, "bad_code", "bad_key");
    // Before the code is spent: a phone turned away for the plan can pair with it once the plan is there.
    if (this.planRefuses(c, null)) return;
    const result = way.mode === "qr" ? this.o.pairing.pairQr(way.id, m.code, m.device, m.key) : this.o.pairing.pair(m.code, m.device, m.key);
    if (!result.ok) {
      this.o.changed?.(); // a lockout closes pairing
      return this.refuse(c, result.code, result.code);
    }
    log("phone_paired", { phoneId: result.phone.id, name: result.phone.name, address: c.address, how: way.mode, ...(c.via === "relay" ? { via: "relay" } : {}) });
    this.send(c, { type: "paired", token: result.token, phoneId: result.phone.id, hubName: this.hubName, addresses: this.addresses(result.phone) });
    this.signedIn(c, result.phone, m.device);
    this.o.paired?.(result.phone, way.mode);
  }

  private signedIn(c: Conn, phone: Phone, device: string) {
    if (c.authTimer) clearTimeout(c.authTimer);
    c.authTimer = null;
    this.o.pairing.update(phone.id, { name: device, lastSeenAt: Date.now() });
    c.phone = { ...phone, name: device };
    log("phone_connected", { phoneId: phone.id, name: device, address: c.address, codec: c.codec, ...(c.via === "relay" ? { via: "relay" } : {}), ...(c.way ? { tunnel: c.way.mode } : {}) });
    this.send(c, {
      type: "welcome",
      hubName: this.hubName,
      phoneId: phone.id,
      playOnPhone: phone.playOnPhone,
      playOnMac: ui.state.playOnMac,
      versions: [PROTOCOL_VERSION],
      addresses: this.addresses(phone),
      // This Mac's static key: a phone that opened with its token keeps it, and opens with its keys from then on.
      macKey: this.identity.static.public.toString("base64"),
      talkStatus: true,
      // It starts sessions for the phone: only then does the phone ask (an older hub refuses what it doesn't know).
      ...(this.startsSessions() ? { newSession: true } : {}),
      // The codecs this hub takes besides PCM: a phone that takes one says so (audio_codecs).
      ...(this.opus ? { codecs: [...CODECS] } : {}),
      // It takes the session screen's own messages (history_before, session_action, hear).
      chat: true,
      // It sends a paging phone a window, deltas and pages by cursor, and Show full (watch paged, show_full).
      paging: true,
      // It has the relay: the phone may set itself up for it (relay_pair).
      ...(this.o.relay ? { relay: true } : {}),
      // It listens hands-free for the phone (handsFree, handsFreePlaying).
      ...this.handsFree.welcome(),
    });
    this.phonesMissed.sendMissed(c, "welcome");
    this.sendTalks(c);
    this.sendAccount(c);
    this.teller.flush();
    this.o.changed?.();
    c.presenceTimer = setTimeout(() => {
      c.presenceTimer = null;
      if (c.presence !== "unsaid" || !this.conns.has(c)) return;
      // An app that says where it is said so on another connection: that's the one it took, and this
      // is a dial it dropped (raced, welcomed too, still closing): never taken to be in front.
      if (this.sameAs(c).some((x) => x.said)) return;
      this.presence(c, "here", "assumed");
    }, this.o.presenceMs ?? PRESENCE_MS);
    c.presenceTimer.unref();
  }

  /**
   * What the phone said of where it is. The first on a connection counts at once (where it was as it
   * connected); a change, once it has held PRESENCE_SETTLE_MS: one taken back before that (away,
   * back, away within 20ms as the phone locks) is only logged (phone_presence_flap).
   */
  private presenceSaid(c: Conn, now: "here" | "away", said: "away" | "back") {
    const settleMs = this.o.presenceSettleMs ?? PRESENCE_SETTLE_MS;
    // The first the phone says on a connection: it took this one, so its others are let go (supersede).
    if (!c.said) {
      c.said = true;
      this.supersede(c);
    }
    const pending = c.settling;
    if (pending) clearTimeout(pending.timer);
    c.settling = null;
    if (c.presence === "unsaid" || settleMs <= 0) return this.presence(c, now, said);
    if (now === c.presence) {
      if (pending) log("phone_presence_flap", { phoneId: c.phone!.id, state: c.presence === "here" ? "back" : "away", ignored: pending.to === "here" ? "back" : "away" });
      return;
    }
    const timer = setTimeout(() => {
      c.settling = null;
      if (this.conns.has(c)) this.presence(c, now, said);
    }, settleMs);
    timer.unref();
    c.settling = { to: now, timer };
  }

  /**
   * Where the phone's app is: `said` is what it said (away, back), or `assumed` when an older app
   * said nothing on connect. Logged with `on`: connect for the first on a connection (the app as it
   * (re)connected, in front or not), change for one after. Back from away, it gets what it missed
   * (from unsaid, welcome brought it already).
   */
  private presence(c: Conn, now: "here" | "away", said: "away" | "back" | "assumed") {
    const before = c.presence;
    c.presence = now;
    if (c.presenceTimer) clearTimeout(c.presenceTimer);
    c.presenceTimer = null;
    log("phone_presence", { phoneId: c.phone!.id, state: now === "here" ? "back" : "away", on: before === "unsaid" ? "connect" : "change", ...(said === "assumed" ? { assumed: true } : {}) });
    // Away (in the background or locked): its hands-free stops; the app turns it on again once it's in front.
    if (now === "away") this.handsFree.off(c, "away");
    if (before === "away" && now === "here") this.phonesMissed.sendMissed(c, "back");
    if (before !== now) this.o.changed?.(); // whether a phone plays what's said changed
    if (before !== now) this.teller.schedule(); // whether a phone looks at the list (tell.ts followActivity) changed
  }

  /** The phone's other connections, still open. */
  private sameAs(c: Conn) {
    return [...this.conns].filter((x) => x !== c && x.phone && x.phone.id === c.phone?.id);
  }

  /**
   * The phone took `c` (it said where it is on it, which the app does only on the connection it
   * took): its older ones are let go. One is usually already gone at the phone's end but still open
   * here, half-open (Wi-Fi off: its close comes only once the pings give up),
   * and until then it would count as the phone in front (audible, present) and get audio for no one.
   * A replacement, not the phone leaving: no phone_disconnected and no presence change; its press,
   * if one was still open on it, is cancelled as for any connection that goes.
   */
  private supersede(c: Conn) {
    for (const old of this.sameAs(c)) {
      old.replaced = true;
      log("phone_replaced", { phoneId: c.phone!.id, from: old.via, to: c.via, presence: old.presence, ...(this.talker === old ? { pressCancelled: true } : {}) });
      try {
        old.ws.close(REPLACED, "replaced");
      } catch {
        // already closing
      }
      // At once, not when the close is answered: a half-open socket may never answer (the socket
      // gives up on its own: ws after 30 s, the relay's tunnel at once).
      this.closed(old);
    }
  }

  /**
   * What the phone takes (audio_codecs, best first): the first this hub has, else PCM, both ways
   * from now on (a press under way goes on as it began), said back (audio_codec) and logged.
   */
  private codecs(c: Conn, theirs: string[]) {
    const ours: string[] = this.opus?.available() ? [...CODECS] : [];
    const codec = pickCodec(theirs, ours);
    log("phone_audio_codec", { phoneId: c.phone!.id, codec, was: c.codec, theirs, ours });
    c.codec = codec;
    this.send(c, { type: "audio_codec", codec });
  }

  /** Says why, logs it (never the token or code), and lets the connection go. */
  private refuse(c: Conn, code: ErrorCode, reason: string, extra: Record<string, unknown> = {}) {
    log("phone_refused", { reason, address: c.address, phoneId: c.phone?.id ?? null, ...extra });
    this.error(c, code);
    c.ws.close(4001, code);
    this.closed(c);
  }

  private error(c: Conn, code: ErrorCode, message = MESSAGES[code] ?? code) {
    this.send(c, { type: "error", code, message });
  }

  // ── What the phone asks for ─────────────────────────────────────────────

  private talkStart(c: Conn, sessionId: string | null, talkId: string | null, dictate: boolean) {
    // A first message said needs its id (new_session names it by that), and a hub that starts sessions.
    if (dictate && (!talkId || !this.startsSessions())) return this.error(c, "invalid", `Not a message ${NAME} understands: dictate needs a talkId, and a ${NAME} that starts sessions`);
    if (this.talker && this.talker !== c) return this.turnedDown(c, "busy", talkId);
    if (this.talker === c) return; // already talking
    const err = dictate ? this.o.hub.talkStart(null, c.phone!.id, talkId, true) : this.o.hub.talkStart(sessionId, c.phone!.id, talkId);
    if (err) return this.turnedDown(c, err, talkId);
    this.talker = c;
  }

  /** A press or typed message turned down: the error, and its talk failed, with the same words. */
  private turnedDown(c: Conn, code: ErrorCode, talkId: string | null) {
    this.error(c, code);
    if (talkId) this.talkStatus(c.phone!.id, { talkId, stage: "failed", detail: MESSAGES[code] ?? code });
  }

  // ── A new session from the phone ────────────────────────────────────────

  /** The app starts sessions for the phone (PhoneHub.newSessionOptions and newSession). */
  private startsSessions() {
    return Boolean(this.o.hub.newSessionOptions && this.o.hub.newSession);
  }

  /** What the New session sheet offers (new_session_options), each field cut to the schema's lengths. */
  private async newSessionOptions(c: Conn) {
    const hub = this.o.hub;
    if (!hub.newSessionOptions || !this.startsSessions()) return this.error(c, "invalid", `This ${NAME} doesn't start sessions from the phone. Update it.`);
    let o: NewSessionOptions;
    try {
      o = await hub.newSessionOptions();
    } catch (err) {
      log("error", { where: "phone_new_session_options", message: err instanceof Error ? err.message : String(err) });
      return this.error(c, "internal");
    }
    const projects = o.projects.filter((p) => p.folder && p.folder.length <= 1000).slice(0, 500);
    this.send(c, {
      type: "new_session_options",
      projects: projects.map((p) => ({ folder: p.folder, name: p.name.slice(0, 200), detail: p.detail.slice(0, 1000) })),
      root: o.root?.slice(0, 1000) ?? null,
      harnesses: o.harnesses
        .slice(0, 20)
        .map((h) => ({ id: h.id.slice(0, 40), name: h.name.slice(0, 40), ...(h.folders ? { folders: h.folders.filter((f) => f.length <= 1000).slice(0, 500) } : {}), canName: h.canName })),
      selected: o.selected?.slice(0, 40) ?? null,
      ...(o.why ? { why: o.why.slice(0, 40) } : {}),
    });
    log("phone_new_session_options", { phoneId: c.phone!.id, projects: projects.length, harnesses: o.harnesses.map((h) => h.id), selected: o.selected });
  }

  /**
   * new_session: started by the app as the window's picker starts one, its first message typed, said
   * (the words of the press it names, told back first: heard) or none. What became of it goes to
   * every connection of that phone (new_session_status), so a phone that reconnected meanwhile hears.
   */
  private async newSession(c: Conn, m: { requestId: string; folder?: string; newProject?: string; scratch?: boolean; harness?: string; text?: string; talkId?: string; name?: string }) {
    const hub = this.o.hub;
    const phoneId = c.phone!.id;
    const status = (s: Record<string, unknown>) => {
      for (const conn of this.conns) if (conn.phone?.id === phoneId) this.send(conn, { type: "new_session_status", requestId: m.requestId, ...s });
    };
    if (!hub.newSession || !this.startsSessions()) return this.error(c, "invalid", `This ${NAME} doesn't start sessions from the phone. Update it.`);
    const ask = askOf(m);
    if ("invalid" in ask) {
      log("phone_new_session", { phoneId, requestId: m.requestId, invalid: ask.invalid });
      return status({ stage: "failed", message: ask.invalid });
    }
    log("phone_new_session", {
      phoneId,
      requestId: m.requestId,
      pick: pickKind(ask.pick),
      harness: ask.harness,
      text: Boolean(ask.text),
      spoken: Boolean(ask.talkId),
      ...(ask.name ? { name: ask.name } : {}),
    });
    let outcome: NewSessionOutcome;
    try {
      outcome = await hub.newSession(ask, phoneId, (text) => status({ stage: "heard", text: text.slice(0, 4000) }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", { where: "phone_new_session", message });
      outcome = { started: false, why: `I couldn't start it: ${message}` };
    }
    log("phone_new_session_done", { phoneId, requestId: m.requestId, ...(outcome.started ? { sessionId: outcome.sessionId } : { why: outcome.why }) });
    if (!outcome.started) return status({ stage: "failed", message: outcome.why.slice(0, 1000) });
    status({
      stage: "started",
      sessionId: outcome.sessionId.slice(0, 200),
      name: outcome.name.slice(0, 200),
      ...(outcome.text ? { text: outcome.text.slice(0, 4000) } : {}),
      ...(outcome.line ? { message: outcome.line.slice(0, 1000) } : {}),
    });
  }

  // ── What became of the phone's words ────────────────────────────────────

  /**
   * One of a phone's talks moved on (talk-status.ts): to each of its connections, and kept (the
   * latest per talk, a few recent ones) for when it reconnects.
   */
  talkStatus(phoneId: string, status: TalkStatus) {
    const now = Date.now();
    const kept = (this.talks.get(phoneId) ?? []).filter((x) => x.status.talkId !== status.talkId && now - x.at < TALKS_KEPT_MS);
    kept.push({ at: now, status });
    this.talks.set(phoneId, kept.slice(-TALKS_KEPT));
    log("phone_talk_status", {
      phoneId,
      talkId: status.talkId,
      stage: status.stage,
      sessionId: status.sessionId ?? null,
      ...(status.detail ? { detail: status.detail } : {}),
      ...(status.queued ? { queued: true } : {}),
    });
    for (const c of this.conns) if (c.phone?.id === phoneId) this.send(c, { type: "talk_status", ...status });
  }

  /** As a phone signs in: its recent talks' latest statuses, oldest first. */
  private sendTalks(c: Conn) {
    const now = Date.now();
    for (const { at, status } of this.talks.get(c.phone!.id) ?? []) if (now - at < TALKS_KEPT_MS) this.send(c, { type: "talk_status", ...status });
  }

  /**
   * A session's screen opened: its history now, then as it changes, from its agent. One still
   * starting has none yet (no agent lists it, so none has a record of it): an empty history now,
   * and its agent's once it has started (followStarted).
   */
  private watch(c: Conn, sessionId: string | null, paged: Budget | null = null) {
    c.watching?.watcher.stop();
    c.watching = null;
    if (sessionId === null) return;
    const session = findSession(ui.state.sessions, sessionId);
    if (!session) return this.error(c, "no_session");
    log("phone_watch", {
      phoneId: c.phone!.id,
      sessionId,
      ...(session.sessionId !== sessionId ? { listedAs: session.sessionId } : {}),
      agent: agentOf(session).id,
      ...(paged ? { paged: true } : {}),
    });
    const watching = { sessionId, of: session.sessionId, watcher: { stop() {} }, paged, sent: null, latest: [] };
    c.watching = watching;
    if (isStarting(session)) return this.history(c, sessionId, { items: [], truncated: false });
    const watcher = agent.watchHistory(session, (history) => this.history(c, sessionId, history));
    // Its first history may have come already (as it started): the same watch, only now stoppable.
    if (c.watching === watching) watching.watcher = watcher;
    else watcher.stop();
  }

  /**
   * A screen opened on a session while it started (its starting-… id) follows it once its agent
   * lists it (with that id as an alias): watched again, through its agent now, under the same id.
   */
  private followStarted(s: UiState) {
    for (const c of this.conns) {
      const w = c.watching;
      if (!w || !isStarting({ sessionId: w.of })) continue;
      const now = findSession(s.sessions, w.sessionId);
      if (now && now.sessionId !== w.of) this.watch(c, w.sessionId, w.paged);
    }
  }

  /**
   * A watched session's history now (as its agent gives it, whole, at once and each time it
   * changes): to an older phone whole as before (capped), to a phone that pages its window first,
   * then what changed (history_delta), nothing when nothing it shows did.
   */
  private history(c: Conn, sessionId: string, history: History) {
    const w = c.watching;
    if (w && w.sessionId !== sessionId) return;
    const doing = history.doing ? { doing: history.doing } : {};
    if (!w?.paged) {
      const old = legacy(history.items);
      return this.send(c, { type: "history", sessionId, items: old.items, truncated: history.truncated || old.cut, ...doing });
    }
    w.latest = withIds(history.items);
    const window = windowOf(w.latest, w.paged);
    const delta = w.sent ? deltaOf(w.sent, window.items) : null;
    if (w.sent && delta && !delta.items.length && w.sent.doing === history.doing) return;
    w.sent = sentOf(window.items, history.doing);
    if (delta) return this.send(c, { type: "history_delta", sessionId, ...(delta.after ? { after: delta.after } : {}), items: delta.items, ...doing });
    const more = window.cut || history.truncated;
    log("phone_history_window", { phoneId: c.phone!.id, sessionId, items: window.items.length, bytes: Buffer.byteLength(JSON.stringify(window.items)), more });
    this.send(c, { type: "history", sessionId, items: window.items, truncated: more, ...(more && window.items[0]?.id ? { cursor: window.items[0].id } : {}), ...doing });
  }

  // ── A session's screen (the chat) ───────────────────────────────────────

  /**
   * Earlier messages, as the phone scrolls up: what its agent's record says before `before`, a page
   * (history.ts historyBefore). An agent with no file of its own to read (T3 Code's threads are on
   * its server) has none: an empty page.
   */
  private historyPage(c: Conn, sessionId: string, before: string, cursor: string | null, budget: Budget) {
    const session = findSession(ui.state.sessions, sessionId);
    if (!session) return this.error(c, "no_session");
    const file = agent.historyFile(session) || undefined;
    if (cursor === null) {
      // An older phone: by time, as before (capped).
      const page = historyBefore(file, before);
      const old = legacy(page.items);
      log("phone_history_page", { phoneId: c.phone!.id, sessionId, before, items: old.items.length, more: page.more || old.cut });
      return this.send(c, { type: "history_page", sessionId, before, items: old.items, more: page.more || old.cut });
    }
    const page = this.pageBefore(c, sessionId, file, before, cursor, budget);
    const next = page.more ? page.items[0]?.id : undefined;
    log("phone_history_page", { phoneId: c.phone!.id, sessionId, cursor, items: page.items.length, bytes: Buffer.byteLength(JSON.stringify(page.items)), more: page.more });
    this.send(c, { type: "history_page", sessionId, before, cursor, items: page.items, more: page.more && next !== undefined, ...(next !== undefined ? { next } : {}) });
  }

  /**
   * A page before a cursor (an item's id): from the agent's file, read back from where that item
   * starts; for an agent with no file (T3 Code), from what it last gave (the window's earlier
   * items); a cursor the file no longer has (written again since) by time, as an older phone's.
   * Previewed and fitted to the budget as the window is.
   */
  private pageBefore(c: Conn, sessionId: string, file: string | undefined, before: string, cursor: string, budget: Budget): { items: HistoryItem[]; more: boolean } {
    const fits = (items: HistoryItem[]) => windowStart(items.map(preview), budget) > 0;
    const read = itemsBefore(file, cursor, fits);
    if (read) {
      const page = windowOf(read.items, budget);
      return { items: page.items, more: page.cut || !read.start };
    }
    const latest = c.watching?.sessionId === sessionId ? c.watching.latest : [];
    const at = latest.findIndex((i) => i.id === cursor);
    if (at >= 0) {
      const page = windowOf(latest.slice(0, at), budget);
      return { items: page.items, more: page.cut };
    }
    if (cursor.startsWith("t:")) return { items: [], more: false };
    const byTime = historyBefore(file, before);
    const page = windowOf(byTime.items, budget);
    return { items: page.items, more: page.cut || byTime.more };
  }

  /**
   * Show full: the rest of a cut item (a message's text, or one step's output and diff), read again
   * from its agent's file with more kept (core/history.ts FULL); an agent with no file, as it last
   * gave it. `missing` when the item can't be found (the file written again, the session moved on).
   */
  private showFull(c: Conn, sessionId: string, id: string, step: number | undefined) {
    const session = findSession(ui.state.sessions, sessionId);
    if (!session) return this.error(c, "no_session");
    const file = agent.historyFile(session) || undefined;
    const item = itemAt(file, id) ?? (c.watching?.sessionId === sessionId ? c.watching.latest.find((i) => i.id === id) : undefined) ?? null;
    const part = item && fullPart(item, step);
    log("phone_show_full", { phoneId: c.phone!.id, sessionId, id, ...(step !== undefined ? { step } : {}), found: Boolean(part), bytes: part ? Buffer.byteLength(JSON.stringify(part)) : 0 });
    this.send(c, { type: "full_text", sessionId, id, ...(step !== undefined ? { step } : {}), ...(part ?? { missing: true }) });
  }

  /** A session screen's Interrupt, Rename or Close: only what the session can do (canDo), then the app's, as its window menu's. */
  private sessionAction(c: Conn, sessionId: string, action: SessionAction, name: string | null) {
    const phoneId = c.phone!.id;
    const session = findSession(ui.state.sessions, sessionId);
    log("phone_session_action", { phoneId, sessionId, action, ...(name ? { name } : {}) });
    if (!session) return this.error(c, "no_session");
    const said = sessionName(session);
    if (!canDo(session)[action]) return this.sessionNote(phoneId, sessionId, `I can't ${action} ${said} from here.`);
    if (action === "rename" && !name?.trim()) return this.sessionNote(phoneId, sessionId, "What should I call it?");
    if (!this.o.hub.sessionAction) return this.sessionNote(phoneId, sessionId, `This ${NAME} can't ${action} sessions from the phone.`);
    const err = this.o.hub.sessionAction(session.sessionId, action, name, phoneId);
    if (err) this.error(c, err);
  }

  /** What came of a session screen's action, in words to show, to that phone's connections (session_note). */
  sessionNote(phoneId: string, sessionId: string, text: string) {
    for (const x of this.conns) if (x.phone?.id === phoneId) this.send(x, { type: "session_note", sessionId, text: text.slice(0, 1000) });
  }
  // ── What the phone missed, and settled (missed.ts PhonesMissed) ─────────

  /**
   * You used Kiko on the Mac (`by`, seen-on-mac.ts MacUse): what it showed in the last 2 minutes
   * was seen there.
   */
  macUsed(by: MacUse) {
    this.phonesMissed.macUsed(by);
  }

  /**
   * A permission question was answered (on the Mac: its keys or by voice; or on the phone): what a
   * phone missed of it no longer needs it.
   */
  promptSettled(promptId: string, sessionId: string, how: SettledHow) {
    this.phonesMissed.promptSettled(promptId, sessionId, how);
  }

  /**
   * A prompt that stood after its window was let go unanswered (its hold limit, under its
   * hook's limit): it waits in its terminal now. What a phone missed of it becomes `note`, a line
   * with nothing to press, until the session moves on (missed.ts promptLetGo).
   */
  promptLetGo(promptId: string, sessionId: string, name: string, note: string) {
    this.phonesMissed.promptLetGo(promptId, sessionId, name, note);
  }

  /** Words went to a session (said, typed, through its window or typed into it, from anywhere): its updates are replied to. */
  sessionReplied(sessionId: string) {
    this.phonesMissed.sessionReplied(sessionId);
  }

  // ── The plan on the phone ───────────────────────────────────────────────

  /** The account status now: null when there's none to send (accounts off, or no reader). */
  private accountNow(): AccountStatus | null {
    try {
      return this.o.account?.() ?? null;
    } catch (err) {
      log("error", { where: "phone_account", message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** To a phone just welcomed: the status as it is now (changed since the others had it: to them too). */
  private sendAccount(c: Conn) {
    const status = this.accountNow();
    if (!status) return;
    const json = JSON.stringify(status);
    if (json === this.accountSent) return this.send(c, status);
    this.accountSent = json;
    this.broadcast(status);
  }

  /**
   * The account status may have changed (each minute, or the app says so): sent to every phone
   * only when it differs from what they were last sent.
   */
  accountChanged() {
    // Signed in some other way (Settings, kiko login) while a phone waits: its sign-in ends as signed in.
    if (this.o.macSignIn && [...this.conns].some((c) => c.signIn?.held)) this.o.macSignIn.settle();
    const status = this.accountNow();
    const json = status ? JSON.stringify(status) : null;
    if (json === this.accountSent) return;
    this.accountSent = json;
    if (status) this.broadcast(status);
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  private broadcast(message: Record<string, unknown>) {
    for (const c of this.conns) if (c.phone) this.send(c, message);
  }

  private encode(message: Record<string, unknown>) {
    return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
  }

  private send(c: Conn, message: Record<string, unknown>) {
    if (c.ws.readyState !== c.ws.OPEN) return;
    c.ws.send(this.encode(message));
  }
}

/** A static X25519 public key as the protocol carries one: base64 of 32 bytes, not all zero. */
function isKey(key: string) {
  const raw = Buffer.from(key, "base64");
  return raw.length === 32 && raw.toString("base64") === key && raw.some((b) => b !== 0);
}
