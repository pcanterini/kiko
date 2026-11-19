// The real Duck (src/platform/macos/duck.ts) on a fake volume (tests/support/volume.ts): osascript never runs and the Mac's
// volume never moves. T.mac is that volume (set some of it before the app starts); its runs take T.mac.delayMs.
import { Duck as Real } from "../../../../../src/platform/macos/duck.ts";
import { fakeMac } from "../../../../support/volume.ts";
export * from "../../../../../src/platform/macos/duck.ts";
const T = (globalThis as any).T;
const { mac, run } = fakeMac({ volume: 50, delayMs: 30, ...T.mac });
T.mac = mac;
export class Duck extends Real {
  constructor(opts: ConstructorParameters<typeof Real>[0]) {
    super({ ...opts, run });
  }
}
