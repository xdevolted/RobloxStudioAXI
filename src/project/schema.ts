import { readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { ExitCode, RobloxAxiError } from "../errors.js";

export type SchemaName =
  | "project-config"
  | "playtest-spec"
  | "workflow"
  | "run-manifest"
  | "result"
  | "session-record"
  | "session-operation-manifest"
  | "session-result";

let packageRootPromise: Promise<string> | undefined;
const validators = new Map<SchemaName, ValidateFunction>();

async function findPackageRoot(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const packagePath = join(current, "package.json");
    try {
      const value = JSON.parse(await readFile(packagePath, "utf8")) as { name?: string };
      if (value.name === "roblox-studio-axi") {
        return current;
      }
    } catch {
      // Keep walking until the package root is found.
    }
    const parent = parse(current).root === current ? current : dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate the roblox-studio-axi package root");
    }
    current = parent;
  }
}

export function getPackageRoot(): Promise<string> {
  packageRootPromise ??= findPackageRoot();
  return packageRootPromise;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "schema validation failed";
  }
  return errors
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

async function validatorFor(schemaName: SchemaName): Promise<ValidateFunction> {
  const cached = validators.get(schemaName);
  if (cached) {
    return cached;
  }
  const root = await getPackageRoot();
  const schema = JSON.parse(
    await readFile(join(root, "schemas", `${schemaName}.schema.json`), "utf8"),
  ) as object;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    formats: { "date-time": true },
  });
  const validator = ajv.compile(schema);
  validators.set(schemaName, validator);
  return validator;
}

export async function validateSchema<T>(schemaName: SchemaName, value: unknown): Promise<T> {
  const validator = await validatorFor(schemaName);
  if (validator(value)) {
    return value as T;
  }
  const noun = schemaName === "project-config" ? "configuration" : schemaName;
  throw new RobloxAxiError({
    message: `Invalid ${noun}: ${formatAjvErrors(validator.errors)}`,
    code: schemaName === "project-config" ? "CONFIG_INVALID" : "SPEC_INVALID",
    exitCode: ExitCode.InvalidInput,
  });
}
