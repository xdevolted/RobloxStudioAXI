import { open, mkdir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  ManagedSessionRecord,
  SessionCommand,
  SessionEnvironment,
  SessionRepository,
  SessionTransaction,
} from "./types.js";
import { validateSchema } from "../project/schema.js";

interface LockOwner {
  schemaVersion: 1;
  nonce: string;
  command: SessionCommand;
  controller: { pid: number; createdAt: string };
  acquiredAt: string;
}

export class SessionRepositoryError extends Error {
  constructor(
    message: string,
    readonly reason: "transaction_active" | "record_invalid" | "record_newer" | "interrupted",
    readonly path: string,
  ) {
    super(message);
    this.name = "SessionRepositoryError";
  }
}

async function writeSynced(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceSynced(path: string, value: unknown, nonce: string): Promise<void> {
  const temporary = `${path}.${nonce}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRecord(value: unknown, path: string): ManagedSessionRecord {
  if (!isRecord(value) || typeof value.schemaVersion !== "number") {
    throw new SessionRepositoryError("Managed Session Record is malformed", "record_invalid", path);
  }
  if (value.schemaVersion > 1) {
    throw new SessionRepositoryError("Managed Session Record uses a newer schema", "record_newer", path);
  }
  if (
    value.schemaVersion !== 1 ||
    value.protocolVersion !== 1 ||
    typeof value.revision !== "number" ||
    !["starting", "running", "stopping", "recovery_required"].includes(String(value.phase)) ||
    !isRecord(value.ownership) ||
    typeof value.ownership.sessionId !== "string" ||
    !isRecord(value.project) ||
    typeof value.clients !== "number" ||
    !isRecord(value.controller)
  ) {
    throw new SessionRepositoryError("Managed Session Record is malformed", "record_invalid", path);
  }
  return value as unknown as ManagedSessionRecord;
}

export class FileSessionRepository implements SessionRepository {
  readonly root: string;
  readonly recordPath: string;
  readonly lockPath: string;
  readonly #environment: SessionEnvironment;

  constructor(options: { root: string; environment: SessionEnvironment }) {
    this.root = resolve(options.root);
    this.recordPath = join(this.root, "active.json");
    this.lockPath = join(this.root, "transaction.lock");
    this.#environment = options.environment;
  }

  async read(): Promise<ManagedSessionRecord | undefined> {
    try {
      const record = validateRecord(JSON.parse(await readFile(this.recordPath, "utf8")), this.recordPath);
      return await validateSchema<ManagedSessionRecord>("session-record", record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SessionRepositoryError) throw error;
      throw new SessionRepositoryError("Managed Session Record is malformed", "record_invalid", this.recordPath);
    }
  }

  async transact<T>(
    command: SessionCommand,
    work: (transaction: SessionTransaction) => Promise<T>,
    options?: { deadline: number; signal?: AbortSignal },
  ): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const owner = await this.#acquire(command, options);
    const transaction: SessionTransaction = {
      read: () => this.read(),
      write: async (record) => {
        const current = await this.read();
        if (current !== undefined && record.revision <= current.revision) {
          throw new SessionRepositoryError(
            `Record revision ${record.revision} must exceed ${current.revision}`,
            "record_invalid",
            this.recordPath,
          );
        }
        await validateSchema<ManagedSessionRecord>("session-record", record);
        await replaceSynced(this.recordPath, record, this.#environment.id());
      },
      remove: async () => {
        await unlink(this.recordPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      },
    };
    try {
      return await work(transaction);
    } finally {
      await this.#release(owner);
    }
  }

  async #acquire(
    command: SessionCommand,
    options?: { deadline: number; signal?: AbortSignal },
  ): Promise<LockOwner> {
    const deadline = Math.min(
      this.#environment.now().getTime() + 5_000,
      options?.deadline ?? Number.POSITIVE_INFINITY,
    );
    let absentOwner: { nonce: string; since: number } | undefined;
    while (true) {
      const owner: LockOwner = {
        schemaVersion: 1,
        nonce: this.#environment.id(),
        command,
        controller: await this.#environment.controller(),
        acquiredAt: this.#environment.now().toISOString(),
      };
      const candidate = join(this.root, `.transaction.${owner.nonce}.candidate`);
      await mkdir(candidate);
      await writeSynced(join(candidate, "owner.json"), owner);
      try {
        await rename(candidate, this.lockPath);
        return owner;
      } catch (error) {
        await unlink(join(candidate, "owner.json")).catch(() => undefined);
        await rmdir(candidate).catch(() => undefined);
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(String(code))) throw error;
        if (options?.signal?.aborted) {
          throw new SessionRepositoryError(
            "Managed-session transaction was interrupted while waiting for the lock",
            "interrupted",
            this.lockPath,
          );
        }
        let current: LockOwner;
        try {
          current = await this.#readLockOwner();
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw readError;
        }
        if (await this.#environment.processExists(current.controller)) {
          absentOwner = undefined;
        } else if (absentOwner?.nonce !== current.nonce) {
          absentOwner = { nonce: current.nonce, since: this.#environment.now().getTime() };
        } else if (this.#environment.now().getTime() - absentOwner.since >= 1_000) {
          if (await this.#quarantineAbandoned(current)) {
            absentOwner = undefined;
            continue;
          }
        }
        if (this.#environment.now().getTime() >= deadline) {
          throw new SessionRepositoryError(
            "Another managed-session transaction is active",
            "transaction_active",
            this.lockPath,
          );
        }
        await this.#environment.sleep(100);
      }
    }
  }

  async #readLockOwner(): Promise<LockOwner> {
    try {
      const value = JSON.parse(await readFile(join(this.lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
      if (
        value.schemaVersion !== 1 ||
        typeof value.nonce !== "string" ||
        typeof value.command !== "string" ||
        !value.controller ||
        typeof value.controller.pid !== "number" ||
        typeof value.controller.createdAt !== "string" ||
        typeof value.acquiredAt !== "string"
      ) {
        throw new Error("invalid owner document");
      }
      return value as LockOwner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw error;
      }
      throw new SessionRepositoryError(
        "Transaction lock owner is malformed and cannot be reclaimed safely",
        "record_invalid",
        this.lockPath,
      );
    }
  }

  async #quarantineAbandoned(owner: LockOwner): Promise<boolean> {
    const quarantine = join(this.root, `.transaction.${owner.nonce}.${this.#environment.id()}.abandoned`);
    try {
      await rename(this.lockPath, quarantine);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(String(code))) return false;
      throw error;
    }
    this.#assertContained(quarantine);
    const quarantined = JSON.parse(await readFile(join(quarantine, "owner.json"), "utf8")) as LockOwner;
    if (quarantined.nonce !== owner.nonce) {
      throw new SessionRepositoryError(
        "Transaction lock ownership changed during recovery",
        "transaction_active",
        quarantine,
      );
    }
    await unlink(join(quarantine, "owner.json"));
    await rmdir(quarantine);
    return true;
  }

  async #release(owner: LockOwner): Promise<void> {
    const raw = JSON.parse(await readFile(join(this.lockPath, "owner.json"), "utf8")) as LockOwner;
    if (raw.nonce !== owner.nonce) {
      throw new SessionRepositoryError("Transaction lock ownership changed", "transaction_active", this.lockPath);
    }
    const quarantine = join(this.root, `.transaction.${owner.nonce}.released`);
    await rename(this.lockPath, quarantine);
    this.#assertContained(quarantine);
    await unlink(join(quarantine, "owner.json"));
    await rmdir(quarantine);
  }

  #assertContained(path: string): void {
    const resolved = resolve(path);
    const child = relative(this.root, resolved);
    if (!isAbsolute(this.root) || child.startsWith("..") || isAbsolute(child)) {
      throw new Error(`Refusing filesystem mutation outside session root: ${resolved}`);
    }
  }
}
