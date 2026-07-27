import { join } from "node:path";
import { goldenOptionsFromEnv, runGoldenJourney } from "../src/golden-client";

const report = await runGoldenJourney(goldenOptionsFromEnv(
  join(import.meta.dir, "../.."),
  process.env,
));

console.log(JSON.stringify({ status: "passed", ...report }, null, 2));
