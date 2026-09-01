import type { ResolvedProjectConfig } from "../types.js";
import { ExitCode, RobloxAxiError } from "../errors.js";
import { managedSessionRoot } from "../session/factory.js";
import { FileSessionRepository } from "../session/repository.js";
import { ProductionSessionWorld } from "../session/world.js";
import { ProductionSessionEnvironment } from "../session/windows.js";

export interface PlayControl {
  start(studioId: string): Promise<boolean>;
  stop(studioId: string): Promise<boolean>;
}

export interface GenericPlaySafety {
  safe: boolean;
  reason?: string;
  details?: unknown;
}

export class GuardedPlayControl implements PlayControl {
  readonly #mutate: {
    startPlay(studioId: string): Promise<boolean>;
    stopPlay(studioId: string): Promise<boolean>;
  };
  readonly #inspect: () => Promise<GenericPlaySafety>;

  constructor(options: {
    mutate: {
      startPlay(studioId: string): Promise<boolean>;
      stopPlay(studioId: string): Promise<boolean>;
    };
    inspect: () => Promise<GenericPlaySafety>;
  }) {
    this.#mutate = options.mutate;
    this.#inspect = options.inspect;
  }

  async start(studioId: string): Promise<boolean> {
    await this.#assertSafe();
    return this.#mutate.startPlay(studioId);
  }

  async stop(studioId: string): Promise<boolean> {
    await this.#assertSafe();
    return this.#mutate.stopPlay(studioId);
  }

  async #assertSafe(): Promise<void> {
    const safety = await this.#inspect();
    if (safety.safe) return;
    throw new RobloxAxiError({
      message: "Generic play control is blocked beside a Managed or plausible Local Multiplayer Session",
      code: "SESSION_RECOVERY_REQUIRED",
      exitCode: ExitCode.RecoveryRequired,
      suggestions: [
        "Run `roblox-studio-axi session status --full`",
        "Use `roblox-studio-axi session stop` only when ownership is proved",
      ],
      details: { reason: safety.reason ?? "topology_ambiguous", evidence: safety.details },
    });
  }
}

export function createGuardedPlayControl(options: {
  service: {
    startPlay(studioId: string): Promise<boolean>;
    stopPlay(studioId: string): Promise<boolean>;
  };
  config: ResolvedProjectConfig;
}): PlayControl {
  const environment = new ProductionSessionEnvironment();
  const repository = new FileSessionRepository({ root: managedSessionRoot(), environment });
  const world = new ProductionSessionWorld({ config: options.config });
  return new GuardedPlayControl({
    mutate: options.service,
    inspect: async () => {
      try {
        const record = await repository.read();
        const observation = await world.observe(record);
        const safe =
          record === undefined &&
          observation.stable &&
          observation.contradictions.length === 0 &&
          !observation.possibleSimulation &&
          observation.ownership === "none";
        return {
          safe,
          ...(safe ? {} : { reason: record === undefined ? "unmanaged_studio_state" : "ownership_unproved" }),
          details: observation,
        };
      } catch (error) {
        return { safe: false, reason: "record_invalid", details: String(error) };
      }
    },
  });
}
