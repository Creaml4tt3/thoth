/**
 * Run the conformance suite against a server.
 *
 *   THOTH_TOKEN=... node protocol/conformance/src/cli.ts --url https://workspace.example.com
 *
 * The bearer token is read from an environment variable (default THOTH_TOKEN, see
 * --token-env) and is never accepted as an argument and never printed.
 * Exit codes: 0 no failed check, 1 at least one failed check, 2 usage or configuration error.
 */
import { formatReport, runConformance } from "./index.ts";

const USAGE = `Usage: node protocol/conformance/src/cli.ts --url <server-url> [options]

Options:
  --url <url>          Server origin; /api/v1 is appended (required)
  --token-env <NAME>   Environment variable holding the bearer token (default THOTH_TOKEN)
  --workspace <id>     Run write checks in this workspace (default: first owner/editor workspace)
  --json               Print the report as JSON instead of text
  --help               Show this help

The suite creates and deletes pages in the chosen workspace; use a test workspace.`;

interface Args {
  url?: string;
  tokenEnv: string;
  workspace?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = { tokenEnv: "THOTH_TOKEN", json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string | undefined => argv[++i];
    switch (arg) {
      case "--url": {
        const v = value();
        if (!v) return "--url needs a value";
        args.url = v;
        break;
      }
      case "--token-env": {
        const v = value();
        if (!v) return "--token-env needs a variable name";
        args.tokenEnv = v;
        break;
      }
      case "--workspace": {
        const v = value();
        if (!v) return "--workspace needs a workspace ID";
        args.workspace = v;
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        return arg === "--token" || arg.startsWith("--token=") ? "tokens are not accepted as arguments (they leak into shell history); set the environment variable instead" : `unknown argument: ${arg}`;
    }
  }
  return args;
}

const parsed = parseArgs(process.argv.slice(2));
if (typeof parsed === "string") {
  console.error(`error: ${parsed}\n\n${USAGE}`);
  process.exit(2);
}
if (parsed.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!parsed.url) {
  console.error(`error: --url is required\n\n${USAGE}`);
  process.exit(2);
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.tokenEnv)) {
  console.error("error: --token-env must be a valid environment variable name");
  process.exit(2);
}
const token = process.env[parsed.tokenEnv];
if (!token) {
  console.error(`error: environment variable ${parsed.tokenEnv} is not set or empty`);
  process.exit(2);
}

try {
  const report = await runConformance({ baseUrl: parsed.url, token, ...(parsed.workspace ? { workspaceId: parsed.workspace } : {}) });
  console.log(parsed.json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exit(report.summary.fail > 0 ? 1 : 0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message.split(token).join("[redacted]")}`);
  process.exit(2);
}
