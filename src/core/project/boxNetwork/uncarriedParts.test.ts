import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import { profilePlaces } from "./profileParser";
import { uncarriedPartWarnings, type PackParts, type UncarriedPartsInput } from "./uncarriedParts";

const PROFILE = ".box/agent/local/profile.toml";

/** The parts of the Runtime profile of a CodeZip HTTP agent on Bedrock with one Memory. */
const RUNTIME = {
  packs: ["box/base", "box/bedrock", "box/agentcore", "box/agentcore-codezip"],
  env: [
    "PORT",
    "PYTHONPATH",
    "PYTHONUTF8",
    "PYTHONUNBUFFERED",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "MEMORY_AGENTMEMORY_ID",
  ],
};

/** The `box.toml` that Box resolves the profile `create` writes to, as box 0.1.11 prints it. */
const CREATED_BOX_TOML = {
  name: "demo-preview",
  agent: {
    command: ["/p/app/agent/.venv/bin/python", "-m", "uvicorn", "main:app"],
    workspace: "/p",
    env: { AWS_REGION: "us-west-2", LOCAL_DEV: "1", PATH: "/usr/bin:/bin", PORT: "8081" },
    filesystem: { read: ["/p"], write: ["/p"], deny_write: ["/p/app/agent/.venv"] },
    ingress: [{ listen: "127.0.0.1:8080", workload_port: 8081 }],
  },
  tool: { uname: { command: ["/usr/bin/uname"], env: {}, filesystem: {} } },
  egress: {
    bedrock: {
      destinations: ["bedrock-runtime.us-west-2.amazonaws.com"],
      secret: { ref: "aws://default" },
    },
  },
  telemetry: {
    records: { kind: "file", destination: "/h/.box/runs/demo-preview/records.jsonl" },
  },
};

/** The local profile `create` writes for a CodeZip Strands agent, with `tables` after it. */
const created = (tables = "", top = "") =>
  `${top}packs = ["box/base", "box/bedrock"]\n\n[profile]\nname = "demo"\n\n` +
  '[project]\naccess = "write"\n\n[options]\nbedrock.region = "us-west-2"\n\n' +
  '[agent]\ncommand = ["${{ workspace }}/app/agent/.venv/bin/python", "-m", "uvicorn"]\n\n' +
  '[agent.env]\nLOCAL_DEV = "1"\nPORT = "8081"\nPYTHONUTF8 = "1"\nPYTHONUNBUFFERED = "1"\n\n' +
  '[agent.filesystem]\nread = ["${{ workspace }}/app/agent"]\n\n' +
  '[[agent.ingress]]\nlisten = "127.0.0.1:8080"\nworkload_port = 8081\n\n' +
  '[tool.uname.filesystem]\ndeny_write = [{ path = "${{ workspace }}/app/agent/.venv", optional = true }]\n' +
  '\n[egress.bedrock]\nsecret.ref = "aws://default"\n' +
  tables;

/** The warnings for the profile `text`, which Box resolves to `boxToml` with `packs`. */
function warnings(
  text: string,
  resolved: {
    boxToml?: Record<string, unknown>;
    packs?: string[];
    packParts?: [string, PackParts][];
  } = {},
): string[] {
  const input: UncarriedPartsInput = {
    profilePath: PROFILE,
    profile: parse(text) as Record<string, unknown>,
    places: profilePlaces(text, PROFILE),
    boxToml: resolved.boxToml ?? CREATED_BOX_TOML,
    packs: resolved.packs ?? ["box/base", "box/bedrock"],
    runtime: RUNTIME,
    packParts: new Map(resolved.packParts ?? []),
  };
  return uncarriedPartWarnings(input);
}

/** The line of the profile `text` that starts with `start`, as `<profile>:<line>:1`. */
const lineOf = (text: string, start: string) =>
  `${PROFILE}:${text.split("\n").findIndex((line) => line.startsWith(start)) + 1}:1`;

