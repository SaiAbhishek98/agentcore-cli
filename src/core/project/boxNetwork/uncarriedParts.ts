/**
 * The parts of a local box profile that the AgentCore Runtime box profile does not carry. Build
 * renders the Runtime profile from agentcore.json and the network model, so it runs no stdio MCP
 * server, sends only to CloudWatch, imports only its own packs, and writes its own `[agent]` and
 * no `[tool]`. Build warns for each such part, so that a difference from `agentcore dev` is not
 * silent.
 */
import type { ProfilePlaces } from "./profileParser";

/** What the Runtime box profile of the runtime imports and sets. */
export interface RuntimeProfileParts {
  readonly packs: readonly string[];
  /** The `[agent.env]` names that the Runtime profile and its generated packs set. */
  readonly env: readonly string[];
}

/**
 * What one pack adds to Box's resolution of the local profile, from a resolution without it:
 * the tools it adds, and whether it adds a part other than a route, a tool, an MCP server, or a
 * telemetry target. `undefined` when Box cannot resolve the profile without the pack.
 */
export type PackParts = { readonly tools: readonly string[]; readonly other: boolean } | undefined;

export interface UncarriedPartsInput {
  /** The local profile's path from the project root, the place of a part with no line. */
  readonly profilePath: string;
  /** The local profile's own text, parsed. */
  readonly profile: Readonly<Record<string, unknown>>;
  readonly places: ProfilePlaces;
  /** The `box.toml` that Box resolves the local profile to. */
  readonly boxToml: Readonly<Record<string, unknown>>;
  /** The packs of Box's resolution of the local profile. */
  readonly packs: readonly string[];
  readonly runtime: RuntimeProfileParts;
  /** What each pack of `packs` that the Runtime profile does not import adds. */
  readonly packParts: ReadonlyMap<string, PackParts>;
}

/** The telemetry target that `box run` writes for each run, which the Runtime profile has too. */
const BOX_RECORDS_TARGET = "records";

/** The telemetry kinds that the Runtime profile copies. */
const CLOUDWATCH_KINDS: ReadonlySet<string> = new Set(["cloudwatch_logs", "cloudwatch_traces"]);

/**
 * The `[agent]` keys that the Runtime profile writes for itself, on purpose: the command that
 * starts the agent from the zip or the image, its folder, its grants there, and its listener.
 * The check reads `env` one variable at a time.
 */
const RUNTIME_AGENT_KEYS: ReadonlySet<string> = new Set([
  "command",
  "workspace",
  "filesystem",
  "ingress",
  "env",
]);

/** The key of a table that is a condition on the table, not a setting of its own. */
const CONDITION_KEY = "when";

/**
 * The `[agent.env]` variable that only `agentcore dev` sets, on purpose: it turns off AgentCore
 * Identity and Memory in the agent.
 */
const LOCAL_ONLY_VARIABLE = "LOCAL_DEV";

/**
 * The `[tool.<name>]` key that the Runtime profile replaces on purpose: the grants of a tool, as
 * the agent's own grants. Create writes a `deny_write` for box/base's tools, to keep the agent's
 * venv safe, and the Runtime runs the agent from a folder that no process in the box can write.
 */
const RUNTIME_TOOL_KEYS: ReadonlySet<string> = new Set(["filesystem"]);

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `a`, `a and b`, or `a, b, and c`. */
const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * A warning for each part of the local profile that the Runtime profile does not carry: each
 * stdio MCP server, each telemetry target of a kind other than CloudWatch, each pack that the
 * Runtime profile does not import and that adds more than routes, and each `[agent]` and
 * `[tool.<name>]` setting of the profile's own text that the Runtime profile does not set.
 */
