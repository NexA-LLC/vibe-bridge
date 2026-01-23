import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * Minimal .env loader (no deps).
 * - Supports: KEY=VALUE, export KEY=VALUE
 * - Supports quoted values: "..." or '...'
 * - Does NOT override existing process.env
 */
function loadDotEnvFile(envFilePath) {
  if (!fs.existsSync(envFilePath)) {
    throw new Error(`Env file not found: ${envFilePath}`);
  }
  const raw = fs.readFileSync(envFilePath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const line0 of lines) {
    const line = line0.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = normalized.indexOf("=");
    if (eq <= 0) continue;

    const key = normalized.slice(0, eq).trim();
    let value = normalized.slice(eq + 1).trim();
    if (!key) continue;
    if (process.env[key] !== undefined) continue;

    const first = value[0];
    if ((first === `"` || first === `'`) && value.length >= 2) {
      const last = value[value.length - 1];
      if (last === first) value = value.slice(1, -1);
    }

    // Minimal value expansions for ergonomics:
    // - "~" prefix -> HOME
    // - "$HOME" / "${HOME}" -> HOME
    const home = process.env.HOME || "";
    if (home) {
      if (value === "~") value = home;
      else if (value.startsWith("~/")) value = `${home}/${value.slice(2)}`;
      value = value.replaceAll("${HOME}", home).replaceAll("$HOME", home);
    }

    process.env[key] = value;
  }
}

function printUsage() {
  console.error("Usage:");
  console.error("  node scripts/with-env.mjs [--env-file <path>] -- <command> [args...]");
  console.error("");
  console.error("Examples:");
  console.error("  node scripts/with-env.mjs -- node apps/runner/dist/index.js");
  console.error("  node scripts/with-env.mjs --env-file .env.runner -- node apps/runner/dist/index.js");
}

const argv = process.argv.slice(2);
let envFile = process.env.ENV_FILE || ".env";

let i = 0;
while (i < argv.length) {
  const a = argv[i];
  if (a === "--") break;
  if (a === "--env-file") {
    envFile = argv[i + 1];
    i += 2;
    continue;
  }
  if (a === "-h" || a === "--help") {
    printUsage();
    process.exit(0);
  }
  // Unknown flag before `--`
  console.error(`Unknown arg: ${a}`);
  printUsage();
  process.exit(1);
}

const sep = argv.indexOf("--");
if (sep === -1) {
  printUsage();
  process.exit(1);
}

const cmd = argv[sep + 1];
const cmdArgs = argv.slice(sep + 2);
if (!cmd) {
  printUsage();
  process.exit(1);
}

loadDotEnvFile(envFile);

const child = spawn(cmd, cmdArgs, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});