describe("uncarriedPartWarnings", () => {
  test("gives no warning for the profile create writes, as Box resolves it", () => {
    expect(warnings(created())).toEqual([]);
  });

  test("warns for each stdio MCP server, at its entry, or at `packs` when a pack adds it", () => {
    const text = created('\n[mcp.fs]\ntype = "stdio"\ncommand = ["uvx", "mcp-server-fetch"]\n');
    const boxToml = {
      ...CREATED_BOX_TOML,
      mcp: {
        fs: { type: "stdio", command: ["uvx", "mcp-server-fetch"] },
        "builder-mcp": { type: "stdio", command: ["builder-mcp"] },
        docs: { type: "http", destinations: ["docs.example.com"] },
      },
    };

    expect(warnings(text, { boxToml })).toEqual([
      `${lineOf(text, "[mcp.fs]")}: [mcp.fs] is a stdio MCP server, which the Runtime box ` +
        "profile does not run.",
      `${PROFILE}:1:1: [mcp.builder-mcp], which a pack in \`packs\` adds, is a stdio MCP ` +
        "server, which the Runtime box profile does not run.",
    ]);
  });

  test("warns for each telemetry target that is not CloudWatch, and not for the records target of box run", () => {
    const text = created(
      '\n[telemetry.collector]\nkind = "otlp"\ndestination = "https://otel.example.com"\n',
    );
    const boxToml = {
      ...CREATED_BOX_TOML,
      telemetry: {
        ...CREATED_BOX_TOML.telemetry,
        collector: { kind: "otlp", destination: "https://otel.example.com" },
        traces: { kind: "langfuse", secret: { ref: "env://LANGFUSE_AUTH" } },
        logs: { kind: "cloudwatch_logs", region: "us-west-2" },
        "x-ray": { kind: "cloudwatch_traces", region: "us-west-2" },
      },
    };

    expect(warnings(text, { boxToml })).toEqual([
      `${lineOf(text, "[telemetry.collector]")}: [telemetry.collector] has the kind "otlp", and ` +
        "the Runtime box profile copies only the cloudwatch_logs and cloudwatch_traces targets.",
      `${PROFILE}:1:1: [telemetry.traces], which a pack in \`packs\` adds, has the kind ` +
        '"langfuse", and the Runtime box profile copies only the cloudwatch_logs and ' +
        "cloudwatch_traces targets.",
    ]);
  });

  test("warns for each pack the Runtime profile does not import, unless it adds only routes", () => {
    const packs = ["box/base", "box/bedrock", "box/anthropic", "box/git", "box/mantle", "box/odd"];
    const text = created("", `# the user's packs\n`).replace(
      'packs = ["box/base", "box/bedrock"]',
      `packs = ${JSON.stringify(packs)}`,
    );

    expect(
      warnings(text, {
        packs,
        packParts: [
          ["box/anthropic", { tools: [], other: false }],
          ["box/git", { tools: ["git"], other: true }],
          ["box/mantle", { tools: [], other: true }],
          ["box/odd", undefined],
        ],
      }),
    ).toEqual([
      `${PROFILE}:2:1: \`packs\` imports box/git, which the Runtime box profile does not import, ` +
        "so the agent on AgentCore Runtime has no [tool.git].",
      `${PROFILE}:2:1: \`packs\` imports box/mantle, which the Runtime box profile does not ` +
        "import, so the agent on AgentCore Runtime gets only the routes of the pack.",
      `${PROFILE}:2:1: \`packs\` imports box/odd, which the Runtime box profile does not import, ` +
        "so the agent on AgentCore Runtime gets only the routes of the pack.",
    ]);
  });

  test("warns for each [agent] key and variable the Runtime profile does not set, and not for the ones it replaces", () => {
    const text = created()
      .replace("[agent.env]\n", '[agent.env]\nMODEL_TEMPERATURE = "0.2"\nTERM = "dumb"\n')
      .replace(
        "[agent]\n",
        "[agent]\nnative-filesystem-policy = false\nfile-watching = true\nwhen = true\n",
      );

    expect(warnings(text)).toEqual([
      `${lineOf(text, "native-filesystem-policy")}: [agent] sets native-filesystem-policy, and the ` +
        "Runtime box profile does not carry it.",
      `${lineOf(text, "file-watching")}: [agent] sets file-watching, and the Runtime box profile ` +
        "does not carry it.",
      `${lineOf(text, "MODEL_TEMPERATURE")}: [agent.env] sets MODEL_TEMPERATURE, and the Runtime ` +
        "box profile does not carry it.",
      `${lineOf(text, "TERM")}: [agent.env] sets TERM, and the Runtime box profile does not carry it.`,
    ]);
  });

  test("warns for each [tool] setting other than grants, and not again for a tool its pack warns for", () => {
    const text = created(
      '\n[tool.uname.env]\nLC_ALL = "C"\n' +
        '\n[tool.jq]\nprogram = "jq"\nhosts = ["example.com"]\n' +
        '\n[tool.git.env]\nGIT_AUTHOR_NAME = "Me"\n',
    );

    expect(
      warnings(text, {
        packs: ["box/base", "box/bedrock", "box/git"],
        packParts: [["box/git", { tools: ["git"], other: false }]],
      }),
    ).toEqual([
      `${PROFILE}:1:1: \`packs\` imports box/git, which the Runtime box profile does not import, ` +
        "so the agent on AgentCore Runtime has no [tool.git].",
      `${lineOf(text, "[tool.uname.env]")}: [tool.uname] sets env, and the Runtime box profile ` +
        "does not carry it.",
      `${lineOf(text, 'program = "jq"')}: [tool.jq] sets program and hosts, and the Runtime box ` +
        "profile does not carry them.",
    ]);
  });
});
