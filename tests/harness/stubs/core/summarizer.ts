const result = (text: string) => ({ text, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 });
export class Summarizer {
  async summarize(turn: any, onText: (d: string) => void) {
    const T = (globalThis as any).T;
    T.summaries = [...(T.summaries ?? []), turn];
    const t = `summary for ${turn.name}`;
    onText(t);
    return result(t);
  }
  async describePermission(req: any, onText: (d: string) => void) {
    const t = `${req.name} wants to ${req.tool}. Allow?`;
    onText(t);
    return result(t);
  }
  // "More": what it was given (T.mores), said as "more of <name>" (and ": <topic>").
  async more(of: any, onText: (d: string) => void) {
    const T = (globalThis as any).T;
    T.mores = [...(T.mores ?? []), of];
    const t = `more of ${of.name}${of.topic ? `: ${of.topic}` : ""}`;
    onText(t);
    return result(t);
  }
  async answer(found: any, onText: (d: string) => void) {
    const t = `answer: ${found.found}`;
    onText(t);
    return result(t);
  }
  // The phone's Catch me up: what it was given (T.catchUps); T.catchUpFails makes the call fail.
  async catchUp(updates: any[], onText: (d: string) => void) {
    const T = (globalThis as any).T;
    T.catchUps = [...(T.catchUps ?? []), updates];
    if (T.catchUpFails) throw new Error("overloaded");
    const t = `While you were away: ${updates.map((u) => u.name ?? "Kiko").join(", ")}.`;
    onText(t);
    return { ...result(t), costUsd: 0.0003 };
  }
  cancel() {}
}
