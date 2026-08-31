import type {
  ManagedSession,
  SessionCommand,
  SessionEvidence,
  SessionOutcome,
  SessionResponse,
} from "./types.js";

function unsupportedOutcome(command: SessionCommand, evidence?: string): SessionOutcome {
  const response: SessionResponse = {
    schema_version: 1,
    command,
    result: "unsupported",
    reason: "platform_unsupported",
    changed: false,
    session: {
      state: "absent",
      ownership: "none",
      readiness: "none",
      health: "indeterminate",
      clients: {},
    },
    ...(evidence === undefined ? {} : { evidence }),
    help: ["Managed Local Multiplayer Sessions currently require Windows."],
  };
  return { response, exitCode: 13 };
}

export function createUnsupportedManagedSession(evidence: SessionEvidence): ManagedSession {
  return {
    async start(request) {
      const operation = await evidence.begin("session.start", request);
      const outcome = unsupportedOutcome("session.start", operation.directory);
      await operation.finish(outcome);
      return outcome;
    },
    status() {
      return Promise.resolve(unsupportedOutcome("session.status"));
    },
    async stop(request) {
      const operation = await evidence.begin("session.stop", request);
      const outcome = unsupportedOutcome("session.stop", operation.directory);
      await operation.finish(outcome);
      return outcome;
    },
  };
}
