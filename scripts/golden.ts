import { join } from "node:path";
import { goldenOptionsFromEnv, runGoldenJourney } from "../src/golden-client";

const report = await runGoldenJourney(goldenOptionsFromEnv(
  // This file lives in <repo>/scripts, so one level up is the repo. `../..`
  // reached the repo's parent and every CLI publish looked for
  // `<repo>/../examples/angels/…`, which does not exist.
  join(import.meta.dir, ".."),
  process.env,
));

console.log(JSON.stringify({ status: "passed", ...report }, null, 2));
