import { writeFileSync } from "node:fs";
import { originsFromEnv } from "./config.js";
const origins = originsFromEnv();
const json =
  JSON.stringify(
    [
      {
        origin: [...new Set(origins)],
        method: ["PUT"],
        responseHeader: ["Content-Type", "x-goog-if-generation-match"],
        maxAgeSeconds: 3600,
      },
    ],
    null,
    2,
  ) + "\n";
if (process.argv[2]) writeFileSync(process.argv[2], json, "utf8");
else console.log(json);
