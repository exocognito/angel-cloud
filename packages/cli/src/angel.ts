#!/usr/bin/env bun

// Resolved by path rather than by package name on purpose: the public package
// declares no dependency on core, so both packers produce the same manifest and
// a consumer installs one package.
import { runAngelCommand } from "../../core/src/cli/index";

// Injected by build.ts from this package's manifest so the published binary
// reports its own version without reading a file at runtime.
declare const ANGEL_CLI_VERSION: string;

const USAGE = `angel ${ANGEL_CLI_VERSION}

usage:
  angel build <angel>
  angel publish <angel> [--preview [--share-production-credentials]]
  angel deploy <angel> --prod
  angel delete <angel> [--confirm <slug>]
  angel --version
  angel --help`;

const args = process.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
  console.log(ANGEL_CLI_VERSION);
} else if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(USAGE);
} else {
  try {
    await runAngelCommand(args, {
      repoRoot: process.cwd(),
      env: process.env,
    });
  } catch (error) {
    // A stack trace through bundled line numbers helps nobody. Core raises its
    // own shorter usage string, which omits --help and --version; print this
    // package's instead so one command map is authoritative.
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith("usage:") ? USAGE : message);
    process.exit(1);
  }
}
