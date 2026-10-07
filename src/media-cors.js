import { writeFileSync } from "node:fs";
const origins = (
  process.env.CORS_ORIGINS ||
  "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173"
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
for (const origin of origins) {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
    throw new Error(
      "CORS_ORIGINS must contain exact HTTP(S) origins without paths or trailing slashes",
    );
}
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