export function uncarriedPartWarnings(input: UncarriedPartsInput): string[] {
  const warnings: string[] = [];
  const { entries } = input.places;
  /** Where the text sets the first of `keys`, or else the profile. */
  const inText = (...keys: string[]) =>
    keys.map((key) => entries.get(key)).find((place) => place !== undefined) ?? input.profilePath;
  /** Where the text sets `[<table>.<name>]`, or else where a pack adds it. */
  const inResolution = (table: string, name: string) =>
    entries.get(`${table}.${name}`) ?? input.places.packs ?? input.profilePath;
  /** `[mcp.fs]`, or `[mcp.fs], which a pack in \`packs\` adds,` when the text does not set it. */
  const subject = (table: string, name: string) =>
    entries.has(`${table}.${name}`)
      ? `[${table}.${name}]`
      : `[${table}.${name}], which a pack in \`packs\` adds,`;

  const mcp = isTable(input.boxToml.mcp) ? input.boxToml.mcp : {};
  for (const [name, server] of Object.entries(mcp)) {
    if (isTable(server) && server.type === "http") continue;
    warnings.push(
      `${inResolution("mcp", name)}: ${subject("mcp", name)} is a stdio MCP server, which the Runtime ` +
        "box profile does not run.",
    );
  }

  const telemetry = isTable(input.boxToml.telemetry) ? input.boxToml.telemetry : {};
  for (const [name, target] of Object.entries(telemetry)) {
    if (name === BOX_RECORDS_TARGET || !isTable(target)) continue;
    if (typeof target.kind === "string" && CLOUDWATCH_KINDS.has(target.kind)) continue;
    warnings.push(
      `${inResolution("telemetry", name)}: ${subject("telemetry", name)} has the kind ` +
        `${JSON.stringify(target.kind)}, and the Runtime box profile copies only the ` +
        "cloudwatch_logs and cloudwatch_traces targets.",
    );
  }

  const imported = new Set(input.runtime.packs);
  /** The tools that a pack adds, which the warning of the pack names. */
  const packTools = new Set<string>();
  for (const pack of input.packs) {
    if (imported.has(pack) || !input.packParts.has(pack)) continue;
    const parts = input.packParts.get(pack);
    if (parts && parts.tools.length === 0 && !parts.other) continue;
    const tools = parts?.tools ?? [];
    for (const tool of tools) packTools.add(tool);
    warnings.push(
      `${input.places.packs ?? input.profilePath}: \`packs\` imports ${pack}, which the Runtime ` +
        "box profile does not import, so " +
        (tools.length > 0
          ? `the agent on AgentCore Runtime has no ${LIST.format(tools.map((tool) => `[tool.${tool}]`))}.`
          : "the agent on AgentCore Runtime gets only the routes of the pack."),
    );
  }

  const agent = isTable(input.profile.agent) ? input.profile.agent : {};
  for (const key of Object.keys(agent)) {
    if (RUNTIME_AGENT_KEYS.has(key) || key === CONDITION_KEY) continue;
    warnings.push(
      `${inText(`agent.${key}`)}: [agent] sets ${key}, and the Runtime box profile does not carry it.`,
    );
  }
  const env = isTable(agent.env) ? agent.env : {};
  const runtimeEnv = new Set(input.runtime.env);
  for (const name of Object.keys(env)) {
    if (name === CONDITION_KEY || name === LOCAL_ONLY_VARIABLE || runtimeEnv.has(name)) continue;
    warnings.push(
      `${inText(`agent.env.${name}`, "agent.env")}: [agent.env] sets ${name}, and the Runtime ` +
        "box profile does not carry it.",
    );
  }

  const tools = isTable(input.profile.tool) ? input.profile.tool : {};
  for (const [name, tool] of Object.entries(tools)) {
    if (packTools.has(name) || !isTable(tool)) continue;
    const keys = Object.keys(tool).filter(
      (key) => !RUNTIME_TOOL_KEYS.has(key) && key !== CONDITION_KEY,
    );
    if (keys.length === 0) continue;
    warnings.push(
      `${inText(`tool.${name}.${keys[0]}`, `tool.${name}`)}: [tool.${name}] sets ${LIST.format(keys)}, and the Runtime box ` +
        `profile does not carry ${keys.length > 1 ? "them" : "it"}.`,
    );
  }
  return warnings;
}
