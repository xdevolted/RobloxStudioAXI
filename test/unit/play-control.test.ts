import { describe, expect, it, vi } from "vitest";
import { GuardedPlayControl } from "../../src/studio/play-control.js";

describe("guarded generic play control", () => {
  it("blocks generic mutation beside plausible Local Multiplayer Session state", async () => {
    const startPlay = vi.fn(async () => true);
    const stopPlay = vi.fn(async () => true);
    const control = new GuardedPlayControl({
      mutate: { startPlay, stopPlay },
      inspect: async () => ({
        safe: false,
        reason: "unmanaged_studio_state",
        details: { processes: 2 },
      }),
    });

    await expect(control.stop("studio-1")).rejects.toMatchObject({
      code: "SESSION_RECOVERY_REQUIRED",
      exitCode: 11,
    });
    expect(startPlay).not.toHaveBeenCalled();
    expect(stopPlay).not.toHaveBeenCalled();
  });
});
