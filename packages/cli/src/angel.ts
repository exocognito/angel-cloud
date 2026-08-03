#!/usr/bin/env bun

import { runAngelCommand } from "@smcllns/angel-core/cli";

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
  await runAngelCommand(args, {
    repoRoot: process.cwd(),
    env: process.env,
  });
}
