/**
 * 011_category_name_unique.js
 * Wally Mall - Case-insensitive unique category names for the admin-managed category master.
 * Soft-deleted categories are excluded so a removed name can be reused.
 */

export async function up(knex) {
  const duplicates = await knex("categories")
    .whereNull("deleted_at")
    .select(knex.raw("lower(btrim(name)) AS normalized"))
    .groupByRaw("lower(btrim(name))")
    .havingRaw("count(*) > 1");
  if (duplicates.length)
    throw new Error(
      `Duplicate category names must be resolved before migrating: ${duplicates
        .map((d) => d.normalized)
        .join(", ")}`,
    );

  await knex.raw(`
    CREATE UNIQUE INDEX uq_categories_name_ci
      ON categories (lower(btrim(name)))
      WHERE deleted_at IS NULL;
  `);
}

export async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS uq_categories_name_ci;");
}