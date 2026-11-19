// The app's name, and the names of what carries it outside the code: the socket, the state file,
// the config folder and the environment variables. Imports nothing, so anything can import it.
// Everything the code says or does with the name comes from here. What can't (the scripts that run
// on their own and repeat a few names, checked against these by tests/unit/core/name.test.ts; the
// Xcode projects, the relay, the wire protocol's strings) has to be renamed by hand.
//
// Two flavours of one app can be on a Mac side by side: the release (an
// installed copy) keeps every real name; a checkout of the repo runs as "Kiko Dev", with names of
// its own for everything the two must not share (flavourNames): its command, settings folder, socket,
// state file, tmux server, Keychain service and phone port. Only one runs at a time (core/running.ts
// otherRunning): both want the talk key and the mic. Everything else derives from FLAVOUR.

/** What the product is called, in what it says ("Kiko's hooks"): the same in both flavours. TITLE is this flavour's. */
export const NAME = "Kiko";
/** The product's slug: its package, its executable and the release's install folders (~/.local/share/kiko). OWN.slug is this flavour's. */
export const SLUG = "kiko";
/**
 * The reverse-DNS name everything of the app's on macOS goes under: the Keychain services
 * (flavourNames), the code-signing identifiers of the release's executables and helpers
 * (scripts/release.sh reads it from here: sh.kiko.<file>) and the keychain helper's in a
 * checkout (platform/macos/native.ts). The Keychain trusts the keychain helper by its identifier,
 * so changing this means moving the saved keys first.
 */
export const IDENTIFIER = "sh.kiko";
/**
 * The Apple team that signs the release (Developer ID Application: Bald Cactus, LLC). An installed
 * copy only takes an update whose executables carry this team's Developer ID signature, each as
 * IDENTIFIER.<file> (core/updates/verify.ts requirement); install.sh repeats it, and scripts/release.sh
 * stops a build signed by another team.
 */
export const TEAM = "YU89X2P36Z";

/** The product's site, where it's installed from and its releases are (kiko.sh/releases). */
export const DOMAIN = "kiko.sh";
/** The site's address: install.sh is served at it. */
export const SITE = `https://${DOMAIN}`;
/** Where the releases and their feed (latest.json) are, unless KIKO_RELEASES_URL says another (core/updates/). */
export const RELEASES_URL = `${SITE}/releases`;
/** The one line that installs the release. */
export const INSTALL_LINE = `curl -fsSL ${SITE} | sh`;
/**
 * The account API (the account service's API.md): the public endpoints `kiko
 * login` and the app use (core/account/client.ts), unless KIKO_ACCOUNT_URL says another.
 */
export const ACCOUNT_URL = `https://api.${DOMAIN}/v1`;
/**
 * The phone relay (relay/, src/remote/relay-client.ts): where this Mac's room is, so a paired phone
 * reaches it away from home. The default since the relay pass (relay/README.md, "Still to do" 2);
 * KIKO_RELAY_URL names another, or "off" (or empty) for none (core/config.ts relayUrlOf).
 */
export const RELAY_URL = `wss://relay.${DOMAIN}`;
/** The account's pages, for people: device approval, and the account page (the Macs signed in, signing each out). */
export const ACCOUNT_SITE = `https://account.${DOMAIN}`;
/**
 * Whether accounts are open: `kiko login`, `logout` and `account`, setup's "How do you want to run
 * Kiko?" and Settings → Account. On since 0.3.0 (2026-11-04), the account server deployed;
 * KIKO_ACCOUNTS=0 turns them off, 1 on (core/env.ts accountsLive).
 */
export const ACCOUNTS_LIVE = true;
/**
 * Whether Kiko Pro is on sale: the ways to buy it, and only those: `kiko upgrade`, setup's and the
 * trial-ended screen's "Kiko Pro" choice, the voice's "upgrade", the trial reminders' hint, and every
 * line that points to them. Off, nothing about buying shows anywhere (a Pro given by hand still shows
 * as Pro). Managing a subscription you have, or had, isn't buying: `kiko account billing`, Settings →
 * Account's Manage billing and the lines pointing to them are there whenever accounts are open.
 * Only while accounts are open too (core/env.ts proOnSale); KIKO_PRO=1 turns it on for development
 * and the tests. Setting this true is the go-live step for payments.
 */
