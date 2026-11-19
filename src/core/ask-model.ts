// Your words to one of Claude's multiple-choice questions, when code can't place them (ask.ts
// matchAnswer): a quick model call names the option (or options) you chose, or says they're your own
// answer, a wish to answer at the Mac, or to hear it again. ask.ts fromModel checks what it says
// against the real options; a slow or failed call is unclear, and the app asks again.
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, requestInfo } from "./anthropic.ts";
import { fromModel, plainLabel, type AskQuestion, type Match } from "./ask.ts";
import { config } from "./config.ts";
import { cost, log } from "./log.ts";
import { NAME } from "./name.ts";
import { streamText } from "./openrouter-llm.ts";

const SYSTEM = `The user talks to a voice app, ${NAME}. It just read them a multiple-choice question from Claude Code, with its numbered options, and the user answered out loud (speech-to-text, so expect small transcription errors). Say what they chose. Answer with one line only:
- the number of the option they chose, like 2; for a question that takes several, every number they chose, like 1, 3
- OTHER if they clearly gave their own answer to the question, one that isn't any of the options
- MAC if they want to answer it at the computer or later, or to skip it
- REPEAT if they want to hear the question or the options again
- UNCLEAR if you can't tell, or their words aren't an answer to the question.
Pick an option only when their words clearly mean it ("the install one", "go with your suggestion", "yeah do that first thing"). When unsure, answer UNCLEAR.`;

// Past this, the app asks again rather than wait.
const TIMEOUT_MS = 2500;

let client: Anthropic | null = null;

type ModelMatch = { match: Match; answer: string; costUsd: number; ms: number };

/** Asks the configured model (Haiku, or the OpenRouter model picked in settings) what `text` chose for `q`. */
export async function matchByModel(q: AskQuestion, text: string): Promise<ModelMatch> {
  const prompt = [
    `<question>${q.question}</question>`,
    `<options>\n${q.options.map((o, i) => `${i + 1}. ${plainLabel(o.label)}${o.description ? ` (${o.description})` : ""}`).join("\n")}\n</options>`,
    `<takes_several>${q.multiSelect ? "yes" : "no"}</takes_several>`,
    `<user_said>${text}</user_said>`,
  ].join("\n");
  const start = performance.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let answer = "";
  let costUsd = 0;
  // The request id, the SDK's retries and why the model stopped, for the log line.
  let call: Record<string, unknown> = {};
  try {
    if (config.llm !== "haiku") {
      const r = await streamText({ model: config.llm, system: SYSTEM, prompt, maxTokens: 20, signal, onText: () => {}, call: "ask" });
      answer = r.text;
      costUsd = r.costUsd;
      call = { ...(r.id ? { requestId: r.id } : {}), ...(r.stop ? { stop: r.stop } : {}) };
    } else {
      client ??= anthropic();
      const { data: final, response } = await client.messages
        .create(
          {
            model: config.summaryModel,
            max_tokens: 20,
            // Latency over depth: no thinking, low effort.
            thinking: { type: "disabled" },
            output_config: { effort: config.summaryEffort },
            system: SYSTEM,
            messages: [{ role: "user", content: prompt }],
          },
          { signal },
        )
        .withResponse();
      answer = final.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      costUsd = cost.haiku(final.usage);
      call = { ...requestInfo(response), stop: final.stop_reason };
    }
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    log("ask_match", { model: config.llm, text, error: signal.aborted ? "timeout" : String(err), ms });
    return { match: { kind: "unclear" }, answer: "", costUsd: 0, ms };
  }
  const ms = Math.round(performance.now() - start);
  const match = fromModel(q, answer, text);
  log("ask_match", { model: config.llm, text, answer, match: match.kind, ...(match.kind === "pick" ? { picks: match.picks } : {}), costUsd, ms, ...call });
  return { match, answer, costUsd, ms };
}
