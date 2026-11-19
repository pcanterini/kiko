// Many candidate names for the app, side by side, as wake words on Apple's recognizer (the app's
// default, and hands-free's only one): for each name, does "Hey <Name>, …" wake it, and do everyday
// phrases that sound like the name wake it when nobody called it? wake-name.ts goes deep on one name
// (Deepgram, ElevenLabs, spellings to add); this one is wide, Apple and `say` only, no keys at all.
//
//   Positives: 10 phrases with the name where you'd say it, read by every voice. `say` gets the
//     name as it should sound (`say`, a respelling where the spelling would mislead it: "Loozo"),
//     and the transcript must give the name as spelled (`name`).
//   Negatives: the name's own near-misses (real words and phrases that sound like it, said where
//     the name would be: at the start), plus two shared ones. Every name is also scored against
//     every other name's negatives ("others": what the whole set of near-misses does to it).
//   The app's pipeline: the built-in name fixes (dictionary.ts, none of yours) and wake.ts wakeIn,
//     with the spoken name set to the candidate. "woke": the final words wake it; "live": any live
//     transcript on the way did (hands-free acts on those, so a false wake there counts).
//   "One spelling": the spelling Apple gave most often for the name in the misses, when it is no
//     English word (/usr/share/dict/words, and not a phrase), as if added to name.ts misheard
//     `heard` (fixed to the name anywhere): the rate it would reach, and what it would newly wake.
//
//   bun scripts/perf/wake-names.ts [--work <dir>] [--out scripts/perf/wake-names-<date>.json]
//       [--names Mando,Luzo] [--voices "Samantha (English (US)),…"] [--parallel 4] [--from <json>]
//   --from keeps an earlier run's rows (no audio for those) and runs only the names it has none for.
//   "Natural" leaves out the Eloquence voices (Reed, Eddy, Flo), which sink every name alike.
//
// Never plays audio or opens the mic, never starts the app or touches its config, sockets or tmux.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Apple, hash, nameSlot, padded, pool, RATE, renderSayBatch, wavPcm } from "./wake-lib.ts";

const ROOT = join(import.meta.dirname, "../..");
const { values: flags } = parseArgs({
  options: {
    work: { type: "string", default: join(tmpdir(), "kiko-wake-names") },
    out: { type: "string", default: join(ROOT, `scripts/perf/wake-names-${new Date().toISOString().slice(0, 10)}.json`) },
    names: { type: "string" },
    voices: { type: "string" },
    parallel: { type: "string", default: "4" },
    from: { type: "string" },
  },
});
const WORK = flags.work!;
const CLIPS = join(WORK, "clips");
mkdirSync(CLIPS, { recursive: true });

// The app's modules write a log and read settings at import: point both at the work folder first.
process.env.KIKO_LOG_DIR = join(WORK, "logs");
process.env.KIKO_SETTINGS = join(WORK, "settings.json");
const { applyDictionary } = await import("../../src/core/dictionary.ts");
const { wakeIn } = await import("../../src/core/wake.ts");
const { setSpokenName } = await import("../../src/core/name.ts");

// ── Phrases ──────────────────────────────────────────────────────────────────────────────────────
// {N} is the name. `next`: the first word after it, to find what the recognizer wrote for the name.
const POSITIVES: Array<{ text: string; next: string }> = [
  { text: "{N}, what's the status?", next: "what" },
  { text: "Hey {N}, ask Lacy to run the tests.", next: "ask" },
  { text: "Okay {N}, read me the last reply.", next: "read" },
  { text: "Hey {N}.", next: "" },
  { text: "{N}, stop.", next: "stop" },
  { text: "Hi {N}, what did Claude say?", next: "what" },
  { text: "{N}, tell Claude to commit the changes.", next: "tell" },
  { text: "Tell {N} to check the logs.", next: "to" },
  { text: "Um, {N}, cancel that.", next: "cancel" },
  { text: "{N}, how much did today cost?", next: "how" },
];
const SHARED_NEGATIVES = ["Hello, can you hear me?", "Hey, what's up?"];

