import { connect } from "../database/index.js";
import { configFromEnv } from "./config.js";
import { gcsStorage } from "./gcs.js";
import { mediaService } from "./media.js";
const config = configFromEnv();
const db = connect();
try {
  console.log(
    await mediaService(db, gcsStorage(config.gcs), config.gcs.bucket).cleanup(),
  );
} catch {
  console.error(
    "Media cleanup failed; check database and GCS access. No credentials logged.",
  );
  process.exitCode = 1;
} finally {
  await db.destroy();
}
