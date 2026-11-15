// Auto-detect the running board and build the matching provider. Detection
// prefers the device-tree model string and falls back to /proc/cpuinfo when
// the device-tree is absent (e.g. some containers).
//
// Lives here (not in backend.ts) so the provider tree stays a clean
// types ← helpers ← base ← providers ← factory ← backend dependency chain.

import { LinuxSystemInfoProvider } from "./base";
import { detectBoardId } from "../../../shared/install/board";
import { LinuxGenericSystemInfo } from "./providers/linux_generic";
import { OrangePi5PlusSystemInfo } from "./providers/orange_pi_5_plus";
import { RaspberryPiSystemInfo } from "./providers/raspberry_pi";

export async function createSystemInfoProvider(): Promise<LinuxSystemInfoProvider> {
    // Board detection lives in shared/install/board.ts so the systeminfo and
    // install-spec per-board deltas never drift apart.
    switch (await detectBoardId()) {
        case "orange_pi_5_plus":
            return new OrangePi5PlusSystemInfo();
        case "raspberry_pi":
            return new RaspberryPiSystemInfo();
        default:
            // Unknown board: the generic provider reads the standard /proc
            // and /sys interfaces (x86 and ARM alike).
            return new LinuxGenericSystemInfo();
    }
}