export const PRO_ON_SALE = true;
/**
 * Whether the iPhone app is out, so the release shows it: Settings → Phone (Pair a phone, the
 * pairing code, the paired phones), the phone server and the relay, Bonjour, and every line about
 * the phone (help, setup, the window, what's said). Off again since 0.3.12 (it was on for 0.3.10 and
 * 0.3.11, for TestFlight): a release has nothing about the phone, and a `phone: true` saved earlier
 * is kept but does nothing.
 * Kiko Dev (a checkout) has it on all the same; KIKO_PHONE_LIVE=0 turns it off there, 1 on in the
 * release (core/env.ts phoneLive). Setting this true is the go-live step for the phone.
 */
export const PHONE_LIVE = false;
/**
 * Kiko Pro's prices, as said everywhere (the help, `kiko upgrade`, setup's choice): the one place to
 * change them. Tax included (Stripe, the merchant of record, takes it out of the price); the prices
 * themselves are Stripe's, by lookup key (kiko_pro_monthly, kiko_pro_yearly).
 */
export const PRO_PRICE = { month: "$8.99 a month", year: "$89 a year", yearSaves: "about 2 months free", tax: "tax included" } as const;

/** A name for the app and the two names derived from it. */
type AppNames = { name: string; slug: string; identifier: string };
/** The app's names now. */
const CURRENT: AppNames = { name: NAME, slug: SLUG, identifier: IDENTIFIER };

/** The release (an installed copy) or Kiko Dev (a checkout). */
export type Flavour = "release" | "dev";

/** The prefix of the app's environment variables (core/env.ts): KIKO_. */
export const ENV_PREFIX = `${SLUG.toUpperCase().replace(/-/g, "_")}_`;

/**
 * A checkout's .env's KIKO_ values (core/dev-env.ts, run first by each of Kiko Dev's programs), read
 * as if your shell exported them: by envVar and envVarName, for process.env only, your shell's own
 * winning. Held here, never put in process.env, so nothing a program starts inherits them. Empty
 * in the release, which reads no .env.
 */
export const dotenvVars: Record<string, string> = {};

/** `name` in `env`, else (for process.env) the .env's (dotenvVars). */
const lookUp = (name: string, env: NodeJS.ProcessEnv) => env[name] ?? (env === process.env ? dotenvVars[name] : undefined);

/** The variable that says `key`: KIKO_<key>; undefined when it isn't set (in the environment, or a checkout's .env). */
export function envVarName(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = ENV_PREFIX + key;
  return lookUp(name, env) === undefined ? undefined : name;
}

/** KIKO_<key>: the environment's, else a checkout's .env's (dotenvVars). */
export function envVar(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return lookUp(ENV_PREFIX + key, env);
}

/** Built into the installed executable (Bun's embedded files, under /$bunfs/): the same test as app-root.ts INSTALLED. */
const BUILT = import.meta.url.includes("/$bunfs/");

/**
 * The flavour: KIKO_FLAVOUR when it says release or dev (the tests' override; read from the
 * environment, not .env, which loads later), else the release when installed, Kiko Dev in a checkout.
 */
export function flavourOf(asked: string | undefined, installed: boolean): Flavour {
  const want = asked?.trim().toLowerCase();
  if (want === "release" || want === "dev") return want;
  return installed ? "release" : "dev";
}

/** This run's flavour. */
export const FLAVOUR: Flavour = flavourOf(envVar("FLAVOUR"), BUILT);
/** Kiko Dev: a checkout. */
export const DEV = FLAVOUR === "dev";

/**
 * A flavour's own names: what two copies on one Mac must not share. The release's are the real ones;
 * Kiko Dev's carry "-dev". hooks/lib.mjs and statusline/kiko-status.mjs repeat the socket and
 * state paths (they import nothing of src/).
 */
