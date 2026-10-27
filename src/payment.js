import { createHmac, timingSafeEqual } from "node:crypto";
import { ensure } from "./domain.js";
import { XenditPaymentAdapter } from "./xendit.js";
export function validateProvider(provider) {
  if (!["mock", "xendit"].includes(provider)) throw new Error("Unsupported PAYMENT_PROVIDER; use mock or xendit");
  return provider;
}
export function paymentAdapter(config) {
  validateProvider(config.provider);
  if (config.provider === "xendit") return new XenditPaymentAdapter(config.xendit);
  return new MockPaymentAdapter(config.webhook);
}
export class PaymentAdapter {
  async createPayment() {
    throw new Error("Payment provider not configured");
  }
  handleWebhook() {
    throw new Error("Payment provider not configured");
  }
  async getPaymentStatus() {
    throw new Error("Payment provider not configured");
  }
  async refund() {
    throw new Error("Refund provider not configured");
  }
}
// Development only: deterministic provider references; the browser cannot sign events.
export class MockPaymentAdapter extends PaymentAdapter {
  constructor(secret) {
    super();
    this.provider = "mock";
    this.secret = secret;
  }
  async createPayment(payment) {
    return { provider_reference: `mock-${payment.id}`, status: payment.status };
  }
  async getPaymentStatus(payment) {
    return { status: payment.status };
  }
  async refund(refund) {
    return {
      status: "success",
      provider_reference: `mock-refund-${refund.id}`,
    };
  }
  handleWebhook(raw, signature) {
    ensure(
      typeof signature === "string" && /^[a-f0-9]{64}$/.test(signature),
      "INVALID_SIGNATURE",
      401,
    );
    const expected = createHmac("sha256", this.secret).update(raw).digest();
    ensure(
      timingSafeEqual(expected, Buffer.from(signature, "hex")),
      "INVALID_SIGNATURE",
      401,
    );
    try {
      return JSON.parse(raw);
    } catch {
      ensure(false, "INVALID_PAYLOAD", 400);
    }
  }
}
