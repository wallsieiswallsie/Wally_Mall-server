import { readdir } from "node:fs/promises";
export const expectedMigrations = (
  await readdir(new URL("./migrations/", import.meta.url))
)
  .filter((name) => name.endsWith(".js"))
  .sort();
// Do not use db.migrate.list(): Knex creates history tables if absent.
// No writes and no repair: deployment must apply migrations before receiving traffic.
export async function checkReadiness(db) {
  const { rows } = await db.raw(
    "SELECT name FROM knex_migrations ORDER BY name",
  );
  if (
    rows.length !== expectedMigrations.length ||
    rows.some((row, i) => row.name !== expectedMigrations[i])
  )
    throw new Error("Schema not ready");
  // PostgreSQL resolves relations and columns even with LIMIT 0.
  await db.raw(`SELECT p.id, p.status, v.price, i.on_hand, i.reserved,
    pm.media_asset_id, ma.public_url, ma.purged_at, c.buyer_id,
    pay.provider, pay.status, o.checkout_id, sm.role, us.revoked_at
    FROM products p, product_variants v, inventories i, product_media pm,
    media_assets ma, checkouts c, payments pay, orders o, store_members sm,
    user_sessions us LIMIT 0`);
}
