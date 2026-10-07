import { randomUUID } from "node:crypto";
import { ensure, pick, money } from "../../src/domain.js";
import { audit, membership } from "../transactions/commerce.js";
const publicId = (prefix) =>
  `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
const storeFields = [
  "id",
  "slug",
  "name",
  "description",
  "logo_url",
  "banner_url",
  "primary_category_id",
  "status",
  "verification_status",
];
const categoryFields = [
  "id",
  "parent_id",
  "slug",
  "name",
  "status",
  "sort_order",
  "created_at",
  "updated_at",
];
// Every record that points at a category; a referenced category may be deactivated but never deleted.
const categoryUsage = (alias) => `(
  (SELECT count(*) FROM products WHERE category_id = ${alias}.id)
  + (SELECT count(*) FROM stores WHERE primary_category_id = ${alias}.id)
  + (SELECT count(*) FROM seller_applications WHERE business_category_id = ${alias}.id)
  + (SELECT count(*) FROM categories WHERE parent_id = ${alias}.id AND deleted_at IS NULL)
  + (SELECT count(*) FROM platform_fee_rules WHERE scope_type = 'category' AND scope_id = ${alias}.id)
)::int`;
const slugify = (name) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "kategori";
async function assertCategoryNameFree(t, name, exceptId) {
  const q = t("categories")
    .whereNull("deleted_at")
    .whereRaw("lower(btrim(name)) = lower(btrim(?))", [name]);
  if (exceptId) q.whereNot({ id: exceptId });
  ensure(!(await q.first()), "CATEGORY_NAME_TAKEN");
}
// The unique index is the race-safe backstop for the pre-check above.
async function categoryWrite(query) {
  try {
    return await query;
  } catch (e) {
    ensure(
      !(e.code === "23505" && e.constraint === "uq_categories_name_ci"),
      "CATEGORY_NAME_TAKEN",
    );
    throw e;
  }
}
export function managementRepository(db, mediaService) {
  return {
    applications: (userId) =>
      db("seller_applications as a")
        .leftJoin("categories as c", "c.id", "a.business_category_id")
        .where({ "a.user_id": userId })
        .select(
          "a.id",
          "a.proposed_store_name",
          "a.business_description",
          "a.business_category_id",
          "c.name as business_category_name",
          "a.status",
          "a.submitted_at",
          "a.rejection_reason",
        )
        .orderBy("a.created_at", "desc"),
    async apply(userId, input) {
      return db.transaction(async (t) => {
        await t("users").where({ id: userId }).forUpdate().first();
        ensure(
          !(await t("seller_applications")
            .where({ user_id: userId })
            .whereIn("status", ["draft", "submitted", "under_review"])
            .first()),
          "APPLICATION_ALREADY_OPEN",
        );
        const { documents, ...fields } = input;
        ensure(
          await t("categories")
            .where({ id: fields.business_category_id, status: "active" })
            .whereNull("deleted_at")
            .forShare()
            .first(),
          "CATEGORY_UNAVAILABLE",
        );
        const [app] = await t("seller_applications")
          .insert({
            ...fields,
            user_id: userId,
            status: "submitted",
            submitted_at: t.fn.now(),
          })
          .returning("id");
        for (const doc of documents)
          await t("seller_documents").insert({
            ...doc,
            application_id: app.id,
          });
        return { id: app.id, status: "submitted" };
      });
    },
    async reviewApplication(ctx, id, input) {
      return db.transaction(async (t) => {
        const app = await t("seller_applications")
          .where({ id })
          .forUpdate()
          .first();
        ensure(app, "NOT_FOUND", 404);
        ensure(
          ["submitted", "under_review"].includes(app.status),
          "APPLICATION_TERMINAL",
        );
        const to = input.approve ? "approved" : "rejected";
        await t("seller_applications")
          .where({ id })
          .update({
            status: to,
            reviewed_by: ctx.id,
            reviewed_at: t.fn.now(),
            updated_at: t.fn.now(),
            rejection_reason: input.approve ? null : input.reason,
          });
        await t("seller_documents")
          .where({ application_id: id })
          .update({
            status: input.approve ? "verified" : "rejected",
            reviewed_by: ctx.id,
            reviewed_at: t.fn.now(),
            rejection_reason: input.approve ? null : input.reason,
          });
        let store;
        if (input.approve) {
          [store] = await t("stores")
            .insert({
              public_id: publicId("WS"),
              slug: `store-${randomUUID()}`,
              name: app.proposed_store_name,
              description: app.business_description,
              primary_category_id: app.business_category_id,
              status: "draft",
              verification_status: "verified",
            })
            .returning(storeFields);
          await t("store_members").insert({
            store_id: store.id,
            user_id: app.user_id,
            role: "owner",
          });
          const role = await t("roles").where({ code: "seller" }).first();
          await t("user_roles")
            .insert({
              user_id: app.user_id,
              role_id: role.id,
              assigned_by: ctx.id,
            })
            .onConflict(["user_id", "role_id"])
            .merge({
              revoked_at: null,
              assigned_by: ctx.id,
              assigned_at: t.fn.now(),
            });
        }
        await audit(
          t,
          ctx,
          "seller.application.review",
          "seller_applications",
          id,
          input.reason,
          { status: app.status },
          { status: to, store_id: store?.id },
        );
        return { id, status: to, store };
      });
    },
    stores: (userId) =>
      db("stores as s")
        .join("store_members as m", "m.store_id", "s.id")
        .where({ "m.user_id": userId, "m.status": "active" })
        .select(storeFields.map((k) => `s.${k}`))
        .select("m.role"),
    async updateStore(ctx, id, input) {
      return db.transaction(async (t) => {
        await membership(t, ctx.id, id, ["owner", "manager"]);
        const before = await t("stores").where({ id }).forUpdate().first();
        ensure(before, "NOT_FOUND", 404);
        const { address, ...fields } = input;
        if (address) {
          const old = await t("store_addresses")
            .where({ store_id: id, is_primary: true })
            .first();
          if (old)
            await t("store_addresses")
              .where({ id: old.id })
              .update({ ...address, updated_at: t.fn.now() });
          else
            await t("store_addresses").insert({
              ...address,
              store_id: id,
              is_primary: true,
            });
        }
        if (fields.status === "active") {
          ensure(
            before.verification_status === "verified" &&
              !["suspended", "closed"].includes(before.status),
            "STORE_NOT_APPROVED",
          );
          ensure(
            await t("store_addresses")
              .where({ store_id: id, is_primary: true })
              .first(),
            "STORE_ADDRESS_REQUIRED",
          );
        }
        ensure(
          !["suspended", "closed"].includes(before.status),
          "STORE_RESTRICTED",
        );
        const [after] = await t("stores")
          .where({ id })
          .update({ ...fields, updated_at: t.fn.now() })
          .returning(storeFields);
        return after;
      });
    },
    async products(userId, storeId) {
      await membership(db, userId, storeId);
      return db("products")
        .where({ store_id: storeId })
        .select(
          "id",
          "slug",
          "name",
          "description",
          "category_id",
          "condition",
          "status",
          "moderation_status",
          "min_price",
          "max_price",
        )
        .orderBy("created_at", "desc")
        .limit(100);
    },
    async createProduct(ctx, storeId, input) {
      return db.transaction(async (t) => {
        await membership(t, ctx.id, storeId, ["owner", "manager"]);
        const store = await t("stores")
          .where({ id: storeId })
          .forShare()
          .first();
        ensure(
          store && !["suspended", "closed"].includes(store.status),
          "STORE_RESTRICTED",
        );
        const category = await t("categories")
          .where({ id: input.category_id, status: "active" })
          .whereNull("deleted_at")
          .first();
        ensure(category, "CATEGORY_UNAVAILABLE");
        const { variants, media, tags, ...fields } = input;
        const prices = variants
          .map((v) => money(v.price))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const [p] = await t("products")
          .insert({
            ...fields,
            store_id: storeId,
            public_id: publicId("WP"),
            slug: `product-${randomUUID()}`,
            min_price: prices[0].toString(),
            max_price: prices.at(-1).toString(),
            status: "active",
            moderation_status: "pending",
          })
          .returning(["id", "slug", "status", "moderation_status"]);
        for (const v of variants) {
          const { on_hand, ...fields } = v;
          const [variant] = await t("product_variants")
            .insert({ ...fields, product_id: p.id })
            .returning("id");
          await t("inventories").insert({ variant_id: variant.id, on_hand });
          if (on_hand)
            await t("inventory_movements").insert({
              variant_id: variant.id,
              type: "restock",
              quantity: on_hand,
              before_quantity: 0,
              after_quantity: on_hand,
              actor_id: ctx.id,
              reason: "Initial inventory",
            });
        }
        if (media.length) await mediaService.attach(t, ctx.id, p.id, media);
        for (const name of [
          ...new Set(tags.map((x) => x.toLowerCase().trim())),
        ]) {
          await t("tags")
            .insert({ name, normalized_name: name })
            .onConflict("normalized_name")
            .ignore();
          const tag = await t("tags").where({ normalized_name: name }).first();
          await t("product_tags").insert({
            product_id: p.id,
            tag_id: tag.id,
            source: "seller",
          });
        }
        return p;
      });
    },
    async updateProduct(ctx, id, input) {
      return db.transaction(async (t) => {
        const p = await t("products").where({ id }).forUpdate().first();
        ensure(p, "NOT_FOUND", 404);
        await membership(t, ctx.id, p.store_id, ["owner", "manager"]);
        ensure(
          !["suspended", "archived"].includes(p.status),
          "PRODUCT_RESTRICTED",
        );
        if (input.category_id)
          ensure(
            await t("categories")
              .where({ id: input.category_id, status: "active" })
              .whereNull("deleted_at")
              .first(),
            "CATEGORY_UNAVAILABLE",
          );
        const [result] = await t("products")
          .where({ id })
          .update({
            ...input,
            moderation_status: "pending",
            updated_at: t.fn.now(),
          })
          .returning([
            "id",
            "name",
            "description",
            "status",
            "moderation_status",
          ]);
        return result;
      });
    },
    async variant(ctx, id, input) {
      return db.transaction(async (t) => {
        const v = await t("product_variants").where({ id }).forUpdate().first();
        ensure(v, "NOT_FOUND", 404);
        const p = await t("products").where({ id: v.product_id }).first();
        await membership(t, ctx.id, p.store_id, ["owner", "manager"]);
        const store = await t("stores").where({ id: p.store_id }).first();
        ensure(
          store &&
            !["suspended", "closed"].includes(store.status) &&
            !["suspended", "archived"].includes(p.status),
          "STORE_OR_PRODUCT_RESTRICTED",
        );
        const { on_hand, ...fields } = input;
        if (on_hand !== undefined) {
          const inv = await t("inventories")
            .where({ variant_id: id })
            .whereNull("store_address_id")
            .forUpdate()
            .first();
          ensure(inv && on_hand >= inv.reserved, "INVALID_INVENTORY");
          const delta = on_hand - inv.on_hand;
          if (delta) {
            await t("inventories")
              .where({ id: inv.id })
              .update({ on_hand, updated_at: t.fn.now() });
            await t("inventory_movements").insert({
              variant_id: id,
              type: "adjustment",
              quantity: delta,
              before_quantity: inv.on_hand,
              after_quantity: on_hand,
              actor_id: ctx.id,
              reason: "Seller stock adjustment",
            });
          }
        }
        if (Object.keys(fields).length)
          await t("product_variants")
            .where({ id })
            .update({ ...fields, updated_at: t.fn.now() });
        const prices = await t("product_variants")
          .where({ product_id: p.id, status: "active" })
          .min("price as min")
          .max("price as max")
          .first();
        await t("products").where({ id: p.id }).update({
          min_price: prices.min,
          max_price: prices.max,
          updated_at: t.fn.now(),
        });
        return { id };
      });
    },
    async operational(kind) {
      if (kind === "applications")
        return db("seller_applications as a")
          .leftJoin("categories as c", "c.id", "a.business_category_id")
          .select(
            "a.id",
            "a.proposed_store_name",
            "a.business_description",
            "a.business_category_id",
            "c.name as business_category_name",
            "a.status",
            "a.submitted_at",
          )
          .limit(100);
      const fields = {
        stores: storeFields,
        products: [
          "id",
          "store_id",
          "name",
          "category_id",
          "status",
          "moderation_status",
        ],
        reports: [
          "id",
          "target_type",
          "target_id",
          "category",
          "description",
          "status",
          "resolution",
        ],
      };
      const tables = {
        stores: "stores",
        products: "products",
        reports: "reports",
      };
      return db(tables[kind]).select(fields[kind]).limit(100);
    },
    categories: () =>
      db("categories as c")
        .whereNull("c.deleted_at")
        .select(categoryFields.map((k) => `c.${k}`))
        .select(db.raw(`${categoryUsage("c")} AS usage_count`))
        .orderBy([{ column: "c.sort_order" }, { column: "c.name" }])
        .limit(500),
    async createCategory(ctx, input) {
      return db.transaction(async (t) => {
        await assertCategoryNameFree(t, input.name);
        let slug = slugify(input.name);
        if (await t("categories").where({ slug }).first())
          slug = `${slug}-${randomUUID().slice(0, 8)}`;
        const [row] = await categoryWrite(
          t("categories")
            .insert({ name: input.name, slug })
            .returning(categoryFields),
        );
        await audit(
          t,
          ctx,
          "categories.create",
          "categories",
          row.id,
          null,
          null,
          {
            name: row.name,
            status: row.status,
          },
        );
        return { ...row, usage_count: 0 };
      });
    },
    async updateCategory(ctx, id, input) {
      return db.transaction(async (t) => {
        const before = await t("categories")
          .where({ id })
          .whereNull("deleted_at")
          .forUpdate()
          .first();
        ensure(before, "NOT_FOUND", 404);
        const changes = {};
        if (input.name !== undefined && input.name !== before.name) {
          await assertCategoryNameFree(t, input.name, id);
          changes.name = input.name;
        }
        if (input.status !== undefined && input.status !== before.status)
          changes.status = input.status;
        if (Object.keys(changes).length) {
          await categoryWrite(
            t("categories")
              .where({ id })
              .update({ ...changes, updated_at: t.fn.now() }),
          );
          const prev = pick(before, Object.keys(changes));
          if (changes.status && input.reason)
            await t("moderation_actions").insert({
              target_type: "categories",
              target_id: id,
              action: "review",
              reason: input.reason,
              performed_by: ctx.id,
              previous_state: pick(before, ["status"]),
              new_state: { status: changes.status },
            });
          await audit(
            t,
            ctx,
            "categories.update",
            "categories",
            id,
            input.reason ?? null,
            prev,
            changes,
          );
        }
        return t("categories as c")
          .where("c.id", id)
          .select(categoryFields.map((k) => `c.${k}`))
          .select(t.raw(`${categoryUsage("c")} AS usage_count`))
          .first();
      });
    },
    async deleteCategory(ctx, id) {
      return db.transaction(async (t) => {
        const before = await t("categories as c")
          .where("c.id", id)
          .whereNull("c.deleted_at")
          .forUpdate()
          .select("c.id", "c.name", "c.status")
          .select(t.raw(`${categoryUsage("c")} AS usage_count`))
          .first();
        ensure(before, "NOT_FOUND", 404);
        ensure(before.usage_count === 0, "CATEGORY_IN_USE");
        // Soft delete keeps audit history intact; public queries already exclude deleted_at rows.
        await t("categories")
          .where({ id })
          .update({ deleted_at: t.fn.now(), updated_at: t.fn.now() });
        await audit(
          t,
          ctx,
          "categories.delete",
          "categories",
          id,
          null,
          pick(before, ["name", "status"]),
          { deleted: true },
        );
        return { id, deleted: true };
      });
    },
    async moderate(ctx, kind, id, input) {
      return db.transaction(async (t) => {
        const table = {
          products: "products",
          stores: "stores",
          reports: "reports",
          users: "users",
        }[kind];
        const before = await t(table).where({ id }).forUpdate().first();
        ensure(before, "NOT_FOUND", 404);
        if (kind === "users") {
          const staff = await t("user_roles as ur")
            .join("roles as r", "r.id", "ur.role_id")
            .where("ur.user_id", id)
            .whereNull("ur.revoked_at")
            .whereIn("r.code", ["admin", "super_admin"])
            .first();
          ensure(!staff, "USE_STAFF_ACCESS_ENDPOINT", 403);
        }
        const changes =
          kind === "products"
            ? { moderation_status: input.status }
            : kind === "reports"
              ? {
                  status: input.status,
                  resolution: input.reason,
                  ...(["resolved", "rejected"].includes(input.status)
                    ? { resolved_at: t.fn.now() }
                    : {}),
                }
              : { status: input.status, updated_at: t.fn.now() };
        if (kind === "stores" && input.status === "active")
          ensure(
            before.verification_status === "verified" &&
              (await t("store_addresses")
                .where({ store_id: id, is_primary: true })
                .first()),
            "STORE_NOT_READY",
          );
        await t(table).where({ id }).update(changes);
        if (kind === "users" && input.status !== "active")
          await t("user_sessions")
            .where({ user_id: id })
            .whereNull("revoked_at")
            .update({ revoked_at: t.fn.now() });
        const prev = pick(before, ["status", "moderation_status"]);
        const after = pick(changes, ["status", "moderation_status"]);
        await t("moderation_actions").insert({
          target_type: kind,
          target_id: id,
          action: "review",
          reason: input.reason,
          performed_by: ctx.id,
          previous_state: prev,
          new_state: after,
        });
        await audit(
          t,
          ctx,
          `${kind}.moderate`,
          table,
          id,
          input.reason,
          prev,
          after,
        );
        return { id, ...after };
      });
    },
    async report(userId, input) {
      const [r] = await db("reports")
        .insert({ ...input, reporter_id: userId })
        .returning(["id", "status"]);
      return r;
    },
    feeRules: () =>
      db("platform_fee_rules")
        .select(
          "id",
          "name",
          "percentage",
          "fixed_amount",
          "scope_type",
          "scope_id",
          "effective_from",
          "effective_until",
          "status",
        )
        .orderBy("effective_from", "desc"),
    async fee(ctx, input) {
      return db.transaction(async (t) => {
        const { reason, ...fields } = input;
        if (fields.scope_type !== "global")
          ensure(
            await t(fields.scope_type === "store" ? "stores" : "categories")
              .where({ id: fields.scope_id })
              .first(),
            "INVALID_SCOPE",
            400,
          );
        const [r] = await t("platform_fee_rules")
          .insert({ ...fields, created_by: ctx.id })
          .returning("*");
        await audit(
          t,
          ctx,
          "fee.create",
          "platform_fee_rules",
          r.id,
          reason,
          null,
          pick(r, [
            "name",
            "percentage",
            "fixed_amount",
            "scope_type",
            "scope_id",
            "status",
          ]),
        );
        return pick(r, ["id", "name", "percentage", "fixed_amount", "status"]);
      });
    },
    async disableFee(ctx, id, reason) {
      return db.transaction(async (t) => {
        const r = await t("platform_fee_rules")
          .where({ id })
          .forUpdate()
          .first();
        ensure(r, "NOT_FOUND", 404);
        await t("platform_fee_rules")
          .where({ id })
          .update({ status: "disabled" });
        await audit(
          t,
          ctx,
          "fee.disable",
          "platform_fee_rules",
          id,
          reason,
          { status: r.status },
          { status: "disabled" },
        );
        return { id, status: "disabled" };
      });
    },
    admins: () =>
      db("users as u")
        .join("user_roles as ur", "ur.user_id", "u.id")
        .join("roles as r", "r.id", "ur.role_id")
        .where("r.code", "admin")
        .select(
          "u.id",
          "u.name",
          "u.email",
          "u.status",
          "u.last_login_at",
          "ur.revoked_at",
        )
        .limit(100),
    async createAdmin(ctx, input) {
      return db.transaction(async (t) => {
        const { reason, ...fields } = input;
        const [u] = await t("users")
          .insert({ ...fields, public_id: publicId("WA") })
          .returning(["id", "name", "email"]);
        const role = await t("roles").where({ code: "admin" }).first();
        await t("user_roles").insert({
          user_id: u.id,
          role_id: role.id,
          assigned_by: ctx.id,
        });
        await t("staff_profiles").insert({ user_id: u.id, created_by: ctx.id });
        await audit(t, ctx, "admin.create", "users", u.id, reason, null, {
          role: "admin",
        });
        return u;
      });
    },
    async adminAccess(ctx, id, input) {
      return db.transaction(async (t) => {
        ensure(id !== ctx.id, "CANNOT_CHANGE_OWN_ACCESS", 400);
        const superRole = await t("user_roles as ur")
          .join("roles as r", "r.id", "ur.role_id")
          .where({ "ur.user_id": id, "r.code": "super_admin" })
          .whereNull("ur.revoked_at")
          .first();
        ensure(!superRole, "CANNOT_CHANGE_SUPER_ADMIN", 403);
        const role = await t("roles").where({ code: "admin" }).first();
        const current = await t("user_roles")
          .where({ user_id: id, role_id: role.id })
          .forUpdate()
          .first();
        ensure(current, "NOT_FOUND", 404);
        if (input.action !== "reset")
          await t("user_roles")
            .where({ user_id: id, role_id: role.id })
            .update({
              revoked_at: input.action === "disable" ? t.fn.now() : null,
            });
        await t("user_sessions")
          .where({ user_id: id })
          .update({ revoked_at: t.fn.now() });
        await t("staff_profiles")
          .where({ user_id: id })
          .update({
            status: input.action === "disable" ? "inactive" : "active",
            updated_at: t.fn.now(),
          });
        await audit(
          t,
          ctx,
          `admin.${input.action}`,
          "users",
          id,
          input.reason,
          null,
          { action: input.action },
        );
        return { id };
      });
    },
    audit: () =>
      db("audit_logs")
        .select(
          "id",
          "actor_id",
          "actor_role",
          "action",
          "entity_type",
          "entity_id",
          "reason",
          "before_data",
          "after_data",
          "request_id",
          "created_at",
        )
        .orderBy("created_at", "desc")
        .limit(100),
    buyers: () =>
      db("users as u")
        .join("user_roles as ur", "ur.user_id", "u.id")
        .join("roles as r", "r.id", "ur.role_id")
        .where("r.code", "buyer")
        .whereNull("ur.revoked_at")
        .select("u.id", "u.name", "u.email", "u.status", "u.created_at")
        .limit(100),
    async sellerMetrics(userId) {
      const stores = await db("store_members")
        .where({ user_id: userId, status: "active" })
        .pluck("store_id");
      const rows = await db("orders")
        .whereIn("store_id", stores)
        .select("id", "status", "subtotal");
      const refunded = new Set(
        await db("refunds")
          .whereIn(
            "order_id",
            rows.map((o) => o.id),
          )
          .where({ status: "success" })
          .pluck("order_id"),
      );
      return {
        orders: rows.length,
        completed: rows.filter((o) => o.status === "completed").length,
        gross_sales: rows
          .filter(
            (o) =>
              [
                "confirmed",
                "processing",
                "ready",
                "in_delivery",
                "completed",
              ].includes(o.status) && !refunded.has(o.id),
          )
          .reduce((n, o) => n + money(o.subtotal), 0n)
          .toString(),
      };
    },
    async metrics(financial = false, storeId) {
      const q = db("orders");
      if (storeId) q.where({ store_id: storeId });
      const rows = await q.select(
        "id",
        "status",
        "subtotal",
        "platform_fee",
        "service_fee",
        "buyer_id",
        "store_id",
      );
      const statuses = {};
      for (const row of rows)
        statuses[row.status] = (statuses[row.status] ?? 0) + 1;
      const result = { orders: rows.length, statuses };
      if (financial) {
        const refunded = new Set(
          await db("refunds").where({ status: "success" }).pluck("order_id"),
        );
        const paid = rows.filter(
          (o) =>
            [
              "confirmed",
              "processing",
              "ready",
              "in_delivery",
              "completed",
            ].includes(o.status) && !refunded.has(o.id),
        );
        result.gmv = paid
          .reduce((n, o) => n + money(o.subtotal), 0n)
          .toString();
        result.revenue = paid
          .reduce(
            (n, o) => n + money(o.platform_fee) + money(o.service_fee),
            0n,
          )
          .toString();
        result.transactions = paid.length;
        result.active_buyers = new Set(paid.map((o) => o.buyer_id)).size;
        result.active_stores = new Set(paid.map((o) => o.store_id)).size;
      }
      return result;
    },
  };
}
