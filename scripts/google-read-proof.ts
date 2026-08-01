import { readFileSync } from "node:fs";
import {
  googleReadProofOptionsFromEnv,
  runGoogleReadProofAcceptance,
  serializeGoogleReadProofReport,
} from "../src/google-read-proof-acceptance";

const expectedPolicyDigest = readFileSync(
  new URL("../examples/angels/google-read-proof/build/angel.version.sha256", import.meta.url),
  "utf8",
).trim();
const report = await runGoogleReadProofAcceptance(
  googleReadProofOptionsFromEnv(process.env, expectedPolicyDigest),
);
console.log(serializeGoogleReadProofReport(report));
