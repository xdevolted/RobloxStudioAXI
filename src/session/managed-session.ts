import {
  SESSION_PROTOCOL,
  launchTargetKey,
  type CommandContext,
  type ManagedSession,
  type ManagedSessionRecord,
  type SessionEnvironment,
  type SessionEvidence,
  type SessionObservation,
  type SessionOutcome,
  type SessionRepository,
  type SessionResponse,
  type SessionWorld,
  type StartSessionRequest,
  type StatusSessionRequest,
  type StopSessionRequest,
} from "./types.js";
import { normalizeWindowsPath, sessionProjectsMatch } from "./identity.js";

interface Dependencies {
  repository: SessionRepository;
  world: SessionWorld;
  evidence: SessionEvidence;
  environment: SessionEnvironment;
}

function repositoryFailure(error: unknown): { reason: string; path?: string } | undefined {
  if (!error || typeof error !== "object" || !("reason" in error)) return undefined;
  const value = error as { reason?: unknown; path?: unknown };
  if (!["transaction_active", "record_invalid", "record_newer", "interrupted"].includes(String(value.reason))) {
    return undefined;
  }
  return {
    reason: String(value.reason),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
  };
}

function unavailableRecordOutcome(
  command: SessionResponse["command"],
  failure: { reason: string; path?: string },
  evidence?: string,
  status = false,
): SessionOutcome {
  const busy = failure.reason === "transaction_active";
  const interrupted = failure.reason === "interrupted";
  return {
    exitCode: status ? 0 : interrupted ? 12 : busy ? 10 : 11,
    response: {
      schema_version: 1,
      command,
      result: status ? "observed" : interrupted ? "interrupted" : busy ? "busy" : "recovery_required",
      reason: interrupted ? "signal_received" : failure.reason,
      changed: false,
      session: {
        state: "recovery_required",
        ownership: "ambiguous",
        readiness: "none",
        health: "indeterminate",
        clients: {},
      },
      ...(evidence === undefined ? {} : { evidence }),
      help: [
        "Run `roblox-studio-axi session status --full`",
        ...(failure.path === undefined ? [] : [`Inspect the preserved record or lock at ${failure.path}`]),
      ],
    },
  };
}

function incompleteObservationOutcome(
  command: SessionResponse["command"],
  observation: SessionObservation,
  evidence?: string,
  status = false,
): SessionOutcome {
  const unsupported = observation.contradictions.some((item) => item.startsWith("adapter: "));
  return {
    exitCode: status ? 0 : unsupported ? 13 : 11,
    response: {
      schema_version: 1,
      command,
      result: status ? "observed" : unsupported ? "unsupported" : "recovery_required",
      reason: unsupported ? "control_surface_unavailable" : "topology_ambiguous",
      changed: false,
      session: {
        state: "recovery_required",
        ownership: "ambiguous",
        readiness: observation.readiness,
        health: "indeterminate",
        clients: observation.clients,
      },
      ...(evidence === undefined ? {} : { evidence }),
      help: [
        "Run `roblox-studio-axi session status --full` after restoring Studio MCP and Windows process inspection.",
      ],
      details: { observation: structuredClone(observation) },
    },
  };
}

function hasAdapterFailure(observation: SessionObservation): boolean {
  return observation.contradictions.some((item) => item.startsWith("adapter: "));
}

function responseFrom(
  command: SessionResponse["command"],
  result: string,
  changed: boolean,
  record: ManagedSessionRecord,
  observation: SessionObservation,
  evidence: string | undefined,
  actions: string[],
): SessionOutcome {
  return {
    exitCode: 0,
    response: {
      schema_version: 1,
      command,
      result,
      changed,
      session: {
        state: record.phase,
        ownership: observation.ownership,
        readiness: observation.readiness,
        health: observation.health,
        id: record.ownership.sessionId,
        project: record.project.name,
        clients: {
          requested: record.clients,
          ...observation.clients,
        },
      },
      ...(evidence === undefined ? {} : { evidence }),
      ...(actions.length === 0 ? {} : { actions }),
      details: {
        record: structuredClone(record),
        observation: structuredClone(observation),
      },
    },
  };
}

