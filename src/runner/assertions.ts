import { ExitCode, RobloxAxiError } from "../errors.js";
import type {
  AssertionResult,
  ConsoleEntry,
  PlaytestAssertion,
  ResolvedProjectConfig,
} from "../types.js";
import type { StudioService } from "../studio/service.js";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface AssertionContext {
  values: Map<string, unknown>;
  consoleEntries: ConsoleEntry[];
  service: StudioService;
  studioId: string;
  config: ResolvedProjectConfig;
}

function valueAtPath(root: unknown, segments: string[]): unknown {
  let value = root;
  for (const segment of segments) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

export function resolveActual(reference: string, values: Map<string, unknown>): unknown {
  const segments = reference.split(".").filter(Boolean);
  if (segments[0] === "steps") segments.shift();
  const id = segments.shift();
  if (!id) return undefined;
  return valueAtPath(values.get(id), segments);
}

function numeric(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RobloxAxiError({
      message: `${label} must resolve to a finite number`,
      code: "SPEC_INVALID",
      exitCode: ExitCode.InvalidInput,
      details: value,
    });
  }
  return value;
}

function compare(operator: string, actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case "equals":
      return Object.is(actual, expected);
    case "not_equals":
      return !Object.is(actual, expected);
    case "truthy":
      return Boolean(actual);
    case "falsy":
      return !actual;
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "greater_than":
      return numeric(actual, "actual") > numeric(expected, "expected");
    case "greater_than_or_equal":
      return numeric(actual, "actual") >= numeric(expected, "expected");
    case "less_than":
      return numeric(actual, "actual") < numeric(expected, "expected");
    case "less_than_or_equal":
      return numeric(actual, "actual") <= numeric(expected, "expected");
    default:
      return false;
  }
}

async function probeCode(
  assertion: Extract<PlaytestAssertion, { type: "probe" }>,
  config: ResolvedProjectConfig,
): Promise<string> {
  if (assertion.code) return assertion.code;
  if (!assertion.file) {
    throw new RobloxAxiError({
      message: "Probe assertion requires code or file",
      code: "SPEC_INVALID",
      exitCode: ExitCode.InvalidInput,
    });
  }
  const path = isAbsolute(assertion.file) ? assertion.file : resolve(config.root, assertion.file);
  return readFile(path, "utf8");
}

export async function evaluateAssertion(
  assertion: PlaytestAssertion,
  index: number,
  context: AssertionContext,
): Promise<AssertionResult> {
  const id = assertion.id ?? `assertion-${index + 1}`;
  if (assertion.type === "console_errors") {
    const actual = context.consoleEntries.filter((entry) => entry.level === "error").length;
    const passed = actual <= assertion.maximum;
    return {
      id,
      type: assertion.type,
      passed,
      expected: `<= ${assertion.maximum}`,
      actual,
      message: passed
        ? `${actual} console errors is within maximum ${assertion.maximum}`
        : `Expected at most ${assertion.maximum} console errors, got ${actual}`,
    };
  }

  if (assertion.type === "probe") {
    const actual = await context.service.executeLuau(
      context.studioId,
      assertion.context,
      await probeCode(assertion, context.config),
    );
    const passed = compare(assertion.operator, actual, assertion.expected);
    return {
      id,
      type: assertion.type,
      passed,
      expected: assertion.expected,
      actual,
      message: passed
        ? `Probe satisfied ${assertion.operator}`
        : `Probe expected ${assertion.operator} ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(actual)}`,
    };
  }

  if (assertion.type === "numeric_delta") {
    const actual = numeric(resolveActual(assertion.actual, context.values), assertion.actual);
    const baseline = numeric(resolveActual(assertion.baseline, context.values), assertion.baseline);
    const expected = assertion.delta;
    const observed = actual - baseline;
    const tolerance = assertion.tolerance ?? 0;
    const passed = Math.abs(observed - expected) <= tolerance;
    return {
      id,
      type: assertion.type,
      passed,
      expected,
      actual: observed,
      message: passed
        ? `Numeric delta ${observed} is within tolerance ${tolerance}`
        : `Expected numeric delta ${expected} ± ${tolerance}, got ${observed}`,
    };
  }

  const actual = resolveActual(assertion.actual, context.values);
  const expected = "expected" in assertion ? assertion.expected : undefined;
  const passed = compare(assertion.type, actual, expected);
  return {
    id,
    type: assertion.type,
    passed,
    expected,
    actual,
    message: passed
      ? `${assertion.actual} satisfied ${assertion.type}`
      : `${assertion.actual} failed ${assertion.type}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  };
}
