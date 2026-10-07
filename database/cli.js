import { connect } from "./index.js";
const db = connect();
try {
  const command = process.argv[2];
  if (command === "latest") console.log(await db.migrate.latest());
  else if (command === "rollback") console.log(await db.migrate.rollback());
  else if (command === "status") {
    const [done, pending] = await db.migrate.list();
    console.log({
      completed: done.map((x) => x.name),
      pending: pending.map((x) => x.file),
    });
  } else if (command === "seed") console.log(await db.seed.run());
  else throw new Error("Use latest, rollback, status, or seed");
} finally {
  await db.destroy();
}
