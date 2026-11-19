// `pnpm support`: SUPPORT.md, what each agent's sessions get feature by feature, written afresh from
// the adapters' declarations (src/agents/support-matrix.ts). Run it after changing one; a test fails
// while the file is out of date. Imports no adapter, nothing that loads .env or writes logs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SUPPORT_FILE, supportDoc } from "../src/agents/support-matrix.ts";

const doc = supportDoc();
const was = existsSync(SUPPORT_FILE) ? readFileSync(SUPPORT_FILE, "utf8") : "";
if (was === doc) {
  console.log("SUPPORT.md is up to date.");
} else {
  writeFileSync(SUPPORT_FILE, doc);
  console.log("SUPPORT.md written.");
}
