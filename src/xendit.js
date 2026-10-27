import { timingSafeEqual } from "node:crypto";
import { ensure } from "./domain.js";

// Test mode only until a separately reviewed production rollout. Never accept browser config.
export function xenditConfig(env) {
  const mode = env.XENDIT_MODE ?? "test";
  if (mode !== "test" || !env.XENDIT_SECRET_KEY?.startsWith("xnd_development_"))
    throw new Error("Xendit requires a Test Mode secret key and XENDIT_MODE=test");
  if (!env.XENDIT_CALLBACK_TOKEN || !env.XENDIT_BUSINESS_ID)
    throw new Error("XENDIT_CALLBACK_TOKEN and XENDIT_BUSINESS_ID are required");
  let url;
  try { url = new URL(env.PAYMENT_RETURN_ORIGIN); } catch { /* checked below */ }
  if (!url || url.protocol !== "https:" || url.origin !== env.PAYMENT_RETURN_ORIGIN)
    throw new Error("PAYMENT_RETURN_ORIGIN must be an exact HTTPS buyer origin");
  return { mode, key: env.XENDIT_SECRET_KEY, token: env.XENDIT_CALLBACK_TOKEN,
    businessId: env.XENDIT_BUSINESS_ID, returnOrigin: url.origin };
}

function amount(value) {
  ensure(/^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)), "INVALID_PROVIDER_AMOUNT", 502);
  return Number(value);
}
export function checkoutUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* checked below */ }
  ensure(url && url.protocol === "https:" && !url.username && !url.password && !url.port &&
    ["xen.to", "checkout.xendit.co"].includes(url.hostname), "INVALID_CHECKOUT_URL", 502);
  return url.href;
}
export class XenditPaymentAdapter {
  constructor(config, fetcher = fetch) {
    ensure(config?.mode === "test" && config.key?.startsWith("xnd_development_") &&
      config.token && config.businessId && config.returnOrigin, "XENDIT_TEST_CONFIG_REQUIRED", 500);
    this.provider = "xendit";
    this.config = config;
    this.fetcher = fetcher;
  }
  async request(path, body) {
    let response;
    try {
      response = await this.fetcher(`https://api.xendit.co${path}`, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Basic ${Buffer.from(`${this.config.key}:`).toString("base64")}`,
          "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { ensure(false, "PROVIDER_UNAVAILABLE_RECONCILE_REQUIRED", 502); }
    // Do not log provider responses: they can contain private data or credentials.
    ensure(response.ok, "PROVIDER_REQUEST_FAILED_RECONCILE_REQUIRED", 502);
    try { return await response.json(); } catch { ensure(false, "INVALID_PROVIDER_RESPONSE", 502); }
  }
  session(data, payment) {
    ensure(data?.reference_id === payment.id && data.business_id === this.config.businessId &&
      data.currency === payment.currency && data.currency === "IDR" && amount(data.amount) === amount(payment.amount) &&
      data.session_type === "PAY" && data.mode === "PAYMENT_LINK" &&
      typeof data.payment_session_id === "string" && /^ps-[\w-]+$/.test(data.payment_session_id) &&
      (!payment.provider_reference || payment.provider_reference === data.payment_session_id),
    "PROVIDER_PAYMENT_MISMATCH", 502);
    const status = { ACTIVE: "pending", COMPLETED: "success", EXPIRED: "expired", CANCELED: "failed", CANCELLED: "failed" }[data.status];
    ensure(status, "INVALID_PROVIDER_STATUS", 502);
    if (status === "success") ensure(typeof data.payment_request_id === "string" && data.payment_request_id.startsWith("pr-"), "MISSING_PAYMENT_REQUEST", 502);
    return { provider_reference: data.payment_session_id, status,
      checkout_url: status === "pending" ? checkoutUrl(data.payment_link_url) : null,
      provider_payment_request_id: data.payment_request_id ?? null,
      provider_payment_id: data.payment_id ?? null,
      event_id: `session:${data.payment_session_id}:${data.status}`,
      payment_id: payment.id, amount: String(data.amount), currency: data.currency };
  }
  async createPayment(payment) {
    ensure(payment.currency === "IDR", "UNSUPPORTED_PAYMENT_CURRENCY", 400);
    const returnUrl = `${this.config.returnOrigin}/payment/${encodeURIComponent(payment.id)}`;
    return this.session(await this.request("/sessions", {
      reference_id: payment.id, session_type: "PAY", mode: "PAYMENT_LINK",
      amount: amount(payment.amount), currency: "IDR", country: "ID",
      capture_method: "AUTOMATIC", allow_save_payment_method: "DISABLED",
      expires_at: new Date(payment.expires_at).toISOString(),
      success_return_url: returnUrl, cancel_return_url: returnUrl,
      metadata: { checkout_id: payment.checkout_id },
    }), payment);
  }
  async getPaymentStatus(payment) {
    ensure(/^ps-[\w-]+$/.test(payment.provider_reference ?? ""), "SESSION_RECONCILIATION_REQUIRED");
    return this.session(await this.request(`/sessions/${encodeURIComponent(payment.provider_reference)}`), payment);
  }
  refundResult(data, refund, payment) {
    ensure(data?.reference_id === refund.id && data.payment_request_id === payment.provider_payment_request_id &&
      data.currency === payment.currency && amount(data.amount) === amount(refund.amount) &&
      typeof data.id === "string" && data.id.startsWith("rfd-") &&
      (!refund.provider_reference || data.id === refund.provider_reference), "PROVIDER_REFUND_MISMATCH", 502);
    const status = { SUCCEEDED: "success", FAILED: "failed", CANCELLED: "failed", PENDING: "processing" }[data.status];
    ensure(status, "INVALID_PROVIDER_STATUS", 502);
    return { status, provider_reference: data.id };
  }
  async refund(refund, payment) {
    ensure(payment.provider_payment_request_id, "MISSING_PAYMENT_REQUEST");
    return this.refundResult(await this.request("/refunds", {
      reference_id: refund.id, payment_request_id: payment.provider_payment_request_id,
      amount: amount(refund.amount), currency: payment.currency, reason: "REQUESTED_BY_CUSTOMER",
      metadata: { order_id: refund.order_id },
    }), refund, payment);
  }
  async getRefundStatus(refund, payment) {
    ensure(/^rfd-[\w-]+$/.test(refund.provider_reference ?? ""), "REFUND_RECONCILIATION_REQUIRED");
    return this.refundResult(await this.request(`/refunds/${encodeURIComponent(refund.provider_reference)}`), refund, payment);
  }
  handleWebhook(raw, token) {
    const expected = Buffer.from(this.config.token);
    const actual = Buffer.from(typeof token === "string" ? token : "");
    ensure(actual.length === expected.length && timingSafeEqual(actual, expected), "INVALID_SIGNATURE", 401);
    let event;
    try { event = JSON.parse(raw); } catch { ensure(false, "INVALID_PAYLOAD", 400); }
    ensure(event?.business_id === this.config.businessId && event.data && typeof event.event === "string", "INVALID_PAYLOAD", 400);
    return event;
  }
}
