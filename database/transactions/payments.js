import { ensure, money, requireRoles } from "../../src/domain.js";
import { audit, commerceRepository } from "./commerce.js";
export function paymentRepository(db, adapter) {
  return {
    async createPayment(userId, id) {
      const payment = await db("payments as p")
        .join("checkouts as c", "c.id", "p.checkout_id")
        .where({ "p.id": id, "c.buyer_id": userId })
        .select("p.*")
        .first();
      ensure(payment, "NOT_FOUND", 404);
      ensure(payment.provider === adapter.provider, "PAYMENT_PROVIDER_MISMATCH");
      ensure(payment.status === "pending", "PAYMENT_TERMINAL");
      ensure(new Date(payment.expires_at) > new Date(), "PAYMENT_EXPIRED");
      if (adapter.provider === "xendit") {
        if (payment.provider_reference) {
          await this.reconcilePayment(payment.id);
          const current = await db("payments").where({ id }).first();
          return { id, status: current.status, provider_reference: current.provider_reference,
            checkout_url: current.status === "pending" && new Date(current.expires_at) > new Date() && !current.reconciliation_required ? current.checkout_url : null };
        }
        // Sessions API does not document an idempotency header. Claim once durably BEFORE POST.
        // On timeout/crash, a webhook or operator reconciliation must recover the session.
        const claimed = await db("payments").where({ id, status: "pending" })
          .whereNull("session_requested_at").update({ session_requested_at: db.fn.now(), reconciliation_required: true });
        ensure(claimed === 1, "SESSION_RECONCILIATION_REQUIRED");
      }
      // The local payment ID is the stable merchant reference for each attempt.
      const result = await adapter.createPayment(payment);
      if (adapter.provider === "xendit") {
        await this.applySession(result);
        const current = await db("payments").where({ id }).first();
        return { id, status: current.status, provider_reference: current.provider_reference,
          checkout_url: current.status === "pending" && new Date(current.expires_at) > new Date() && !current.reconciliation_required ? current.checkout_url : null };
      }
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
        ...(result.checkout_url ? { checkout_url: result.checkout_url } : {}),
      };
    },
    async reconcilePayment(id, recoveredSessionId) {
      const payment = await db("payments").where({ id, provider: adapter.provider }).first();
      ensure(payment, "PAYMENT_NOT_FOUND", 404);
      ensure(adapter.provider === "xendit", "UNSUPPORTED_RECONCILIATION");
      ensure(payment.session_requested_at, "SESSION_NOT_REQUESTED");
      const result = await adapter.getPaymentStatus({ ...payment,
        provider_reference: payment.provider_reference || recoveredSessionId });
      return this.applySession(result);
    },
    async applySession(result) {
      // Persist the provider identity under lock before the commerce state transition.
      await db.transaction(async t => {
        const payment = await t("payments").where({ id: result.payment_id, provider: adapter.provider }).forUpdate().first();
        ensure(payment && payment.session_requested_at, "PAYMENT_NOT_FOUND", 404);
        ensure(!payment.provider_reference || payment.provider_reference === result.provider_reference, "PROVIDER_PAYMENT_MISMATCH");
        ensure(!payment.provider_payment_request_id || !result.provider_payment_request_id ||
          payment.provider_payment_request_id === result.provider_payment_request_id, "PROVIDER_PAYMENT_MISMATCH");
        await t("payments").where({ id: payment.id }).update({
          provider_reference: result.provider_reference,
          checkout_url: payment.status === "pending" ? result.checkout_url : null,
          provider_payment_request_id: result.provider_payment_request_id || payment.provider_payment_request_id,
          provider_payment_id: result.provider_payment_id || payment.provider_payment_id,
          ...(result.status === "pending" && payment.status === "pending" && !payment.provider_payment_request_id ? { reconciliation_required: false } : {}),
          updated_at: t.fn.now(),
        });
      });
      if (result.status === "pending") return { status: "pending" };
      return commerceRepository(db, {}).paymentEvent(adapter.provider, result);
    },
    async webhook(event) {
      if (["payment_session.completed", "payment_session.expired"].includes(event.event)) {
        const payment = await db("payments").where({ id: event.data.reference_id, provider: adapter.provider }).first();
        ensure(payment && payment.session_requested_at, "PAYMENT_NOT_FOUND", 404);
        // Authenticated callback is still checked against our stored amount, currency and session.
        const result = adapter.session(event.data, payment);
        ensure((event.event === "payment_session.completed" && result.status === "success") ||
          (event.event === "payment_session.expired" && result.status === "expired"), "INVALID_PAYLOAD", 400);
        return this.applySession(result);
      }
      if (["refund.succeeded", "refund.failed"].includes(event.event)) {
        const refund = await db("refunds").where({ id: event.data.reference_id }).first();
        ensure(refund?.provider_requested_at, "REFUND_NOT_FOUND", 404);
        const payment = await db("payments").where({ id: refund.payment_id, provider: adapter.provider }).first();
        ensure(payment, "PAYMENT_NOT_FOUND", 404);
        const result = adapter.refundResult(event.data, refund, payment);
        ensure((event.event === "refund.succeeded" && result.status === "success") ||
          (event.event === "refund.failed" && result.status === "failed"), "INVALID_PAYLOAD", 400);
        return this.applyRefund({ id: null, roles: [] }, refund, result);
      }
      return { ignored: true };
    },
    async refund(ctx, orderId, reason) {
      requireRoles(ctx, "super_admin");
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
            "cancelled",
          ].includes(order.status),
          "ORDER_NOT_PAID",
        );
        const payment = await t("payments")
          .where({ checkout_id: order.checkout_id })
          .whereIn("status", ["success", "partially_refunded", "refunded", "expired", "failed"])
          .forUpdate()
          .first();
        ensure(payment, "PAYMENT_NOT_PAID");
        ensure(payment.provider === adapter.provider, "PAYMENT_PROVIDER_MISMATCH");
        const latePayment = adapter.provider === "xendit" && payment.reconciliation_required && payment.provider_payment_request_id;
        ensure(["success", "partially_refunded", "refunded"].includes(payment.status) || latePayment, "PAYMENT_NOT_PAID");
        ensure(order.status !== "cancelled" || latePayment || payment.status === "refunded", "ORDER_NOT_PAID");
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
      // A timeout leaves processing. Xendit POST is never retried without a definitive outcome.
      const payment = await db("payments").where({ id: refund.payment_id }).first();
      ensure(payment.provider === adapter.provider, "PAYMENT_PROVIDER_MISMATCH");
      if (adapter.provider === "xendit") {
        const claimed = await db("refunds").where({ id: refund.id, status: "processing" })
          .whereNull("provider_requested_at").update({ provider_requested_at: db.fn.now() });
        if (!claimed) return { id: refund.id, status: refund.status, reconciliation_required: true };
      }
      const result = await adapter.refund(refund, payment);
      return this.applyRefund(ctx, refund, result);
    },
    async applyRefund(ctx, refund, result) {
      return db.transaction(async (t) => {
        const payment = await t("payments").where({ id: refund.payment_id }).forUpdate().first();
        const current = await t("refunds")
          .where({ id: refund.id })
          .forUpdate()
          .first();
        if (["success", "failed"].includes(current.status))
          return { id: current.id, status: current.status, duplicate: true };
        ensure(
          ["success", "failed", "processing"].includes(result.status),
          "INVALID_PROVIDER_RESPONSE",
          502,
        );
        await t("refunds")
          .where({ id: current.id })
          .update({
            status: result.status,
            provider_reference: result.provider_reference,
            processed_at: result.status === "processing" ? null : t.fn.now(),
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
              ...(total === money(payment.amount) ? { reconciliation_required: false } : {}),
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
    async reconcileRefund(ctx, id, recoveredRefundId) {
      requireRoles(ctx, "super_admin");
      ensure(adapter.provider === "xendit", "UNSUPPORTED_RECONCILIATION");
      const refund = await db("refunds").where({ id }).first();
      ensure(refund?.provider_requested_at, "REFUND_NOT_FOUND", 404);
      const payment = await db("payments").where({ id: refund.payment_id, provider: adapter.provider }).first();
      ensure(payment, "PAYMENT_NOT_FOUND", 404);
      const result = await adapter.getRefundStatus({ ...refund,
        provider_reference: refund.provider_reference || recoveredRefundId }, payment);
      return this.applyRefund(ctx, refund, result);
    },
  };
}