export function createManagedSession(dependencies: Dependencies): ManagedSession {
  return {
    async start(request: StartSessionRequest, _context: CommandContext): Promise<SessionOutcome> {
      const deadline = dependencies.environment.now().getTime() + _context.timeoutMs;
      const operation = await dependencies.evidence.begin("session.start", request);
      if (_context.signal?.aborted) {
        const interrupted: SessionOutcome = {
          exitCode: 12,
          response: {
            schema_version: 1,
            command: "session.start",
            result: "interrupted",
            reason: "signal_received",
            changed: false,
            session: {
              state: "absent",
              ownership: "none",
              readiness: "none",
              health: "not_applicable",
              clients: {},
            },
            evidence: operation.directory,
          },
        };
        await operation.finish(interrupted);
        return interrupted;
      }
      const actions: string[] = [];
      let outcome: SessionOutcome;
      try {
        outcome = await dependencies.repository.transact("session.start", async (transaction) => {
        let existing = await transaction.read();
        if (existing !== undefined) {
          let staleObservation = await dependencies.world.observe(existing);
          await operation.appendObservation(staleObservation);
          if (
            staleObservation.stable &&
            !staleObservation.possibleSimulation &&
            staleObservation.readiness === "none"
          ) {
            const absenceStartedAt = dependencies.environment.now().getTime();
            let stableAbsence = true;
            while (dependencies.environment.now().getTime() - absenceStartedAt < 10_000) {
              if (_context.signal?.aborted || dependencies.environment.now().getTime() >= deadline) {
                stableAbsence = false;
                break;
              }
              await dependencies.environment.sleep(
                Math.min(250, deadline - dependencies.environment.now().getTime()),
              );
              staleObservation = await dependencies.world.observe(existing);
              await operation.appendObservation(staleObservation);
              if (
                !staleObservation.stable ||
                staleObservation.possibleSimulation ||
                staleObservation.readiness !== "none"
              ) {
                stableAbsence = false;
                break;
              }
            }
            if (stableAbsence) {
              await transaction.remove();
              actions.push("stale_record_cleared");
              await operation.action("stale_record_cleared");
              existing = undefined;
            } else if (_context.signal?.aborted || dependencies.environment.now().getTime() >= deadline) {
              const terminated = responseFrom(
                "session.start",
                _context.signal?.aborted ? "interrupted" : "timed_out",
                false,
                existing,
                staleObservation,
                operation.directory,
                actions,
              );
              terminated.exitCode = _context.signal?.aborted ? 12 : 6;
              terminated.response.reason = _context.signal?.aborted ? "signal_received" : "deadline_exceeded";
              return terminated;
            }
          }
        }
        if (existing !== undefined && !sessionProjectsMatch(existing.project, request.project)) {
          const observation = await dependencies.world.observe(existing);
          await operation.appendObservation(observation);
          const conflict = responseFrom(
            "session.start",
            "conflict",
            false,
            existing,
            observation,
            operation.directory,
            actions,
          );
          conflict.exitCode = 9;
          conflict.response.reason =
            normalizeWindowsPath(existing.project.root).toLocaleLowerCase() !==
            normalizeWindowsPath(request.project.root).toLocaleLowerCase()
              ? "project_mismatch"
              : "launch_target_mismatch";
          conflict.response.help = [
            "Run `roblox-studio-axi session status --full`",
            "Run `roblox-studio-axi session stop` before changing project identity",
          ];
          return conflict;
        }
        if (existing !== undefined && existing.clients !== request.clients) {
          const observation = await dependencies.world.observe(existing);
          await operation.appendObservation(observation);
          const conflict = responseFrom(
            "session.start",
            "conflict",
            false,
            existing,
            observation,
            operation.directory,
            actions,
          );
          conflict.exitCode = 9;
          conflict.response.reason = "client_count_mismatch";
          conflict.response.help = [
            "Run `roblox-studio-axi session status --full`",
            "Run `roblox-studio-axi session stop` before changing the client count",
          ];
          return conflict;
        }
        if (
          existing !== undefined &&
          existing.phase === "running" &&
          existing.clients === request.clients &&
          sessionProjectsMatch(existing.project, request.project)
        ) {
          const observation = await dependencies.world.observe(existing);
          await operation.appendObservation(observation);
          if (
            observation.ownership === "proved" &&
            ["joined", "responsive"].includes(observation.readiness)
          ) {
            return responseFrom(
              "session.start",
              "already_running",
              false,
              existing,
              observation,
              operation.directory,
              actions,
            );
          }
        }
        if (
          existing !== undefined &&
          existing.phase === "starting" &&
          existing.clients === request.clients &&
          sessionProjectsMatch(existing.project, request.project)
        ) {
          let observation = await dependencies.world.observe(existing);
          await operation.appendObservation(observation);
          while (
            observation.ownership !== "proved" ||
            !["joined", "responsive"].includes(observation.readiness)
          ) {
            if (_context.signal?.aborted) {
              const interrupted = responseFrom(
                "session.start",
                "interrupted",
                false,
                existing,
                observation,
                operation.directory,
                actions,
              );
              interrupted.exitCode = 12;
              interrupted.response.reason = "signal_received";
              return interrupted;
            }
            if (dependencies.environment.now().getTime() >= deadline) {
              const timedOut = responseFrom(
                "session.start",
                "timed_out",
                false,
                existing,
                observation,
                operation.directory,
                actions,
              );
              timedOut.exitCode = 6;
              timedOut.response.reason = "deadline_exceeded";
              return timedOut;
            }
            await dependencies.environment.sleep(
              Math.min(250, deadline - dependencies.environment.now().getTime()),
            );
            observation = await dependencies.world.observe(existing);
            await operation.appendObservation(observation);
          }
          existing.phase = "running";
          existing.revision += 1;
          existing.updatedAt = dependencies.environment.now().toISOString();
          existing.latestEvidence = operation.directory;
          await transaction.write(existing);
          actions.push("record_marked_running");
          await operation.action("record_marked_running");
          return responseFrom(
            "session.start",
            "already_running",
            true,
            existing,
            observation,
            operation.directory,
            actions,
          );
        }
        if (existing !== undefined) {
          const observation = await dependencies.world.observe(existing);
          await operation.appendObservation(observation);
          const unresolved = responseFrom(
            "session.start",
            existing.phase === "stopping" ? "busy" : "recovery_required",
            false,
            existing,
            observation,
            operation.directory,
            actions,
          );
          if (existing.phase === "stopping") {
            unresolved.exitCode = 10;
            unresolved.response.reason = "transition_in_progress";
          } else {
            unresolved.exitCode = 11;
            unresolved.response.reason =
              observation.ownership === "ambiguous"
                ? "ownership_mismatch"
                : observation.ownership === "recorded"
                  ? "ownership_unproved"
                  : "topology_ambiguous";
            unresolved.response.session.state = "recovery_required";
          }
          unresolved.response.help = ["Run `roblox-studio-axi session status --full`"];
          return unresolved;
        }

        const baseline = await dependencies.world.observe();
        await operation.appendObservation(baseline);
        if (!baseline.stable || baseline.contradictions.length > 0) {
          return incompleteObservationOutcome("session.start", baseline, operation.directory);
        }
        if (baseline.possibleSimulation) {
          return {
            exitCode: 9,
            response: {
              schema_version: 1,
              command: "session.start",
              result: "conflict",
              reason: "unmanaged_studio_state",
              changed: false,
              session: {
                state: "unmanaged",
                ownership: baseline.ownership === "none" ? "unmanaged" : baseline.ownership,
                readiness: baseline.readiness,
                health: baseline.health,
                clients: baseline.clients,
              },
              evidence: operation.directory,
              help: [
                "Use Studio's End Session control, then run `roblox-studio-axi session status`",
              ],
            },
          } satisfies SessionOutcome;
        }

        const now = dependencies.environment.now().toISOString();
        const record: ManagedSessionRecord = {
          schemaVersion: 1,
          protocolVersion: 1,
          revision: 1,
          phase: "starting",
          ownership: {
            protocol: SESSION_PROTOCOL,
            sessionId: dependencies.environment.id(),
            projectRoot: request.project.root,
            launchTarget: launchTargetKey(request.project),
            requestedClients: request.clients,
          },
          project: request.project,
          clients: request.clients,
          controller: await dependencies.environment.controller(),
          createdAt: now,
          updatedAt: now,
          originatingEvidence: operation.directory,
          latestEvidence: operation.directory,
        };
        await transaction.write(record);
        actions.push("record_created");
        await operation.action("record_created");

        const artifacts = await operation.prepareBootstrap(record);
        record.bootstrap = await dependencies.world.launch(record, artifacts);
        record.revision += 1;
        record.updatedAt = dependencies.environment.now().toISOString();
        await transaction.write(record);
        actions.push("bootstrap_started");
        await operation.action("bootstrap_started");

        let observation = await dependencies.world.observe(record);
        await operation.appendObservation(observation);
        while (
          observation.ownership !== "proved" ||
          !["joined", "responsive"].includes(observation.readiness)
        ) {
          if (_context.signal?.aborted) {
            const interrupted = responseFrom(
              "session.start",
              "interrupted",
              true,
              record,
              observation,
              operation.directory,
              actions,
            );
            interrupted.exitCode = 12;
            interrupted.response.reason = "signal_received";
            interrupted.response.help = ["Run `roblox-studio-axi session status --full`"];
            return interrupted;
          }
          if (dependencies.environment.now().getTime() >= deadline) {
            const timedOut = responseFrom(
              "session.start",
              "timed_out",
              true,
              record,
              observation,
              operation.directory,
              actions,
            );
            timedOut.exitCode = 6;
            timedOut.response.reason = "deadline_exceeded";
            timedOut.response.help = [
              "Run `roblox-studio-axi session status --full`",
              `Retry \`roblox-studio-axi session start --clients ${record.clients}\``,
            ];
            return timedOut;
          }
          await dependencies.environment.sleep(
            Math.min(250, deadline - dependencies.environment.now().getTime()),
          );
          observation = await dependencies.world.observe(record);
          await operation.appendObservation(observation);
        }
        record.phase = "running";
        record.revision += 1;
        record.updatedAt = dependencies.environment.now().toISOString();
        await transaction.write(record);
        actions.push("record_marked_running");
        await operation.action("record_marked_running");
        return responseFrom(
          "session.start",
          "started",
          true,
          record,
          observation,
          operation.directory,
          actions,
        );
        }, { deadline, ...(_context.signal === undefined ? {} : { signal: _context.signal }) });
      } catch (error) {
        const failure = repositoryFailure(error);
        if (!failure) throw error;
        outcome = unavailableRecordOutcome("session.start", failure, operation.directory);
      }
      await operation.finish(outcome);
      return outcome;
    },

    async status(_request: StatusSessionRequest, _context: CommandContext): Promise<SessionOutcome> {
      const deadline = dependencies.environment.now().getTime() + _context.timeoutMs;
      let record: ManagedSessionRecord | undefined;
      try {
        record = await dependencies.repository.read();
      } catch (error) {
        const failure = repositoryFailure(error);
        if (!failure) throw error;
        return unavailableRecordOutcome("session.status", failure, undefined, true);
      }
      let observation = await dependencies.world.observe(record);
      if (!observation.stable || hasAdapterFailure(observation)) {
        return incompleteObservationOutcome("session.status", observation, undefined, true);
      }
      if (record === undefined && !observation.possibleSimulation) {
        return {
          exitCode: 0,
          response: {
            schema_version: 1,
            command: "session.status",
            result: "observed",
            changed: false,
            session: {
              state: "absent",
              ownership: "none",
              readiness: "none",
              health: "not_applicable",
              clients: {},
            },
          },
        };
      }
      if (record !== undefined) {
        const observed = responseFrom(
          "session.status",
          "observed",
          false,
          record,
          observation,
          undefined,
          [],
        );
        if (observation.ownership === "ambiguous") {
          observed.response.session.state = "recovery_required";
        }
        if (
          observation.stable &&
          !observation.possibleSimulation &&
          observation.readiness === "none"
        ) {
          const absenceStartedAt = dependencies.environment.now().getTime();
          let stableAbsence = true;
          while (dependencies.environment.now().getTime() - absenceStartedAt < 10_000) {
            if (_context.signal?.aborted || dependencies.environment.now().getTime() >= deadline) {
              stableAbsence = false;
              break;
            }
            await dependencies.environment.sleep(
              Math.min(250, deadline - dependencies.environment.now().getTime()),
            );
            observation = await dependencies.world.observe(record);
            if (!observation.stable || observation.possibleSimulation || observation.readiness !== "none") {
              stableAbsence = false;
              break;
            }
          }
          if (stableAbsence) {
            observed.response.session.state = "stale";
            observed.response.session.ownership = observation.ownership;
            observed.response.session.readiness = observation.readiness;
            observed.response.session.health = observation.health;
            observed.response.session.clients = {
              requested: record.clients,
              ...observation.clients,
            };
          }
        }
        return observed;
      }
      if (observation.possibleSimulation) {
        return {
          exitCode: 0,
          response: {
            schema_version: 1,
            command: "session.status",
            result: "observed",
            changed: false,
            session: {
              state: "unmanaged",
              ownership: observation.ownership === "none" ? "unmanaged" : observation.ownership,
              readiness: observation.readiness,
              health: observation.health,
              clients: observation.clients,
            },
          },
        };
      }
      throw new Error("Other status states are not implemented yet");
    },

    async stop(request: StopSessionRequest, _context: CommandContext): Promise<SessionOutcome> {
      const deadline = dependencies.environment.now().getTime() + _context.timeoutMs;
      const operation = await dependencies.evidence.begin("session.stop", request);
      let outcome: SessionOutcome;
      try {
        outcome = await dependencies.repository.transact("session.stop", async (transaction) => {
        const record = await transaction.read();
        let observation = await dependencies.world.observe(record);
        await operation.appendObservation(observation);
        if (!observation.stable || hasAdapterFailure(observation)) {
          return incompleteObservationOutcome("session.stop", observation, operation.directory);
        }
        if (record === undefined && !observation.possibleSimulation) {
          return {
            exitCode: 0,
            response: {
              schema_version: 1,
              command: "session.stop",
              result: "already_stopped",
              changed: false,
              session: {
                state: "absent",
                ownership: "none",
                readiness: "none",
                health: "not_applicable",
                clients: {},
              },
              evidence: operation.directory,
            },
          } satisfies SessionOutcome;
        }
        if (record === undefined && observation.possibleSimulation) {
          return {
            exitCode: 9,
            response: {
              schema_version: 1,
              command: "session.stop",
              result: "conflict",
              reason: "unmanaged_studio_state",
              changed: false,
              session: {
                state: "unmanaged",
                ownership: observation.ownership === "none" ? "unmanaged" : observation.ownership,
                readiness: observation.readiness,
                health: observation.health,
                clients: observation.clients,
              },
              evidence: operation.directory,
              help: [
                "Use Studio's End Session control, then run `roblox-studio-axi session status`",
              ],
            },
          } satisfies SessionOutcome;
        }
        if (record !== undefined && request.project !== undefined && !sessionProjectsMatch(record.project, request.project)) {
          const conflict = responseFrom(
            "session.stop",
            "conflict",
            false,
            record,
            observation,
            operation.directory,
            [],
          );
          conflict.exitCode = 9;
          conflict.response.reason =
            normalizeWindowsPath(record.project.root).toLocaleLowerCase() !==
            normalizeWindowsPath(request.project.root).toLocaleLowerCase()
              ? "project_mismatch"
              : "launch_target_mismatch";
          conflict.response.help = [
            "Run `roblox-studio-axi session status --full`",
            "Run `roblox-studio-axi session stop` without a mismatching project assertion",
          ];
          return conflict;
        }
        if (
          record !== undefined &&
          observation.stable &&
          !observation.possibleSimulation &&
          observation.readiness === "none"
        ) {
          const absenceStartedAt = dependencies.environment.now().getTime();
          let stableAbsence = true;
          while (dependencies.environment.now().getTime() - absenceStartedAt < 10_000) {
            if (_context.signal?.aborted || dependencies.environment.now().getTime() >= deadline) {
              stableAbsence = false;
              break;
            }
            await dependencies.environment.sleep(
              Math.min(250, deadline - dependencies.environment.now().getTime()),
            );
            observation = await dependencies.world.observe(record);
            await operation.appendObservation(observation);
            if (!observation.stable || observation.possibleSimulation || observation.readiness !== "none") {
              stableAbsence = false;
              break;
            }
          }
          if (stableAbsence) {
            const actions = ["stale_record_cleared", "record_removed"];
            await operation.action("stale_record_cleared");
            await transaction.remove();
            await operation.action("record_removed");
            return {
              exitCode: 0,
              response: {
                schema_version: 1,
                command: "session.stop",
                result: "stale_record_cleared",
                changed: true,
                session: {
                  state: "absent",
                  ownership: "none",
                  readiness: "none",
                  health: "not_applicable",
                  clients: {},
                },
                evidence: operation.directory,
                actions,
              },
            } satisfies SessionOutcome;
          }
          if (_context.signal?.aborted || dependencies.environment.now().getTime() >= deadline) {
            const terminated = responseFrom(
              "session.stop",
              _context.signal?.aborted ? "interrupted" : "timed_out",
              false,
              record,
              observation,
              operation.directory,
              [],
            );
            terminated.exitCode = _context.signal?.aborted ? 12 : 6;
            terminated.response.reason = _context.signal?.aborted ? "signal_received" : "deadline_exceeded";
            return terminated;
          }
        }
        if (
          record !== undefined &&
          observation.ownership === "proved" &&
          observation.serverTargetId !== undefined
        ) {
          const actions: string[] = [];
          record.phase = "stopping";
          record.revision += 1;
          record.updatedAt = dependencies.environment.now().toISOString();
          record.latestEvidence = operation.directory;
          await transaction.write(record);
          actions.push("record_marked_stopping");
          await operation.action("record_marked_stopping");

          await dependencies.world.endOwned(record, observation.serverTargetId);
          actions.push("end_test_requested");
          await operation.action("end_test_requested");

          let finalObservation = await dependencies.world.observe(record);
          await operation.appendObservation(finalObservation);
          while (finalObservation.possibleSimulation) {
            if (_context.signal?.aborted) {
              const interrupted = responseFrom(
                "session.stop",
                "interrupted",
                true,
                record,
                finalObservation,
                operation.directory,
                actions,
              );
              interrupted.exitCode = 12;
              interrupted.response.reason = "signal_received";
              return interrupted;
            }
            if (dependencies.environment.now().getTime() >= deadline) {
              const failed = responseFrom(
                "session.stop",
                "cleanup_failed",
                true,
                record,
                finalObservation,
                operation.directory,
                actions,
              );
              failed.exitCode = 8;
              failed.response.reason = "teardown_unverified";
              failed.response.help = [
                "Run `roblox-studio-axi session status --full`",
                "Retry `roblox-studio-axi session stop`",
              ];
              return failed;
            }
            await dependencies.environment.sleep(
              Math.min(250, deadline - dependencies.environment.now().getTime()),
            );
            finalObservation = await dependencies.world.observe(record);
            await operation.appendObservation(finalObservation);
          }
          actions.push("teardown_verified");
          await operation.action("teardown_verified");
          await transaction.remove();
          actions.push("record_removed");
          await operation.action("record_removed");
          return {
            exitCode: 0,
            response: {
              schema_version: 1,
              command: "session.stop",
              result: "stopped",
              changed: true,
              session: {
                state: "absent",
                ownership: "none",
                readiness: "none",
                health: "not_applicable",
                clients: {},
              },
              evidence: operation.directory,
              actions,
            },
          } satisfies SessionOutcome;
        }
        if (record !== undefined) {
          const recovery = responseFrom(
            "session.stop",
            "recovery_required",
            false,
            record,
            observation,
            operation.directory,
            [],
          );
          recovery.exitCode = 11;
          recovery.response.reason =
            observation.ownership === "ambiguous"
              ? "ownership_mismatch"
              : observation.ownership === "recorded"
                ? "ownership_unproved"
                : "topology_ambiguous";
          recovery.response.session.state = "recovery_required";
          recovery.response.help = [
            "Inspect the record and evidence paths with `roblox-studio-axi session status --full`",
            "Use Studio's End Session control if the session is visibly active",
          ];
          return recovery;
        }
        throw new Error("Other stop states are not implemented yet");
        }, { deadline, ...(_context.signal === undefined ? {} : { signal: _context.signal }) });
      } catch (error) {
        const failure = repositoryFailure(error);
        if (!failure) throw error;
        outcome = unavailableRecordOutcome("session.stop", failure, operation.directory);
      }
      await operation.finish(outcome);
      return outcome;
    },
  };
}
