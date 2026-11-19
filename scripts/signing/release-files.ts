// What scripts/release.sh bakes into a chip's executable (src/core/release-files.ts): the SHA-256 of
// every file in its folder but the executable, taken once everything else is in place and signed,
// and whether the build is ad hoc; with the helper app's folder and its code requirement, that
// bundle is left out of the list and baked beside it instead (checked by its own signature).
// Printed as one line of JSON, for `bun build --compile --define`:
//   node scripts/signing/release-files.ts <folder> <adhoc: 1 or 0> [<app folder> <requirement>]
// Fails (exit 1) on a link or anything else that isn't a plain file: none should be there.
import { listFiles } from "../../src/core/release-files.ts";

const [folder, adHoc, appPath, requirement] = process.argv.slice(2);
if (!folder || (adHoc !== "1" && adHoc !== "0") || (appPath !== undefined && !requirement)) {
  console.error("usage: node scripts/signing/release-files.ts <folder> <adhoc: 1 or 0> [<app folder> <requirement>]");
  process.exit(2);
}
try {
  const app = appPath ? { path: appPath, requirement } : undefined;
  console.log(JSON.stringify({ adHoc: adHoc === "1", files: listFiles(folder, appPath), ...(app ? { app } : {}) }));
} catch (err) {
  console.error(`release-files: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
