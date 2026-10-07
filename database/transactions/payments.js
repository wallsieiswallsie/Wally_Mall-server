import { ensure, money } from "../../src/domain.js";
import { audit } from "./commerce.js";
export function paymentRepository(db, adapter) {
  return {
    async createPayment(userId, id) {
      const payment = await db("payments as p")
        .join("checkouts as c", "c.id", "p.checkout_id")
        .where({ "p.id": id, "c.buyer_id": userId })
        .select("p.*")
        .first();
      ensure(payment, "NOT_FOUND", 404);
      ensure(payment.status === "pending", "PAYMENT_TERMINAL");
      // Provider must use payment.id as its idempotency key; retries reuse the same intent.
      const result = await adapter.createPayment(payment);
      await db("payments")
        .where({ id, status: "pending" })
        .update({
          provider_reference: result.provider_reference,
          updated_at: db.fn.now(),
        });
      return {
        id,
        provider_reference: result.provider_reference,
        status: payment.status,
      };
    },
    async refund(ctx, orderId, reason) {
      const refund = await db.transaction(async (t) => {
        const order = await t("orders")
          .where({ id: orderId })
          .forUpdate()
          .first();
        ensure(order, "NOT_FOUND", 404);
        ensure(
          [
            "confirmed",
            "processing",
            "ready",
            "in_delivery",
            "completed",
          ].includes(order.status),
          "ORDER_NOT_PAID",
        );
        const payment = await t("payments")
          .where({ checkout_id: order.checkout_id })
          .whereIn("status", ["success", "partially_refunded", "refunded"])
          .forUpdate()
          .first();
        ensure(payment, "PAYMENT_NOT_PAID");
        const existing = await t("refunds")
          .where({ order_id: orderId })
          .whereIn("status", ["requested", "processing", "success"])
          .first();
        if (existing) return existing;
        ensure(payment.status !== "refunded", "PAYMENT_ALREADY_REFUNDED");
        // Full order refund only. No automatic stock return: payment reversal is not physical return.
        const [row] = await t("refunds")
          .insert({
            order_id: orderId,
            payment_id: payment.id,
            amount: order.total_amount,
            reason,
            status: "processing",
            requested_by: ctx.id,
            approved_by: ctx.id,
          })
          .returning("*");
        await audit(t, ctx, "refund.request", "refunds", row.id, reason, null, {
          status: "processing",
          amount: row.amount,
        });
        return row;
      });
      if (refund.status === "success")
        return { id: refund.id, status: "success" };
      // A timeout leaves processing; a retry uses the persisted refund id as idempotency key.
      const result = await adapter.refund(refund);
      return db.transaction(async (t) => {
        const current = await t("refunds")
          .where({ id: refund.id })
          .forUpdate()
          .first();
        if (current.status === "success")
          return { id: current.id, status: "success" };
        ensure(
          ["success", "failed"].includes(result.status),
          "INVALID_PROVIDER_RESPONSE",
          502,
        );
        const payment = await t("payments")
          .where({ id: current.payment_id })
          .forUpdate()
          .first();
        await t("refunds")
          .where({ id: current.id })
          .update({
            status: result.status,
            provider_reference: result.provider_reference,
            processed_at: t.fn.now(),
          });
        if (result.status === "success") {
          const refunds = await t("refunds").where({
            payment_id: payment.id,
            status: "success",
          });
          const total = refunds.reduce((n, r) => n + money(r.amount), 0n);
          ensure(total <= money(payment.amount), "REFUND_EXCEEDS_PAYMENT");
          await t("payments")
            .where({ id: payment.id })
            .update({
              status:
                total === money(payment.amount)
                  ? "refunded"
                  : "partially_refunded",
              updated_at: t.fn.now(),
            });
          const order = await t("orders")
            .where({ id: current.order_id })
            .first();
          await t("notifications").insert({
            user_id: order.buyer_id,
            type: "refund",
            title: "Refund processed",
            body: "Your order refund was processed.",
            reference_type: "order",
            reference_id: order.id,
          });
        }
        await audit(
          t,
          ctx,
          "refund.result",
          "refunds",
          current.id,
          current.reason,
          { status: current.status },
          { status: result.status },
        );
        return { id: current.id, status: result.status };
      });
    },
  };
}
