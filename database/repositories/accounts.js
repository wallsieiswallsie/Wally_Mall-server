import { ensure, pick, addressFields } from "../../src/domain.js";
export function accountsRepository(db) {
  return {
    addresses: (userId) =>
      db("user_addresses")
        .where({ user_id: userId })
        .select("id", "label", "is_default", ...addressFields)
        .orderBy("created_at"),
    async saveAddress(userId, input, id) {
      return db.transaction(async (t) => {
        await t("users").where({ id: userId }).forUpdate().first();
        if (id)
          ensure(
            await t("user_addresses").where({ id, user_id: userId }).first(),
            "NOT_FOUND",
            404,
          );
        if (input.is_default)
          await t("user_addresses")
            .where({ user_id: userId, is_default: true })
            .update({ is_default: false });
        const q = t("user_addresses");
        const [row] = id
          ? await q
              .where({ id, user_id: userId })
              .update({ ...input, updated_at: t.fn.now() })
              .returning("*")
          : await q.insert({ ...input, user_id: userId }).returning("*");
        return pick(row, ["id", "label", "is_default", ...addressFields]);
      });
    },
    deleteAddress: (userId, id) =>
      db("user_addresses").where({ id, user_id: userId }).delete(),
    notifications: (userId) =>
      db("notifications as n")
        .leftJoin("notification_reads as r", function () {
          this.on("r.notification_id", "=", "n.id").andOn(
            "r.user_id",
            "=",
            "n.user_id",
          );
        })
        .where("n.user_id", userId)
        .select(
          "n.id",
          "n.type",
          "n.title",
          "n.body",
          "n.reference_type",
          "n.reference_id",
          "n.created_at",
          "r.read_at",
        )
        .orderBy("n.created_at", "desc")
        .limit(100),
    async readNotification(userId, id) {
      ensure(
        await db("notifications").where({ id, user_id: userId }).first(),
        "NOT_FOUND",
        404,
      );
      await db("notification_reads")
        .insert({ notification_id: id, user_id: userId })
        .onConflict(["notification_id", "user_id"])
        .ignore();
      return { read: true };
    },
    async checkout(userId, id) {
      const row = await db("checkouts").where({ id, buyer_id: userId }).first();
      ensure(row, "NOT_FOUND", 404);
      return pick(row, [
        "id",
        "checkout_number",
        "status",
        "subtotal",
        "delivery_total",
        "service_fee_total",
        "discount_total",
        "grand_total",
        "currency",
        "expires_at",
      ]);
    },
    async payment(userId, id) {
      const row = await db("payments as p")
        .join("checkouts as c", "c.id", "p.checkout_id")
        .where({ "p.id": id, "c.buyer_id": userId })
        .select(
          "p.id",
          "p.checkout_id",
          "p.provider",
          "p.method",
          "p.amount",
          "p.currency",
          "p.status",
          "p.expires_at",
        )
        .first();
      ensure(row, "NOT_FOUND", 404);
      return row;
    },
  };
}
