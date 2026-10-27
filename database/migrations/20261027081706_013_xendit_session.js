// Additive provider state. Order/store allocation remains local; no payout or split transfers.
export async function up(knex) {
  await knex.schema.alterTable("payments", t => {
    t.text("checkout_url");
    t.timestamp("session_requested_at", { useTz: true });
    t.string("provider_payment_request_id", 255);
    t.string("provider_payment_id", 255);
    t.boolean("reconciliation_required").notNullable().defaultTo(false);
  });
  await knex.schema.alterTable("refunds", t => {
    t.timestamp("provider_requested_at", { useTz: true });
  });
}
export async function down(knex) {
  await knex.schema.alterTable("refunds", t => t.dropColumn("provider_requested_at"));
  await knex.schema.alterTable("payments", t => t.dropColumns("checkout_url", "session_requested_at", "provider_payment_request_id", "provider_payment_id", "reconciliation_required"));
}