// `mid`: everyday speech with the name in it, not said to the app (a real word's own uses: "My
// parrot can talk", "Parrot food is …"), scored apart from the near-misses as "mid" false wakes.
type Candidate = { name: string; say?: string; from: string; negatives: string[]; mid?: string[] };
// `from`: where the name came from (an earlier round of names, or new). Negatives: words
// and phrases that sound like it, said up front, where a false wake would happen.
const CANDIDATES: Candidate[] = [
  // Controls: the 2026-11-02 run's best other name, and Fala, the name Kiko replaced.
  { name: "Jarvis", from: "control", negatives: ["Jar of this, please.", "Hey Travis, how are you?", "Harvest is in the fall.", "Darvish pitched today.", "Car, this way.", "Charvis said hello."] },
  { name: "Fala", from: "control", negatives: ["I'll follow up tomorrow.", "Hey fella, nice to meet you.", "Follow, then lead.", "Hola, everyone.", "Hey Paula, how are you?", "Fella, come here."] },
  // Coined names, round 1: the ones the app's engine heard best.
  { name: "Mando", from: "round 1", negatives: ["Man, though, that was close.", "Hey man, don't.", "Commando mode is on.", "Mondo weird day.", "Hey Brando, nice movie.", "Mango smoothie, please."] },
  { name: "Luzo", say: "Loozo", from: "round 1", negatives: ["Lose a few, win a few.", "Hey Lou, so what's up?", "Lizzo is on tour.", "Loser, come here.", "Lucy, go home.", "Hey Bruno, let's go."] },
  {
    name: "Lazo",
    say: "Lahzo",
    from: "round 1",
    negatives: ["Lasso the calf.", "Lots of people came.", "Hey Laszlo, nice to see you.", "Laser pointer, please.", "Lars, though, said no.", "Lazy morning today."],
  },
  {
    name: "Rumo",
    say: "Roomo",
    from: "round 1",
    negatives: ["Rumor has it.", "Roomie, are you home?", "Hey Romeo, come here.", "Room, oh my god.", "Remove the old files.", "Hey Rumi, read me a poem."],
  },
  { name: "Molo", from: "round 1", negatives: ["Mellow out a bit.", "Mojo is back.", "Hey Milo, sit.", "Merlot, please.", "Hey Marlo, what's up?", "Moe, look at this."] },
  { name: "Lubo", say: "Loobo", from: "round 1", negatives: ["Lube the chain.", "Hey Lou, but no.", "Loopy day today.", "Luba called earlier.", "Lou, bow down.", "Hey Lupo, come here."] },
  {
    name: "Rubo",
    say: "Roobo",
    from: "round 1",
    negatives: ["Rube Goldberg machine.", "Robo vacuum is stuck.", "Hey Ruby, come here.", "Ruble fell today.", "Rubber ducks everywhere.", "Rue, but no."],
  },
  { name: "Zinzo", from: "round 1", negatives: ["Zen, so calm.", "Hey Enzo, nice car.", "Since, oh, last year.", "Zinc oxide sunscreen.", "Hey Jinx, so what?", "Sins of the past."] },
  { name: "Kibo", say: "Keebo", from: "round 1", negatives: ["Keep, oh, keep going.", "Kebab for lunch.", "Hey Kimbo, come here.", "Key, but no.", "Kibble for the dog.", "Gibbon in the zoo."] },
  // Words for "talk", "say", "hello" (rounds 4–7) and made-up ones (round 9).
  {
    name: "Toki",
    say: "Tokee",
    from: "new (Toki Pona: speech, hello)",
    negatives: ["Tokyo is busy.", "Talky today, aren't you.", "Hey Tony, come here.", "Toaster is broken.", "Okie dokie.", "Token expired."],
  },
  { name: "Kotoba", from: "round 6", negatives: ["Cut to the chase.", "Kota, but why?", "Got to go, bye.", "Cordoba is in Spain.", "Hey Kota, the bus is here.", "Katowice is cold."] },
  { name: "Pamoja", from: "round 6", negatives: ["Pajama party tonight.", "Pa, more juice please.", "Pamela, come here.", "Pandora radio, please.", "Panorama mode is on.", "Hey Pam, oh yeah."] },
  { name: "Kwento", from: "round 6", negatives: ["Quentin, come here.", "Kwanza starts soon.", "Twenty, though, not ten.", "Kent, oh, wait.", "Quantum computers are coming.", "Hey Quinto, look."] },
  { name: "Habari", from: "round 6", negatives: ["How buried is it?", "Hey Barry, how are you?", "Harbor is busy.", "Habit is everything.", "Hubbard Street is closed.", "Ha, Bari is nice."] },
  { name: "Parolu", from: "round 6", negatives: ["Parole hearing is today.", "Pearl, oh, look.", "Paralegal called.", "Hey Carol, look.", "Payroll is due.", "Barolo wine, please."] },
  { name: "Kaho", from: "round 4", negatives: ["Cairo is hot.", "Car, ho!", "Cahoots with them.", "Kayo, come here.", "Cargo shipped today.", "Kahlo painted it."] },
  { name: "Vorba", from: "round 6", negatives: ["Forbes says so.", "Verbal warning given.", "Hey Bubba, come here.", "Vorbis is an audio format.", "Four, but no.", "Barbara called."] },
  { name: "Vocari", from: "round 9", negatives: ["Vocabulary test today.", "Ferrari is fast.", "Ivory is white.", "Hey Atari, play.", "Vocal range is wide.", "Vicar, he said no."] },
  { name: "Karvel", from: "round 9", negatives: ["Carvel ice cream cake.", "Carnival tonight.", "Marvel movie later.", "Carve all of it.", "Hey Carl, well done.", "Gravel road ahead."] },
  { name: "Zenva", from: "round 9", negatives: ["Geneva is pretty.", "Zen, but okay.", "Send a message.", "Seven of them.", "Xena was a show.", "Hey Zena, hi."] },
  { name: "Echra", say: "Eckra", from: "round 9", negatives: ["Ecru is a color.", "Echo, are you there?", "Extra cheese, please.", "Accra is in Ghana.", "Hey Ezra, come here.", "Acre of land."] },
  { name: "Spekla", from: "round 9", negatives: ["Speckle the paint.", "Spectacle of it all.", "Speak low, please.", "Spackle the wall.", "Spec, la la.", "Specular highlights."] },
  { name: "Dictra", from: "round 9", negatives: ["Dictate this note.", "Dick Lucy was a comic.", "Dictionary, please.", "Victor, come here.", "Dexter is on.", "Tick, tock."] },
  // New: short, hard consonants, two syllables (2026-11-02).
  { name: "Kato", say: "Kahto", from: "new (the Green Hornet's partner)", negatives: ["Gotta go.", "Cato the elder.", "Kate, oh, wait.", "Kudos to you.", "Cuddle the cat.", "Cotto salami, please."] },
  { name: "Zuko", say: "Zooko", from: "new", negatives: ["Zoo, go see the lions.", "Sue, go home.", "Sugar, please.", "Zucchini bread.", "Hey Suki, come here.", "Juco football."] },
  { name: "Tiko", say: "Teeko", from: "new", negatives: ["Taco Tuesday.", "Tea, go get some.", "Tick, oh no.", "Hey Rico, come here.", "Tico and the gang.", "Tekken is a game."] },
  { name: "Bixo", from: "new (Portuguese bicho: critter)", negatives: ["Bix, oh, wait.", "Big show tonight.", "Biscuit for the dog.", "Bistro is closed.", "Hey Dixon.", "Picks, oh, nice."] },
  { name: "Vexo", from: "new", negatives: ["Vex, oh no.", "Vexing problem.", "Hey Rex, oh boy.", "Becks, oh wait.", "Exo planet found.", "Next, oh, sorry."] },
  { name: "Kipo", say: "Keepo", from: "new", negatives: ["Keep owing.", "Keep on going.", "Hippo at the zoo.", "Keeper of the keys.", "Kip, oh, wake up.", "Typo in the readme."] },
  { name: "Taku", say: "Tahkoo", from: "new (Japanese name; sounds like talk)", negatives: ["Taco night.", "Talk to me.", "Talk, oh, wait.", "Tycoon game.", "Hey Tucker.", "Tuck, ooh."] },
  { name: "Teko", say: "Tecko", from: "new", negatives: ["Techno music.", "Tech, oh, wait.", "Echo, play music.", "Tacky shirt.", "Deck, oh no.", "Tekken tournament."] },
  { name: "Mako", say: "Mahko", from: "new (the shark)", negatives: ["Macho man.", "Make, oh, make it.", "Marco Polo.", "Hey Marco, how are you?", "Mocha latte, please.", "Mac, oh no."] },
  { name: "Yuzu", from: "new (the citrus)", negatives: ["You, sue them.", "Use the old one.", "Hey Suzu.", "Usual, please.", "Juice, please.", "Hey Susu."] },
  { name: "Zola", from: "new", negatives: ["Solar panels.", "Sola, the movie.", "Cola, please.", "Hey Lola, come here.", "Zoloft prescription.", "So, la la."] },
  { name: "Quokka", from: "new (the smiling marsupial)", negatives: ["Coca-Cola, please.", "Quaker oats.", "Walk a little.", "Cocoa, please.", "Quicker, please.", "Polka dance."] },
  { name: "Jeeves", from: "round 3 (the butler)", negatives: ["Jeez, this is hard.", "Geez, wow.", "Thieves broke in.", "Eves are long.", "Jeans are blue.", "Hey Steve, look."] },
  { name: "Ziko", say: "Zeeko", from: "new", negatives: ["Zico scored.", "Psycho movie.", "Seek, oh, find it.", "Zig, oh, zag.", "Hey Nico, come here.", "Sicko mode."] },
  { name: "Kubo", say: "Koobo", from: "new", negatives: ["Cube, oh, wait.", "Cuba is warm.", "Hey Kobe.", "Cuckoo clock.", "Coo, but no.", "Kudos, team."] },
  { name: "Kumo", say: "Koomo", from: "new (Japanese: cloud)", negatives: ["Come, oh, come here.", "Cuomo spoke today.", "Hey Como.", "Cool mode on.", "Coming home.", "Komodo dragon."] },
  { name: "Gonzo", from: "round 2", negatives: ["Gone, so sad.", "Gonna go now.", "Hey Alonzo.", "Gonzaga won.", "Bonzo the dog.", "Gun, so loud."] },
  { name: "Pipoca", say: "Pipoka", from: "new (Portuguese: popcorn)", negatives: ["People, come here.", "Peep, okay.", "Hey Pip, okay?", "Pinocchio lied.", "Pipe a call.", "Bazooka Joe."] },
  // Second pass, the shape the first one rewarded (Gonzo, Rubo, Zinzo, Zuko): two syllables, a Z,
  // G or R and a cluster ("nz", "rb"), an "-o" or "-a" ending; and two names Apple already knows.
  { name: "Zorba", from: "new (Zorba the Greek)", negatives: ["Zorro is a movie.", "Sore back today.", "Sorbet, please.", "Cobra in the grass.", "Zumba class tonight.", "Your bar is open."] },
  { name: "Mowgli", from: "new (The Jungle Book)", negatives: ["Mogul, he said.", "Moldy bread.", "Mostly fine.", "Hey Molly, come here.", "Mobile, please.", "Ugly, really."] },
  { name: "Renzo", from: "new", negatives: ["Rents are high.", "Hey Enzo.", "Lenses are dirty.", "Wren, so small.", "Ranch dressing, please.", "Rent, oh no."] },
  { name: "Ronzo", from: "new", negatives: ["Ron, so what?", "Bronze medal.", "Hey Lonzo.", "Rondo in C.", "Ron's okay.", "Wrong, so wrong."] },
  { name: "Ganzo", say: "Gahnzo", from: "new", negatives: ["Gonzo journalism.", "Gans, oh wow.", "Hans, oh, come here.", "Kansas is flat.", "Gun, so loud.", "Garza called."] },
  { name: "Zenzo", from: "new", negatives: ["Zen, so calm.", "Hey Enzo, nice car.", "Sensor is broken.", "Cents, oh well.", "Zest, oh, lemon.", "Sends out the mail."] },
  { name: "Zanzo", say: "Zahnzo", from: "new", negatives: ["Sands of time.", "Hans, oh, hey.", "Sancho said hi.", "Stanza two.", "Zanzibar is warm.", "Son, so proud."] },
  { name: "Lenzo", from: "new", negatives: ["Lenses are clean.", "Lens, oh no.", "Lorenzo said hi.", "Lend, so kind.", "Hey Enzo.", "Linzer cookies."] },
  { name: "Zango", say: "Zahngo", from: "new", negatives: ["Tango lessons.", "Mango, please.", "Sang, oh boy.", "Zangief wins.", "Sango is a language.", "Django is a framework."] },
  { name: "Zubo", say: "Zoobo", from: "new", negatives: ["Zoo, but no.", "Tuba solo.", "Sue, but no.", "Scuba diving.", "Zumba class.", "Hey Dubois."] },
  { name: "Gozo", from: "new (the Maltese island)", negatives: ["Go, so fast.", "Goes on and on.", "Gonzo journalism.", "Go, Zoe!", "Godzilla movie.", "Cozy evening."] },
  { name: "Zumo", say: "Zoomo", from: "new", negatives: ["Zoom, oh no.", "Sumo wrestling.", "Zoom out.", "Assume, oh.", "Hey Sumo.", "Zooming in."] },
  { name: "Bruzo", say: "Broozo", from: "new", negatives: ["Bruise, oh, ouch.", "Bruce, oh, hey.", "Brews on tap.", "Bruno, come here.", "Brussels sprouts.", "Bro, so cool."] },
  { name: "Dunzo", from: "new", negatives: ["Done, so done.", "Dunno, really.", "Dumbo the elephant.", "Dunes, oh wow.", "Duncan, come here.", "Donzo, we're finished."] },
  { name: "Zonko", from: "new", negatives: ["Zonked out.", "Bonkers day.", "Zone, go.", "Song, oh.", "Honk, oh!", "Sonic, go."] },
  { name: "Zarko", from: "new", negatives: ["Sarcastic, huh.", "Marco Polo.", "Zara, go.", "Czar, go away.", "Sark, oh.", "Hey Marco."] },
  { name: "Rizo", say: "Reezo", from: "new", negatives: ["Rizz, oh.", "Risotto, please.", "Rizzo said hi.", "Reese, oh.", "Ritz crackers.", "Reason, oh."] },
  { name: "Vanzo", from: "new", negatives: ["Vans, oh nice.", "Van, so big.", "Banzai!", "Fans, oh wow.", "Vance, oh.", "Bonzo the dog."] },
  { name: "Zuri", say: "Zoori", from: "new (Swahili: beautiful)", negatives: ["Zurich is cold.", "Jury duty.", "Sorry, my bad.", "Hey Suri.", "Surely not.", "Fury road."] },
  { name: "Ozzo", from: "new", negatives: ["Oz, oh.", "Ozzy rocks.", "Also, wait.", "Oslo is cold.", "Ouzo, please.", "Ozone layer."] },
  { name: "Rinzo", from: "new", negatives: ["Rinse, oh.", "Rinse it out.", "Linzer cookies.", "Lorenzo, come here.", "Rims, oh no.", "Wince, oh."] },
  // 2026-11-02, later: one more, run alone against the run above (--from).
  { name: "Kiko", say: "Keeko", from: "new", negatives: ["Keep going.", "Kick off at noon.", "Cocoa, please.", "Hey Keiko.", "Key code is wrong.", "Tico Tico."] },
  // 2026-11-03: a real English word against Kiko (not a rename): does a word Apple knows wake better,
  // and what does the word's everyday use do? Run with Kiko as the control (--names Parrot,Kiko).
  {
    name: "Parrot",
    from: "test (Heard's Parrot)",
    negatives: [
      "Pirate, ahoy!",
      "Carrot cake, please.",
      "Parent conference at noon.",
      "Hey Perot, nice to meet you.",
      "Pair of shoes, please.",
      "Paris is lovely.",
      "Merit, not luck.",
      "Ferret, come here.",
    ],
    mid: [
      "My parrot can say hello.",
      "I bought a parrot yesterday.",
      "Don't just parrot what they said.",
      "The parrot is asleep, so be quiet.",
      "We saw a parrot at the zoo. It was loud.",
      "Polly is a pet parrot.",
      "Parrot food is expensive.",
      "I have a bird. Parrot food is expensive.",
      "Parrots are smart birds.",
    ],
  },
];

