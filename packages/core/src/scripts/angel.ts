#!/usr/bin/env bun

import { runAngelCommand } from "../cli/commands";

await runAngelCommand(process.argv.slice(2), {
  repoRoot: process.cwd(),
  env: process.env,
});
