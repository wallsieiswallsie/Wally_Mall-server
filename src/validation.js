import { z } from "zod";
export const id = z.uuid();
export const text = (max = 200) => z.string().trim().min(1).max(max);
export const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((s) => BigInt(s) <= 9223372036854775807n);
export const reason = text(2000);
export const password = z.string().min(12).max(128);
export const email = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());
export const categoryName = text(150).transform((s) => s.replace(/\s+/g, " "));
export const categoryUpdate = z
  .strictObject({
    name: categoryName.optional(),
    status: z.enum(["active", "inactive"]).optional(),
    reason: reason.optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined);
export const address = z.strictObject({
  label: text(50).optional(),
  recipient_name: text(120),
  phone: text(30),
  province: text(120),
  city: text(120),
  district: text(120).optional(),
  subdistrict: text(120).optional(),
  postal_code: text(10).optional(),
  address_line: text(2000),
  landmark: text(500).optional(),
  notes: text(1000).optional(),
  is_default: z.boolean().default(false),
});
export const storeAddress = z.strictObject({
  type: z.enum(["storefront", "warehouse", "pickup"]),
  province: text(120),
  city: text(120),
  district: text(120).optional(),
  subdistrict: text(120).optional(),
  postal_code: text(10).optional(),
  address_line: text(2000),
  landmark: text(500).optional(),
});
export const listing = z.strictObject({
  q: z.string().trim().max(200).optional(),
  type: z.enum(["product", "store"]).optional(),
  category_id: id.optional(),
  store_id: id.optional(),
  city: text(120).optional(),
  district: text(120).optional(),
  min_price: amount.optional(),
  max_price: amount.optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  sort: z
    .enum(["newest", "price_asc", "price_desc", "relevant"])
    .default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});
export const webhookEvent = z.strictObject({
  event_id: text(255),
  payment_id: id,
  status: z.enum(["success", "failed", "expired"]),
  amount,
  currency: z.literal("IDR"),
});
export const checkout = z.strictObject({
  address_id: id,
  fulfillment: z
    .record(id, z.enum(["pickup", "seller_delivery", "wally_local"]))
    .default({}),
  method: z.enum(["qris", "virtual_account", "e_wallet"]),
});
export const product = z.strictObject({
  name: text(100),
  description: text(10000),
  category_id: id,
  condition: z.enum(["new", "used"]),
  variants: z
    .array(
      z.strictObject({
        name: text(150),
        sku: text(100).optional(),
        price: amount,
        on_hand: z.number().int().min(0).max(99999),
      }),
    )
    .min(1)
    .max(50),
  tags: z.array(text(35)).max(10).default([]),
  media: z
    .array(
      z.strictObject({
        media_asset_id: id,
        alt_text: text(255).optional(),
      }),
    )
    .max(10)
    .default([]),
});
export const mediaUpload = z.strictObject({
  filename: text(255),
  content_type: text(100),
  size: z.number().int().positive(),
  purpose: z.literal("product"),
  source: z.enum(["device", "google_drive"]).default("device"),
});
export const fee = z
  .strictObject({
    name: text(150),
    percentage: z
      .string()
      .regex(/^(?:\d{1,2}|100)(?:\.\d{1,4})?$/)
      .refine((s) => Number(s) <= 100),
    fixed_amount: amount,
    scope_type: z.enum(["global", "store", "category"]),
    scope_id: id.nullable().default(null),
    effective_from: z.iso.datetime(),
    effective_until: z.iso.datetime().nullable().default(null),
    status: z.enum(["scheduled", "active"]),
    reason,
  })
  .refine(
    (v) =>
      (v.scope_type === "global" ? v.scope_id === null : v.scope_id !== null) &&
      (!v.effective_until || v.effective_until > v.effective_from),
  );
export const orderQuery = z.strictObject({
  store_id: id.optional(),
  status: z
    .enum([
      "awaiting_payment",
      "confirmed",
      "processing",
      "ready",
      "in_delivery",
      "completed",
      "cancelled",
    ])
    .optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});
export const transactionQuery = orderQuery.extend({
  method: z.enum(["qris", "virtual_account", "e_wallet"]).optional(),
  min_amount: amount.optional(),
  max_amount: amount.optional(),
});
export { z };
