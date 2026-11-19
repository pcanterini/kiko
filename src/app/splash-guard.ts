// Imported second by the app (app.ts: after core/dev-env.ts, before anything else that could fail
// as it loads): with start.ts painting the splash, a crash takes the screen from it before it
// prints (ui/splash-handoff.ts guardHandoff).
import { guardHandoff } from "../ui/splash-handoff.ts";

guardHandoff(process.argv);