export function flavourNames(flavour: Flavour, of: AppNames = CURRENT) {
  const dev = flavour === "dev";
  const slug = dev ? `${of.slug}-dev` : of.slug;
  return {
    flavour,
    /** On screen: titles, the window, the phone's hub name. */
    title: dev ? `${of.name} Dev` : of.name,
    /** In paths: the config folder, the socket, the state file, the tmux server. */
    slug,
    /** The command on the PATH (bin/kiko-dev in a checkout). */
    command: slug,
    /** Where the agents' hooks reach the app (agents/claude-code/hooks.ts, hooks/lib.mjs). */
    socket: `/tmp/${slug}.sock`,
    /** What the app is doing, for the status line (statusline/kiko-status.mjs). */
    state: `/tmp/${slug}.state.json`,
    /** ~/.config/<this>/: settings, the dictionary, the names given to sessions, the phones paired, the lock. */
    configFolder: slug,
    /** Its own tmux server (`tmux -L <this>`). */
    tmuxServer: slug,
    /** The Keychain service its API keys are kept under (native/macos/keychain.swift). */
    keychainService: dev ? `${of.identifier}.dev.keys` : `${of.identifier}.keys`,
    /** The port the phone reaches it on: one apart, so a phone paired with one never reaches the other instead. */
    phonePort: dev ? 7334 : 7333,
    /**
     * The helper app's name (platform/macos/helper-app.ts, scripts/build-helper-app.sh): its bundle
     * ("<this>.app"), its executable and what macOS's prompts and System Settings call it.
     */
    helperApp: dev ? `${of.name} Dev` : of.name,
    /**
     * Its bundle id, which macOS keeps its permissions under: the two flavours never share a grant.
     * The release's is IDENTIFIER.helper, as each signed file is IDENTIFIER.<file> (core/updates/verify.ts requirement).
     */
    helperAppId: dev ? `${of.identifier}.dev.helper` : `${of.identifier}.helper`,
  };
}
export type FlavourNames = ReturnType<typeof flavourNames>;

/** This flavour's own names. */
export const OWN = flavourNames(FLAVOUR);
/** The other flavour's: the one that mustn't be running when this one starts. */
export const OTHER = flavourNames(DEV ? "release" : "dev");
/** On screen: "Kiko", or "Kiko Dev" for a checkout. */
export const TITLE = OWN.title;
/** The command that opens it: `kiko`, or `kiko-dev`. */
export const COMMAND = OWN.command;

/**
 * What you call the app, out loud, until you pick another (the spokenName setting): the word that
 * wakes it hands-free ("Kiko, ask Lacy …") and the name it calls itself when it speaks ("Hi, I'm
 * Kiko"). One name for both. NAME stays the product's, on screen and in docs.
 */
export const SPOKEN_DEFAULT = "Kiko";
/**
 * How the Mac's own voices are told to say NAME, which they get wrong as it's written
 * (core/pronunciation.ts): as written, Reed and Eddy say "Kiko" KYE-koh (Apple writes "Kaido",
 * "Kaito", "Coco") and Flo KAY-koh ("Keiko", "Kaiko"); "Keeko" gives them KEE-koh, and the voices
 * that said it right go on saying it right (`say` through the app's Apple helper, 2026-11-03: 4
 * phrases × 11 voices, "Kiko" in the transcript 27/44 as written, 29/44 as "Keeko"; "Keekoh" 14/44).
 */
export const NAME_SAID_AS = "Keeko";

