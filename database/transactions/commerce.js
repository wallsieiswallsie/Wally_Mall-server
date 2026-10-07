import { randomUUID } from "node:crypto";
import {
  ensure,
  money,
  feeAmount,
  resolveFee,
  pick,
  addressFields,
  orderProjection,
  displayStatus,
} from "../../src/domain.js";
import { purchasable } from "../repositories/catalog.js";
export const number = (prefix) => `${prefix}-${randomUUID()}`;
export async function audit(t, ctx, action, entity, id, reason, before, after) {
  await t("audit_logs").insert({
    actor_id: ctx.id,
    actor_role: ctx.roles.includes("super_admin")
      ? "super_admin"
      : ctx.roles.includes("admin")
        ? "admin"
        : "seller",
    action,
    entity_type: entity,
    entity_id: id,
    reason,
    before_data: before,
    after_data: after,
    ip_address: ctx.ip,
    user_agent: ctx.userAgent,
    request_id: ctx.requestId,
  });
}
export async function membership(
  t,
  userId,
  storeId,
  roles = ["owner", "manager", "staff"],
) {
  const m = await t("store_members")
    .where({ user_id: userId, store_id: storeId, status: "active" })
    .whereIn("role", roles)
    .forShare()
    .first();
  ensure(m, "NOT_FOUND", 404);
  return m;
}
async function history(t, order, to, ctx, reason) {
  await t("order_status_history").insert({
    order_id: order.id,
    from_status: order.status,
    to_status: to,
    actor_type: ctx?.role ?? "system",
    actor_id: ctx?.id,
    reason,
  });
  await t("orders")
    .where({ id: order.id })
    .update({
      status: to,
      updated_at: t.fn.now(),
      ...(to === "confirmed" ? { paid_at: t.fn.now() } : {}),
      ...(to === "completed" ? { completed_at: t.fn.now() } : {}),
      ...(to === "cancelled" ? { cancelled_at: t.fn.now() } : {}),
    });
}
async function notify(t, userId, reference, title) {
  await t("notifications").insert({
    user_id: userId,
    type: "order",
    title,
    body: title,
    reference_type: "checkout",
    reference_id: reference,
  });
}
async function move(t, inv, type, quantity, reference, actor) {
  const reserve = type === "reserve",
    sale = type === "sale";
  const before = sale ? inv.on_hand : inv.reserved;
  const after = before + (reserve ? quantity : -quantity);
  ensure(
    after >= 0 && (!reserve || after <= inv.on_hand),
    "INVENTORY_CONFLICT",
  );
  await t("inventories")
    .where({ id: inv.id })
    .update(
      sale
        ? {
            on_hand: after,
            reserved: inv.reserved - quantity,
            updated_at: t.fn.now(),
          }
        : { reserved: after, updated_at: t.fn.now() },
    );
  await t("inventory_movements").insert({
    variant_id: inv.variant_id,
    type,
    quantity: reserve ? quantity : -quantity,
    reference_type: "checkout",
    reference_id: reference,
    before_quantity: before,
    after_quantity: after,
    actor_id: actor,
  });
  if (sale) {
    inv.on_hand = after;
    inv.reserved -= quantity;
  } else inv.reserved = after;
}
export function commerceRepository(db, config) {
  async function cartLock(t, userId) {
    await t("users").where({ id: userId }).forUpdate().first();
    let cart = await t("carts")
      .where({ user_id: userId, status: "active" })
      .forUpdate()
      .first();
    if (!cart)
      [cart] = await t("carts").insert({ user_id: userId }).returning("*");
    return cart;
  }
  async function reconcile(t, payment, outcome, event) {
    if (payment.status !== "pending")
      return outcome === "success" &&
        ["failed", "expired"].includes(payment.status)
        ? { reconciliation_required: true }
        : { duplicate: true };
    const checkout = await t("checkouts")
      .where({ id: payment.checkout_id })
      .forUpdate()
      .first();
    ensure(checkout.status === "pending_payment", "CHECKOUT_TERMINAL");
    if (outcome === "success" && new Date(checkout.expires_at) <= new Date())
      return { reconciliation_required: true };
    const orders = await t("orders")
      .where({ checkout_id: checkout.id })
      .orderBy("id")
      .forUpdate();
    const items = await t("order_items").whereIn(
      "order_id",
      orders.map((o) => o.id),
    );
    const inventory = await t("inventories")
      .whereIn(
        "variant_id",
        items.map((i) => i.variant_id),
      )
      .whereNull("store_address_id")
      .orderBy("variant_id")
      .forUpdate();
    for (const item of items) {
      const inv = inventory.find((i) => i.variant_id === item.variant_id);
      ensure(inv, "INVENTORY_MISSING");
      await move(
        t,
        inv,
        outcome === "success" ? "sale" : "release",
        item.quantity,
        checkout.id,
      );
    }
    await t("payments")
      .where({ id: payment.id })
      .update({
        status: outcome,
        updated_at: t.fn.now(),
        ...(outcome === "success" ? { paid_at: t.fn.now() } : {}),
      });
    await t("checkouts")
      .where({ id: checkout.id })
      .update({
        status:
          outcome === "success"
            ? "paid"
            : outcome === "expired"
              ? "expired"
              : "cancelled",
        updated_at: t.fn.now(),
      });
    for (const order of orders) {
      await history(
        t,
        order,
        outcome === "success" ? "confirmed" : "cancelled",
        null,
        `Payment ${outcome}`,
      );
      if (outcome !== "success") {
        const fs = await t("fulfillments")
          .where({ order_id: order.id })
          .forUpdate();
        for (const f of fs) {
          await t("fulfillments")
            .where({ id: f.id })
            .update({ status: "cancelled", updated_at: t.fn.now() });
          await t("fulfillment_status_history").insert({
            fulfillment_id: f.id,
            from_status: f.status,
            to_status: "cancelled",
            notes: `Payment ${outcome}`,
          });
        }
      }
      const members = await t("store_members").where({
        store_id: order.store_id,
        status: "active",
      });
      for (const m of members)
        await notify(
          t,
          m.user_id,
          checkout.id,
          `Order ${order.order_number}: ${outcome}`,
        );
    }
    await notify(t, checkout.buyer_id, checkout.id, `Payment ${outcome}`);
    return { processed: true };
  }
  return {
    async cart(userId) {
      const cart = await db("carts")
        .where({ user_id: userId, status: "active" })
        .first();
      if (!cart) return { items: [] };
      const rows = await db("cart_items")
        .where({ cart_id: cart.id })
        .select("id", "variant_id", "quantity");
      for (const row of rows) {
        try {
          const p = await purchasable(db, row.variant_id);
          Object.assign(row, p, {
            available: p.on_hand - p.reserved,
            subtotal: (money(p.price) * BigInt(row.quantity)).toString(),
          });
        } catch (e) {
          if (!e.statusCode) throw e;
          row.available = 0;
          row.unavailable = true;
        }
      }
      return { id: cart.id, items: rows };
    },
    async putCart(userId, input, itemId) {
      return db.transaction(async (t) => {
        const cart = await cartLock(t, userId);
        const existing = itemId
          ? await t("cart_items")
              .where({ id: itemId, cart_id: cart.id })
              .first()
          : await t("cart_items")
              .where({ cart_id: cart.id, variant_id: input.variant_id })
              .first();
        if (itemId) ensure(existing, "NOT_FOUND", 404);
        if (input.quantity === 0) {
          await t("cart_items").where({ id: existing.id }).delete();
          return { removed: true };
        }
        const p = await purchasable(
          t,
          existing?.variant_id ?? input.variant_id,
        );
        const quantity = itemId
          ? input.quantity
          : (existing?.quantity ?? 0) + input.quantity;
        ensure(quantity <= p.on_hand - p.reserved, "INSUFFICIENT_STOCK");
        const data = {
          cart_id: cart.id,
          variant_id: p.variant_id,
          quantity,
          updated_at: t.fn.now(),
        };
        const [row] = existing
          ? await t("cart_items")
              .where({ id: existing.id })
              .update(data)
              .returning(["id", "variant_id", "quantity"])
          : await t("cart_items")
              .insert(data)
              .returning(["id", "variant_id", "quantity"]);
        return row;
      });
    },
    async checkout(userId, input, quoteOnly = false) {
      return db.transaction(async (t) => {
        const cart = await cartLock(t, userId);
        const items = await t("cart_items")
          .where({ cart_id: cart.id })
          .orderBy("variant_id");
        ensure(items.length, "EMPTY_CART");
        const address = input.address_id
          ? await t("user_addresses")
              .where({ id: input.address_id, user_id: userId })
              .forShare()
              .first()
          : null;
        if (!quoteOnly || input.address_id)
          ensure(address, "ADDRESS_NOT_FOUND", 404);
        const inventory = await t("inventories")
          .whereIn(
            "variant_id",
            items.map((i) => i.variant_id),
          )
          .whereNull("store_address_id")
          .orderBy("variant_id")
          .forUpdate();
        const groups = new Map();
        for (const item of items) {
          const p = await purchasable(t, item.variant_id);
          const inv = inventory.find((i) => i.variant_id === item.variant_id);
          ensure(
            inv && inv.on_hand - inv.reserved >= item.quantity,
            "INSUFFICIENT_STOCK",
          );
          const media = await t("product_media")
            .where({ product_id: p.product_id, is_primary: true })
            .first();
          const line = {
            ...p,
            quantity: item.quantity,
            subtotal: money(p.price) * BigInt(item.quantity),
            image: media?.url,
          };
          if (!groups.has(p.store_id)) groups.set(p.store_id, []);
          groups.get(p.store_id).push(line);
        }
        ensure(
          Object.keys(input.fulfillment).every((id) => groups.has(id)),
          "INVALID_STORE_SELECTION",
          400,
        );
        const rules = await t("platform_fee_rules");
        const checkoutId = randomUUID(),
          expires = new Date(Date.now() + 15 * 60000),
          orders = [];
        let subtotal = 0n,
          deliveryTotal = 0n;
        for (const [storeId, lines] of groups) {
          const type = input.fulfillment[storeId] ?? "pickup";
          const gross = lines.reduce((n, l) => n + l.subtotal, 0n),
            delivery = money(config.delivery[type]);
          const feeGroups = new Map();
          for (const l of lines) {
            const rule = resolveFee(rules, storeId, l.category_id);
            if (rule) {
              const g = feeGroups.get(rule.id) ?? { rule, gross: 0n };
              g.gross += l.subtotal;
              feeGroups.set(rule.id, g);
            }
          }
          const fees = [...feeGroups.values()].map((g) => ({
            ...g,
            amount: feeAmount(g.gross, g.rule.percentage, g.rule.fixed_amount),
          }));
          const fee = fees.reduce((n, f) => n + f.amount, 0n),
            service = orders.length ? 0n : money(config.serviceFee);
          const order = {
            id: randomUUID(),
            order_number: number("WO"),
            checkout_id: checkoutId,
            buyer_id: userId,
            store_id: storeId,
            fulfillment_type: type,
            subtotal: gross.toString(),
            delivery_fee: delivery.toString(),
            service_fee: service.toString(),
            platform_fee: fee.toString(),
            seller_net_amount: (gross - fee).toString(),
            total_amount: money(gross + delivery + service).toString(),
          };
          orders.push({ order, lines, fees });
          subtotal += gross;
          deliveryTotal += delivery;
        }
        if (quoteOnly)
          return {
            subtotal: money(subtotal).toString(),
            delivery_total: deliveryTotal.toString(),
            service_fee_total: config.serviceFee,
            grand_total: money(
              subtotal + deliveryTotal + money(config.serviceFee),
            ).toString(),
            groups: orders.map(({ order }) =>
              pick(order, [
                "store_id",
                "fulfillment_type",
                "subtotal",
                "delivery_fee",
                "service_fee",
                "total_amount",
              ]),
            ),
          };
        const [checkout] = await t("checkouts")
          .insert({
            id: checkoutId,
            checkout_number: number("WC"),
            buyer_id: userId,
            subtotal: money(subtotal).toString(),
            delivery_total: deliveryTotal.toString(),
            service_fee_total: config.serviceFee,
            grand_total: money(
              subtotal + deliveryTotal + money(config.serviceFee),
            ).toString(),
            expires_at: expires,
          })
          .returning("*");
        for (const { order, lines, fees } of orders) {
          await t("orders").insert(order);
          await t("order_status_history").insert({
            order_id: order.id,
            to_status: "awaiting_payment",
            actor_type: "buyer",
            actor_id: userId,
            reason: "Checkout created",
          });
          await t("order_addresses").insert({
            order_id: order.id,
            ...pick(address, addressFields),
          });
          for (const l of lines) {
            await t("order_items").insert({
              order_id: order.id,
              product_id: l.product_id,
              variant_id: l.variant_id,
              product_name: l.product_name,
              variant_name: l.variant_name,
              sku: l.sku,
              unit_price: l.price,
              quantity: l.quantity,
              subtotal: l.subtotal.toString(),
              product_image_url: l.image,
            });
            await move(
              t,
              inventory.find((i) => i.variant_id === l.variant_id),
              "reserve",
              l.quantity,
              checkoutId,
              userId,
            );
          }
          for (const f of fees)
            await t("order_fees").insert({
              order_id: order.id,
              fee_type: "platform",
              rule_id: f.rule.id,
              amount: f.amount.toString(),
              percentage_snapshot: f.rule.percentage,
              fixed_snapshot: f.rule.fixed_amount,
            });
          const [fulfillment] = await t("fulfillments")
            .insert({ order_id: order.id, type: order.fulfillment_type })
            .returning("id");
          await t("fulfillment_status_history").insert({
            fulfillment_id: fulfillment.id,
            to_status: "pending",
            actor_id: userId,
            notes: "Checkout created",
          });
        }
        const [payment] = await t("payments")
          .insert({
            checkout_id: checkoutId,
            provider: config.provider,
            method: input.method,
            amount: checkout.grand_total,
            expires_at: expires,
          })
          .returning(["id", "amount", "currency", "status", "expires_at"]);
        await t("carts")
          .where({ id: cart.id })
          .update({ status: "converted", updated_at: t.fn.now() });
        return {
          id: checkout.id,
          checkout_number: checkout.checkout_number,
          grand_total: checkout.grand_total,
          status: checkout.status,
          orders: orders.map((x) => orderProjection(x.order, "buyer")),
          payment,
        };
      });
    },
    async paymentEvent(provider, event) {
      return db.transaction(async (t) => {
        const payment = await t("payments")
          .where({ id: event.payment_id, provider })
          .forUpdate()
          .first();
        ensure(payment, "PAYMENT_NOT_FOUND", 404);
        ensure(
          payment.amount === event.amount &&
            payment.currency === event.currency,
          "PAYMENT_AMOUNT_MISMATCH",
          400,
        );
        const [inserted] = await t("payment_events")
          .insert({
            payment_id: payment.id,
            provider,
            provider_event_id: event.event_id,
            event_type: event.status,
            payload: event,
            signature_valid: true,
          })
          .onConflict(["provider", "provider_event_id"])
          .ignore()
          .returning("id");
        if (!inserted) return { duplicate: true };
        const result = await reconcile(t, payment, event.status, event);
        if (!result.reconciliation_required)
          await t("payment_events")
            .where({ id: inserted.id })
            .update({ processed_at: t.fn.now() });
        return result;
      });
    },
    async expire() {
      const rows = await db("payments")
        .where({ status: "pending" })
        .where("expires_at", "<=", new Date())
        .select("id");
      let count = 0;
      for (const row of rows)
        await db.transaction(async (t) => {
          const p = await t("payments")
            .where({ id: row.id })
            .forUpdate()
            .first();
          if (p.status === "pending") {
            await reconcile(t, p, "expired");
            count++;
          }
        });
      return { expired: count };
    },
    async cancel(ctx, orderId, reason) {
      return db.transaction(async (t) => {
        const order = await t("orders").where({ id: orderId }).first();
        ensure(order, "NOT_FOUND", 404);
        const payment = await t("payments")
          .where({ checkout_id: order.checkout_id })
          .forUpdate()
          .first();
        ensure(payment?.status === "pending", "PAID_ORDER_REQUIRES_REFUND");
        await reconcile(t, payment, "expired");
        await audit(
          t,
          ctx,
          "order.cancel",
          "orders",
          order.id,
          reason,
          { status: order.status },
          { status: "cancelled" },
        );
        return { cancelled: true };
      });
    },
    async orders(user, audience, id, filter = {}) {
      const q = db("orders");
      if (id) q.where({ id });
      if (audience === "buyer") q.where({ buyer_id: user.id });
      if (audience === "seller")
        q.whereIn(
          "store_id",
          db("store_members")
            .where({ user_id: user.id, status: "active" })
            .select("store_id"),
        );
      if (filter.store_id) q.where({ store_id: filter.store_id });
      if (filter.status) q.where({ status: filter.status });
      if (filter.from)
        q.where("created_at", ">=", new Date(`${filter.from}T00:00:00Z`));
      if (filter.to)
        q.where(
          "created_at",
          "<",
          new Date(new Date(`${filter.to}T00:00:00Z`).getTime() + 86400000),
        );
      if (audience === "super_admin") {
        if (filter.min_amount) q.where("subtotal", ">=", filter.min_amount);
        if (filter.max_amount) q.where("subtotal", "<=", filter.max_amount);
        if (filter.method)
          q.whereIn(
            "checkout_id",
            db("payments")
              .where({ method: filter.method })
              .select("checkout_id"),
          );
      }
      const rows = await q
          .orderBy("created_at", "desc")
          .orderBy("id")
          .limit(filter.limit ?? 100)
          .offset(filter.offset ?? 0),
        result = [];
      for (const o of rows) {
        const p = await db("payments")
            .where({ checkout_id: o.checkout_id })
            .first(),
          f = await db("fulfillments").where({ order_id: o.id }).first(),
          r = await db("refunds")
            .where({ order_id: o.id, status: "success" })
            .first();
        const row = orderProjection(o, audience);
        row.display_status = displayStatus(o, p, f, r);
        if (audience !== "admin")
          row.payment = pick(
            p,
            audience === "super_admin"
              ? [
                  "id",
                  "provider",
                  "provider_reference",
                  "method",
                  "status",
                  "amount",
                  "currency",
                  "paid_at",
                ]
              : ["status", "method"],
          );
        row.items = await db("order_items")
          .where({ order_id: o.id })
          .select(
            ...(audience === "admin"
              ? [
                  "id",
                  "product_name",
                  "variant_name",
                  "quantity",
                  "product_image_url",
                ]
              : [
                  "id",
                  "product_name",
                  "variant_name",
                  "sku",
                  "unit_price",
                  "quantity",
                  "subtotal",
                  "product_image_url",
                ]),
          );
        row.address = await db("order_addresses")
          .where({ order_id: o.id })
          .select(
            ...(audience === "admin" ? ["city", "district"] : addressFields),
          )
          .first();
        row.fulfillment = pick(f, [
          "id",
          "type",
          "status",
          "courier_name",
          "tracking_number",
          "estimated_at",
          "dispatched_at",
          "delivered_at",
          ...(audience === "admin" ? [] : ["pickup_code", "courier_phone"]),
        ]);
        row.timeline = await db("order_status_history")
          .where({ order_id: o.id })
          .select("from_status", "to_status", "created_at")
          .orderBy("created_at");
        result.push(row);
      }
      return result;
    },
    async transition(user, orderId, next) {
      return db.transaction(async (t) => {
        const o = await t("orders").where({ id: orderId }).forUpdate().first();
        ensure(o, "NOT_FOUND", 404);
        await membership(t, user.id, o.store_id);
        const refund = await t("refunds")
          .where({ order_id: o.id })
          .whereIn("status", ["requested", "processing", "success"])
          .first();
        ensure(!refund, "REFUND_IN_PROGRESS");
        const expected = {
          confirmed: "processing",
          processing: "ready",
          ready: o.fulfillment_type === "pickup" ? "completed" : "in_delivery",
          in_delivery: "completed",
        }[o.status];
        ensure(next === expected && expected, "INVALID_TRANSITION");
        const f = await t("fulfillments")
          .where({ order_id: o.id })
          .forUpdate()
          .first();
        ensure(f, "FULFILLMENT_MISSING");
        const to =
          next === "completed"
            ? f.type === "pickup"
              ? "picked_up"
              : "delivered"
            : next;
        await history(
          t,
          o,
          next,
          { id: user.id, role: "seller" },
          "Seller processing",
        );
        await t("fulfillments")
          .where({ id: f.id })
          .update({
            status: to,
            updated_at: t.fn.now(),
            ...(next === "in_delivery" ? { dispatched_at: t.fn.now() } : {}),
            ...(next === "completed" ? { delivered_at: t.fn.now() } : {}),
          });
        await t("fulfillment_status_history").insert({
          fulfillment_id: f.id,
          from_status: f.status,
          to_status: to,
          actor_id: user.id,
          notes: "Seller processing",
        });
        await notify(
          t,
          o.buyer_id,
          o.checkout_id,
          `Order ${o.order_number}: ${next}`,
        );
        return { status: next };
      });
    },
  };
}
