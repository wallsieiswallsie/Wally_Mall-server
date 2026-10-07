import { randomUUID } from "node:crypto";
import { hashPassword } from "../../src/security.js";
export async function seed(db) {
  if (process.env.NODE_ENV === "production")
    throw new Error("Development seed disabled in production");
  const email = process.env.SEED_SUPER_ADMIN_EMAIL,
    password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12)
    throw new Error(
      "Set explicit SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD (12+ characters)",
    );
  await db.transaction(async (t) => {
    if (await t("users").where({ email }).first())
      throw new Error(
        "Seed account already exists; refusing to modify an existing account",
      );
    const [u] = await t("users")
      .insert({
        public_id: `WA-${randomUUID().slice(0, 24)}`,
        name: "Development Super Admin",
        email,
        password_hash: await hashPassword(password),
      })
      .returning("id");
    const role = await t("roles").where({ code: "super_admin" }).first();
    await t("user_roles").insert({ user_id: u.id, role_id: role.id });
    await t("staff_profiles").insert({ user_id: u.id });
    await t("audit_logs").insert({
      actor_id: u.id,
      actor_role: "super_admin",
      action: "seed.super_admin",
      entity_type: "users",
      entity_id: u.id,
      reason: "Explicit development seed",
      after_data: { role: "super_admin" },
    });
    await t("categories")
      .insert({ slug: "development", name: "Development fixtures" })
      .onConflict("slug")
      .ignore();
  });
}