/**
 * How speech-to-text writes the built-in spoken names, by the name in lower case. `heard`: spellings
 * that can't mean anything else, fixed by the dictionary (dictionary.ts) and taken as the name up
 * front (wake.ts). `atStart`: real words it writes for the name, the name only when they open what
 * you said, never mid-sentence, so never a dictionary entry (none yet: scripts/perf/wake-names.ts
 * and wake-name.ts measure candidates). A name of your own has none.
 * Kiko: "Kiku" (how speech-to-text wrote it in real use), and what Apple wrote for it
 * in the wake tests (scripts/perf/wake-names.ts, wake-parrot and noise runs): "Giko", "Gico", "Chiko",
 * "Kico", and "Keeko" as the voices are told to say it. None woke anything it shouldn't there or in
 * real transcripts. Never "Keiko", a
 * name of its own ("Hey Keiko" is already the one near-miss that wakes it), nor "Geico", "Kito",
 * "Kika" or "people". Chico and Pico (Apple's commonest misses after "people": UK and Indian voices)
 * would take the clean `say` clips from 63% to 70.5% as `atStart`, at 3 more near-miss false wakes
 * in 160 ("Hey Keiko" → "Hey, Chico", "Tico Tico" → "Pico, Pico"): left out.
 */
const MISHEARD: Record<string, { heard: string[]; atStart: string[] }> = {
  kiko: { heard: ["kiku", "keeko", "kico", "chiko", "giko", "gico"], atStart: [] },
};

/**
 * How speech-to-text writes DOMAIN besides "<the name or a spelling of it> dot S H", which the
 * dictionary's built-in entries make from NAME and `misheard` (dictionary.ts builtInEntries). From
 * `say` voices reading "Keeko dot S H" (and "dot shh", "dot ess aitch") through the app's Apple
 * helper, 2026-11-03: "kiko.sa" (UK, Australian and Irish voices), "Kikode.sa", "Kiko Dodge" and
 * "Kiko dotch" (for "dot shh"), "Kiko dot ESH" / "kiko.esh", "keto dot SH" / "keto.SH". Only whole
 * phrases: "keto" alone is a word, and stays one.
 */
export const DOMAIN_HEARD = ["kiko.sa", "kikode.sa", "kiko dodge", "kiko dotch", "kiko dot esh", "kiko.esh", "keto dot sh", "keto.sh"];

/** How speech-to-text may write `name` (a built-in one's spellings; none for a name of your own). */
export function misheard(name: string): { heard: string[]; atStart: string[] } {
  return MISHEARD[name.trim().toLowerCase()] ?? { heard: [], atStart: [] };
}

/**
 * A spoken name as typed, made usable: letters, digits, spaces, hyphens and apostrophes, at most
 * three words and 30 characters, a capital first when it's typed all in lower case ("jarvis" →
 * "Jarvis"). Empty when nothing usable is left: the default then.
 */
export function cleanSpokenName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const words = raw
    .replace(/[^\p{L}\p{N}'’ -]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-'’]+|[-'’]+$/g, ""))
    .filter((w) => /[\p{L}]/u.test(w))
    .slice(0, 3);
  const name = words.join(" ").slice(0, 30).trim();
  return name === name.toLowerCase() ? name.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()) : name;
}

// The spoken name this run: config.ts sets it from the setting at start, the settings screen when
// you change it. Read at each use (wake.ts, the dictionary, the hints, what's shown and said), so a
// change applies to the next words, without a restart.
let spoken = SPOKEN_DEFAULT;

/** What you call the app, out loud, now (SPOKEN_DEFAULT unless the spokenName setting says another). */
export const spokenName = () => spoken;

/** Sets the spoken name for this run (cleaned; nothing usable is the default). Returns it as set. */
export function setSpokenName(raw: unknown): string {
  spoken = cleanSpokenName(raw) || SPOKEN_DEFAULT;
  return spoken;
}

/** Where Claude Code's hooks reach the running app (agents/claude-code/hooks.ts, hooks/claude-code-hook.mjs). */
export const SOCKET_PATH = OWN.socket;
/** The port the phone reaches the app on, unless KIKO_PHONE_PORT says another (src/remote/server.ts). */
export const PHONE_PORT = OWN.phonePort;
/** What the app is doing, for the status line (statusline/kiko-status.mjs). */
export const STATE_PATH = OWN.state;
/** Settings, the dictionary and the names given to sessions: ~/.config/<this>/. */
export const CONFIG_FOLDER = OWN.configFolder;
/** The status line add-on's script, in statusline/ (a file of that name: renaming the app renames it). */
export const STATUS_LINE_SCRIPT = `${SLUG}-status.mjs`;
