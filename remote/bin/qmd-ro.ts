#!/usr/bin/env bun
// Server-side forced command. Reads NUL-separated argv from stdin, checks the
// whitelist, then execs the real qmd. Args arrive as NUL stream, not as a shell
// string, so nothing here is ever re-parsed by a shell.

const ALLOWED_COMMANDS = new Set([
  "query",
  "multi-get",
  "status",
  "ls"
]);

// Read-only subcommands only. `collection add` rewrites the index config.
const ALLOWED_SUBCOMMANDS: Record<string, string[]> = {
  collection: ["list"],
  context: ["list"],
};

function fail(code: number, message: string): never {
  process.stderr.write(`qmd-ro: ${message}\n`);
  process.exit(code);
}

function allowedList(): string[] {
  const subs = Object.entries(ALLOWED_SUBCOMMANDS).map(
    ([cmd, list]) => `${cmd} (${list.join("|")})`,
  );
  return [...ALLOWED_COMMANDS, ...subs];
}

// Local mode passes argv straight in (the shim has no ssh to hide behind).
// ssh mode gets a bare `qmd-ro` with the argv on stdin.
async function readArgv(): Promise<string[]> {
  if (process.argv.length > 2) return process.argv.slice(2);

  const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const parts = text.split("\0");
  // printf '%s\0' always emits a trailing NUL, so the last part is empty.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

const argv = await readArgv();

if (argv[0] === "--print-allowed") {
  for (const name of allowedList()) console.log(name);
  process.exit(0);
}

if (argv.length === 0) {
  fail(1, "no command received on stdin (expected NUL-separated argv)");
}

const command = argv[0]!;
const sub = argv[1];
const subAllowed = ALLOWED_SUBCOMMANDS[command];

if (subAllowed) {
  if (!sub || !subAllowed.includes(sub)) {
    fail(2, `subcommand not allowed: ${command} ${sub ?? ""} (allowed: ${subAllowed.join(", ")})`);
  }
} else if (!ALLOWED_COMMANDS.has(command)) {
  fail(2, `command not allowed: ${command} (allowed: ${allowedList().join(", ")})`);
}

const realBin = process.env.QMD_RO_BIN || Bun.which("qmd");
if (!realBin) {
  fail(5, "qmd binary not found on server (set QMD_RO_BIN)");
}

const proc = Bun.spawn([realBin, ...argv], {
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});
const code = await proc.exited;

// 255 belongs to ssh; never let it leave this process as a "real" answer.
process.exit(code === 255 ? 5 : code);
