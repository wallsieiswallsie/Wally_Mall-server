export class AppError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}
export function ensure(condition, code = "CONFLICT", status = 409) {
  if (!condition) throw new AppError(status, code);
}
export function money(value) {
  ensure(/^(0|[1-9]\d*)$/.test(String(value)), "INVALID_MONEY", 400);
  const n = BigInt(value);
  ensure(n <= 9223372036854775807n, "MONEY_OVERFLOW", 400);
  return n;
}
export const pick = (row, keys) =>
  Object.fromEntries(
    keys.filter((k) => row?.[k] !== undefined).map((k) => [k, row[k]]),
  );
export const addressFields = [
  "recipient_name",
  "phone",
  "province",
  "city",
  "district",
  "subdistrict",
  "postal_code",
  "address_line",
  "landmark",
  "latitude",
  "longitude",
  "notes",
];
export function feeAmount(gross, percentage, fixed) {
  const [whole, fraction = ""] = String(percentage).split(".");
  const units = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
  const amount = (money(gross) * units + 500000n) / 1000000n + money(fixed);
  return amount > money(gross) ? money(gross) : amount;
}
export function resolveFee(rules, store, category, now = new Date()) {
  return rules
    .filter(
      (r) =>
        ["active", "scheduled"].includes(r.status) &&
        new Date(r.effective_from) <= now &&
        (!r.effective_until || new Date(r.effective_until) > now) &&
        (r.scope_type === "global" ||
          (r.scope_type === "store" && r.scope_id === store) ||
          (r.scope_type === "category" && r.scope_id === category)),
    )
    .sort(
      (a, b) =>
        ({ store: 3, category: 2, global: 1 })[b.scope_type] -
          { store: 3, category: 2, global: 1 }[a.scope_type] ||
        new Date(b.effective_from) - new Date(a.effective_from) ||
        a.id.localeCompare(b.id),
    )[0];
}
export function displayStatus(order, payment, fulfillment, refund) {
  if (refund?.status === "success") return "refunded";
  if (payment?.status === "failed") return "payment_failed";
  if (order.status === "cancelled" || payment?.status === "expired")
    return "cancelled";
  if (order.status === "awaiting_payment") return "pending_payment";
  if (order.status === "confirmed") return "paid";
  if (order.status === "ready")
    return fulfillment?.type === "pickup"
      ? "ready_for_pickup"
      : "ready_for_delivery";
  return order.status;
}
export function requireRoles(identity, ...roles) {
  ensure(
    identity && roles.some((r) => identity.roles.includes(r)),
    "FORBIDDEN",
    403,
  );
}
export function orderProjection(order, audience) {
  const base = pick(order, [
    "id",
    "order_number",
    "checkout_id",
    "store_id",
    "status",
    "fulfillment_type",
    "created_at",
    "paid_at",
    "completed_at",
  ]);
  if (audience !== "admin")
    Object.assign(
      base,
      pick(order, [
        "subtotal",
        "delivery_fee",
        "service_fee",
        "discount_amount",
        "total_amount",
      ]),
    );
  if (audience === "super_admin")
    Object.assign(
      base,
      pick(order, [
        "buyer_id",
        "platform_fee",
        "gateway_fee",
        "seller_net_amount",
      ]),
    );
  return base;
}