const DEFAULT_VOICES = [
  "Samantha (English (US))",
  "Reed (English (US))",
  "Eddy (English (US))",
  "Daniel (English (UK))",
  "Flo (English (UK))",
  "Karen",
  "Moira (English (Ireland))",
  "Rishi (English (India))",
  "Aman",
  "Tessa (English (South Africa))",
];
const VOICES = flags.voices ? flags.voices.split(",").map((v) => v.trim()) : DEFAULT_VOICES;
const wanted = flags.names ? new Set(flags.names.split(",").map((n) => n.trim().toLowerCase())) : null;
const NAMES = CANDIDATES.filter((c) => !wanted || wanted.has(c.name.toLowerCase()));
// What the app gives the recognizer to expect besides the name (stt-hints.ts, without your dictionary or sessions).
const hintsFor = (name: string) => [name, "Claude Code", "Codex", "OpenCode", "T3 Code"];

// ── The app's pipeline ───────────────────────────────────────────────────────────────────────────
const NO_ENTRIES: Parameters<typeof applyDictionary>[1] = [];
/** As the app takes the words with `name` as the spoken name: the built-in name fixes, then the wake check. */
function wakes(name: string, text: string) {
  setSpokenName(name);
  return wakeIn(applyDictionary(text, NO_ENTRIES).text) !== null;
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `text` with `spelling` written as `name` wherever it is (what a name.ts `heard` spelling does). */
const respell = (text: string, spelling: string, name: string) => text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${spelling.split(/\s+/).map(escape).join("[\\s-]*")}(?![\\p{L}\\p{N}])`, "giu"), name);

// ── Running ──────────────────────────────────────────────────────────────────────────────────────
type Row = {
  name: string;
  set: "positive" | "negative" | "mid";
  voice: string;
  text: string;
  template?: string;
  next?: string;
  transcript: string;
  live: string[];
  slot?: string;
};
// --from: the rows of an earlier run, kept; only names it has no rows for are run (none: analysed again, no audio).
const prior = flags.from ? JSON.parse(readFileSync(flags.from, "utf8")) : null;
const rows: Row[] = (prior?.rows ?? []).map((r: Row) => ({ ...r, live: r.live ?? [] }));
const TO_RUN = NAMES.filter((c) => !rows.some((r) => r.name === c.name));

if (TO_RUN.length) {
  type Job = Omit<Row, "transcript" | "live" | "slot"> & { file?: string };
  const jobs: Job[] = [];
  for (const c of TO_RUN)
    for (const voice of VOICES) {
      for (const p of POSITIVES) jobs.push({ name: c.name, set: "positive", voice, text: p.text.replace("{N}", c.say ?? c.name), template: p.text, next: p.next });
      for (const n of [...c.negatives, ...SHARED_NEGATIVES]) jobs.push({ name: c.name, set: "negative", voice, text: n });
      for (const n of c.mid ?? []) jobs.push({ name: c.name, set: "mid", voice, text: n });
    }
  console.log(`${TO_RUN.length} names, ${VOICES.length} voices: ${jobs.length} clips. Rendering with say…`);
  // One `say` per name and voice (renderSayBatch): a call's start-up is most of a clip's time.
  const groups = TO_RUN.flatMap((c) => VOICES.map((voice) => ({ voice, texts: jobs.filter((j) => j.name === c.name && j.voice === voice).map((j) => j.text) })));
  let rendered = 0;
  await pool(groups, 6, async (g) => {
    await renderSayBatch(CLIPS, g.voice, g.texts);
    if (++rendered % 50 === 0) console.log(`  rendered ${rendered}/${groups.length} batches`);
  });
  for (const j of jobs) j.file = join(CLIPS, `say-${hash(j.voice, j.text)}.wav`);

  // Apple: the app's own helper, built here (never into native/macos/.build).
  const binary = join(WORK, "speech");
  if (!existsSync(binary)) execFileSync("swiftc", ["-O", join(ROOT, "native/macos/speech.swift"), "-o", binary]);
  const apples = Array.from({ length: Number(flags.parallel) }, () => new Apple(binary));
  const started = Date.now();
  for (const c of TO_RUN) {
    const mine = jobs.filter((j) => j.name === c.name);
    for (const a of apples) if (a.setHints(hintsFor(c.name))) await a.transcribe(Buffer.alloc(RATE)); // a press for the hints to apply
    await pool(mine, apples.length, async (j, w) => {
      const heard = await apples[w].transcribe(padded(wavPcm(j.file!)));
      const { file: _, ...rest } = j;
      rows.push({ ...rest, transcript: heard.text, live: heard.live, slot: j.template ? nameSlot(heard.text, j.template, j.next ?? "") : undefined });
    });
    const secs = (Date.now() - started) / 1000;
    console.log(`${c.name}: ${mine.length} clips (${secs.toFixed(0)} s so far)`);
  }
  for (const a of apples) a.close();
}

// ── Scoring ──────────────────────────────────────────────────────────────────────────────────────
const DICT = new Set(
  existsSync("/usr/share/dict/words")
    ? readFileSync("/usr/share/dict/words", "utf8")
        .split("\n")
        .map((w) => w.trim().toLowerCase())
    : [],
);
/** A spelling that can only be the name: one word of four letters or more, no English word (or its plural). */
const isSpelling = (w: string) => /^[a-z]{4,}$/.test(w) && !DICT.has(w) && !(w.endsWith("s") && DICT.has(w.slice(0, -1)));
// Eloquence voices (robotic, older engine): reported apart, since they sink every name alike.
const ELOQUENCE = new Set(["Reed (English (US))", "Eddy (English (US))", "Flo (English (UK))"]);
const pct = (hits: number, n: number) => (n ? Math.round((1000 * hits) / n) / 10 : 0);
const allNegatives = rows.filter((r) => r.set === "negative");

const results = NAMES.filter((c) => rows.some((r) => r.name === c.name)).map((c) => {
  const pos = rows.filter((r) => r.name === c.name && r.set === "positive");
  const neg = rows.filter((r) => r.name === c.name && r.set === "negative");
  const others = allNegatives.filter((r) => r.name !== c.name);
  const posWoke = pos.map((r) => wakes(c.name, r.transcript));
  const posLive = pos.map((r, i) => posWoke[i] || r.live.some((t) => wakes(c.name, t)));
  const falseOf = (rs: Row[]) => rs.filter((r) => wakes(c.name, r.transcript) || r.live.some((t) => wakes(c.name, t)));
  const ownFalse = falseOf(neg);
  const mid = rows.filter((r) => r.name === c.name && r.set === "mid");
  const midFalse = falseOf(mid);
  // "Hey <Name>, …" and "Hey <Name>." alone.
  const heyIdx = pos.map((r, i) => (r.template?.startsWith("Hey ") ? i : -1)).filter((i) => i >= 0);
  const otherFalse = falseOf(others);

  const byVoice: Record<string, number> = {};
  for (const v of VOICES) {
    const idx = pos.map((r, i) => (r.voice === v ? i : -1)).filter((i) => i >= 0);
    if (idx.length) byVoice[v] = pct(idx.filter((i) => posWoke[i]).length, idx.length);
  }
  // What Apple wrote for the name, most often first; and the misses' spellings.
  const heardAs: Record<string, number> = {};
  const missSpellings: Record<string, number> = {};
  pos.forEach((r, i) => {
    const s = r.slot || "(nothing)";
    heardAs[s] = (heardAs[s] ?? 0) + 1;
    if (!posWoke[i] && r.slot && r.slot.split(" ").length <= 2 && r.slot !== c.name.toLowerCase()) missSpellings[r.slot] = (missSpellings[r.slot] ?? 0) + 1;
  });
  // One spelling to add: the commonest miss that is no English word (one word, not in the dictionary).
  const fix = Object.entries(missSpellings)
    .sort((a, b) => b[1] - a[1])
    .find(([w]) => isSpelling(w));
  let withFix = null;
  if (fix) {
    const [spelling] = fix;
    const hit = pos.filter((r) => wakes(c.name, respell(r.transcript, spelling, c.name))).length;
    const falseN = [...neg, ...others].filter((r) => wakes(c.name, respell(r.transcript, spelling, c.name)) || r.live.some((t) => wakes(c.name, respell(t, spelling, c.name)))).length;
    withFix = { spelling, wake: pct(hit, pos.length), falseWakes: falseN - ownFalse.length - otherFalse.length };
  }
  return {
    name: c.name,
    say: c.say ?? c.name,
    from: c.from,
    wake: pct(posWoke.filter(Boolean).length, pos.length),
    wakeLive: pct(posLive.filter(Boolean).length, pos.length),
    wakeNatural: pct(pos.filter((r, i) => posWoke[i] && !ELOQUENCE.has(r.voice)).length, pos.filter((r) => !ELOQUENCE.has(r.voice)).length),
    positives: pos.length,
    wakeHey: pct(heyIdx.filter((i) => posWoke[i]).length, heyIdx.length),
    wakeHeyNatural: pct(heyIdx.filter((i) => posWoke[i] && !ELOQUENCE.has(pos[i].voice)).length, heyIdx.filter((i) => !ELOQUENCE.has(pos[i].voice)).length),
    misses: pos.filter((_, i) => !posWoke[i]).map((r) => `${r.voice.split(" ")[0]}: "${r.text}" → "${r.transcript}"`),
    falseWake: pct(ownFalse.length, neg.length),
    falseWakes: ownFalse.map((r) => `${r.voice.split(" ")[0]}: "${r.text}" → "${r.transcript}"`),
    negatives: neg.length,
    ...(mid.length ? { mid: mid.length, midFalseWake: pct(midFalse.length, mid.length), midFalseWakes: midFalse.map((r) => `${r.voice.split(" ")[0]}: "${r.text}" → "${r.transcript}"`) } : {}),
    othersFalseWakes: otherFalse.map((r) => `"${r.text}" → "${r.transcript}"`),
    byVoice,
    heardAs: Object.fromEntries(Object.entries(heardAs).sort((a, b) => b[1] - a[1])),
    withFix,
  };
});
results.sort((a, b) => b.wake - a.wake || a.falseWake - b.falseWake);

const out = {
  date: new Date().toISOString(),
  what: "Candidate names as wake words: `say` voices through Kiko's Apple helper (SpeechAnalyzer + SpeechTranscriber), then the built-in name fixes and wake.ts wakeIn with the candidate as the spoken name.",
  voices: prior?.voices ?? VOICES,
  positives: POSITIVES.map((p) => p.text),
  sharedNegatives: SHARED_NEGATIVES,
  results,
  rows: [] as unknown[],
};
// Live transcripts kept for the negatives and mid only (where a false wake on the way counts), each once.
const rowLines = rows
  .map(({ live, next: _, ...r }) => {
    const kept = r.set !== "positive" ? [...new Set(live)].filter((t) => t !== r.transcript) : [];
    return `    ${JSON.stringify(kept.length ? { ...r, live: kept } : r)}`;
  })
  .join(",\n");
writeFileSync(flags.out!, `${JSON.stringify(out, null, 2).replace('"rows": []', `"rows": [\n${rowLines}\n  ]`)}\n`);

console.log("\nname      wake  natural  false  others  one spelling            weakest voices / heard as");
for (const r of results) {
  const weak = Object.entries(r.byVoice)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([v, p]) => `${v.split(" ")[0]} ${p}%`)
    .join(", ");
  const heard = Object.entries(r.heardAs)
    .slice(0, 4)
    .map(([w, n]) => `${w} ${n}`)
    .join(", ");
  const fix = r.withFix ? `+${r.withFix.spelling} → ${r.withFix.wake}% (+${r.withFix.falseWakes} false)` : "";
  console.log(
    `${r.name.padEnd(9)} ${String(r.wake).padStart(5)} ${String(r.wakeNatural).padStart(8)} ${String(r.falseWake).padStart(6)} ${String(r.othersFalseWakes.length).padStart(7)}  ${fix.padEnd(24)} ${weak} | ${heard}`,
  );
}
console.log(`\nWrote ${flags.out}`);
process.exit(0);
