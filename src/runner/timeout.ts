import { ExitCode, RobloxAxiError } from "../errors.js";

export async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RobloxAxiError({
                message: `${operation} timed out after ${timeoutMs}ms`,
                code: "TIMEOUT",
                exitCode: ExitCode.Timeout,
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function pollUntil<T>(options: {
  operation: string;
  timeoutMs: number;
  intervalMs?: number;
  read: () => Promise<T>;
  accept: (value: T) => boolean;
}): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (Date.now() - started <= options.timeoutMs) {
    last = await options.read();
    if (options.accept(last)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, options.intervalMs ?? 250));
  }
  throw new RobloxAxiError({
    message: `${options.operation} timed out after ${options.timeoutMs}ms`,
    code: "TIMEOUT",
    exitCode: ExitCode.Timeout,
    details: last,
  });
}
