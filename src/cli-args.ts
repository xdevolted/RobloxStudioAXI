import { usageError } from "./errors.js";

export type FlagKind = "boolean" | "value";

export interface ParsedArguments {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const GLOBAL_FLAGS: Record<string, FlagKind> = {
  "--json": "boolean",
  "--full": "boolean",
  "--verbose": "boolean",
  "--project": "value",
  "--studio": "value",
};

export function parseArguments(options: {
  args: string[];
  command: string;
  flags?: Record<string, FlagKind>;
  minPositionals?: number;
  maxPositionals?: number;
  usage: string;
  globalFlags?: readonly string[];
}): ParsedArguments {
  const globals = options.globalFlags === undefined
    ? GLOBAL_FLAGS
    : Object.fromEntries(
        options.globalFlags.map((name) => {
          const kind = GLOBAL_FLAGS[name];
          if (!kind) throw new Error(`Unknown global flag configuration: ${name}`);
          return [name, kind];
        }),
      );
  const known = { ...globals, ...(options.flags ?? {}) };
  const parsed: ParsedArguments = { positionals: [], flags: {} };

  for (let index = 0; index < options.args.length; index += 1) {
    const token = options.args[index]!;
    if (!token.startsWith("-")) {
      parsed.positionals.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    const name = separator === -1 ? token : token.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
    const kind = known[name];
    if (!kind) {
      throw usageError(`Unknown flag ${name} for ${options.command}`, [
        `Valid flags: ${Object.keys(known).sort().join(", ")}`,
        `Run \`${options.usage} --help\``,
      ]);
    }
    if (kind === "boolean") {
      if (inlineValue !== undefined) {
        throw usageError(`${name} does not take a value`, [`Run \`${options.usage} --help\``]);
      }
      parsed.flags[name] = true;
      continue;
    }
    const value = inlineValue ?? options.args[index + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith("-"))) {
      throw usageError(`${name} requires a value`, [`Run \`${options.usage} --help\``]);
    }
    parsed.flags[name] = value;
    if (inlineValue === undefined) index += 1;
  }

  const min = options.minPositionals ?? 0;
  const max = options.maxPositionals ?? Number.POSITIVE_INFINITY;
  if (parsed.positionals.length < min || parsed.positionals.length > max) {
    throw usageError(`Invalid arguments for ${options.command}`, [`Usage: ${options.usage}`]);
  }
  return parsed;
}

export function stringFlag(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function booleanFlag(parsed: ParsedArguments, name: string): boolean {
  return parsed.flags[name] === true;
}
