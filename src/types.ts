export type ScreenshotPolicy = "always" | "on_failure" | "never";
export type ConsolePolicy = "all" | "errors_and_warnings" | "errors";
export type StudioMode = "edit" | "play" | "paused";
export type DataModelContext = "edit" | "client" | "server";

export interface ProjectConfigFile {
  schema_version: 1;
  project: {
    name: string;
    place_id?: number;
    universe_id?: number;
    expected_place_name?: string;
    local_place?: string;
  };
  studio?: {
    executable?: string;
    mcp_command?: string;
    mcp_args?: string[];
    startup_timeout_seconds?: number;
    operation_timeout_seconds?: number;
  };
  testing?: {
    playtests?: string;
    workflows?: string;
    default_workflow?: string;
  };
  evidence?: {
    directory?: string;
    screenshots?: ScreenshotPolicy;
    console?: ConsolePolicy;
  };
  safety?: {
    environment?: "test" | "development" | "production";
    allow_publish?: false;
    allow_live_datastores?: boolean;
    always_stop_playtest?: true;
  };
}

export interface ResolvedProjectConfig {
  schemaVersion: 1;
  root: string;
  configPath: string;
  project: {
    name: string;
    placeId?: number;
    universeId?: number;
    expectedPlaceName?: string;
    localPlace?: string;
  };
  studio: {
    executable?: string;
    mcpCommand?: string;
    mcpArgs: string[];
    startupTimeoutMs: number;
    operationTimeoutMs: number;
  };
  testing: {
    playtestsDirectory: string;
    workflowsDirectory: string;
    defaultWorkflow?: string;
  };
  evidence: {
    directory: string;
    screenshots: ScreenshotPolicy;
    console: ConsolePolicy;
  };
  safety: {
    environment: "test" | "development" | "production";
    allowPublish: false;
    allowLiveDatastores: boolean;
    alwaysStopPlaytest: true;
  };
}

export type Target =
  | { instance_path: string }
  | { test_id: string }
  | { tag: string }
  | { semantic: string }
  | { coordinates: { x: number; y: number } };

interface StepBase {
  id?: string;
  timeout_seconds?: number;
}

export type PlaytestStep =
  | (StepBase & { action: "wait"; duration_ms: number })
  | (StepBase & { action: "wait_for_state"; state: StudioMode })
  | (StepBase & { action: "wait_for_player" })
  | (StepBase & { action: "start_play" | "stop_play" | "console_capture" })
  | (StepBase & { action: "execute_luau"; context: DataModelContext; code?: string; file?: string })
  | (StepBase & {
      action: "navigate";
      position?: [number, number, number];
      target?: Target;
      speed_multiplier?: number;
    })
  | (StepBase & { action: "keyboard"; sequence: Array<Record<string, unknown>>; target?: Target })
  | (StepBase & { action: "mouse"; sequence: Array<Record<string, unknown>>; target?: Target })
  | (StepBase & { action: "capture"; label: string });

interface AssertionBase {
  id?: string;
  after_step?: string;
}

export type ComparisonOperator =
  | "equals"
  | "not_equals"
  | "truthy"
  | "falsy"
  | "exists"
  | "not_exists"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal";

export type PlaytestAssertion =
  | (AssertionBase & { type: "console_errors"; maximum: number })
  | (AssertionBase & { type: "truthy" | "falsy" | "exists" | "not_exists"; actual: string })
  | (AssertionBase & {
      type:
        | "equals"
        | "not_equals"
        | "greater_than"
        | "greater_than_or_equal"
        | "less_than"
        | "less_than_or_equal";
      actual: string;
      expected: unknown;
    })
  | (AssertionBase & {
      type: "numeric_delta";
      actual: string;
      baseline: string;
      delta: number;
      tolerance?: number;
    })
  | (AssertionBase & {
      type: "probe";
      context: DataModelContext;
      code?: string;
      file?: string;
      operator: ComparisonOperator;
      expected?: unknown;
    });

export interface PlaytestSpec {
  schema_version: 1;
  id: string;
  title: string;
  setup?: {
    mode?: "edit" | "play";
    timeout_seconds?: number;
  };
  steps: PlaytestStep[];
  assertions?: PlaytestAssertion[];
  cleanup: {
    stop_playtest: true;
  };
}

export interface WorkflowSpec {
  schema_version: 1;
  name: string;
  tests: {
    include: string[];
    exclude?: string[];
  };
  execution?: {
    fail_fast?: boolean;
    timeout_seconds?: number;
  };
  evidence?: {
    screenshots?: ScreenshotPolicy;
    console?: ConsolePolicy;
  };
  cleanup: {
    stop_playtest: true;
  };
}

export interface StudioInstance {
  id: string;
  name: string;
  placeId?: number;
}

export interface StudioState {
  mode: StudioMode;
  availableDataModels: string[];
  raw: unknown;
}

export interface ConsoleEntry {
  level: "error" | "warning" | "info";
  message: string;
  timestamp?: string;
}

export interface ScreenshotData {
  data: string;
  mimeType: string;
}

export interface AssertionResult {
  id: string;
  type: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

export interface RunManifest {
  schema_version: 1;
  axi_version: string;
  run_id: string;
  test_id: string;
  test_spec_digest: string;
  project: string;
  git_sha: string | null;
  studio_id: string;
  place_id: number | null;
  started_at: string;
  configuration: Record<string, unknown>;
}

export interface TestResult {
  schema_version: 1;
  run_id: string;
  test_id: string;
  status: "passed" | "failed" | "error";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  last_studio_state: string | null;
  assertions: {
    passed: number;
    failed: number;
    results: AssertionResult[];
  };
  console: {
    errors: number;
    warnings: number;
    path: string;
    excerpt?: string;
  };
  cleanup: {
    status: "passed" | "failed" | "not_needed";
    stop_attempted: boolean;
    error?: string;
  };
  evidence: {
    directory: string;
    screenshots: string[];
  };
  failure?: {
    code: string;
    message: string;
    step: number | null;
    assertion: string | null;
  };
}
