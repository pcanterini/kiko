// The platform Kiko runs on, picked once at startup: the one place that names one. Everything
// else imports `platform` from here and the shapes from ./types.ts.
import { macos } from "./macos/index.ts";
import type { Platform } from "./types.ts";

function pick(os: NodeJS.Platform): Platform {
  switch (os) {
    case "darwin":
      return macos;
    // A Linux port: case "linux": return linux (./linux/index.ts), the pieces types.ts lists.
    default:
      // Nothing else is built: the Mac's pieces load, and fail when used, as they always have.
      return macos;
  }
}

export const platform: Platform = pick(process.platform);
