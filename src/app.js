import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { checkConnection } from "../database/index.js";
import {
  identityRepository,
  publicUser,
} from "../database/repositories/identity.js";
import { catalogRepository } from "../database/repositories/catalog.js";
import { accountsRepository } from "../database/repositories/accounts.js";
import { managementRepository } from "../database/repositories/management.js";
import { commerceRepository } from "../database/transactions/commerce.js";
import { paymentRepository } from "../database/transactions/payments.js";
import { ensure, requireRoles } from "./domain.js";
import {
  hashPassword,
  verifyPassword,
  refreshCredential,
  digest,
  signAccess,
  verifyAccess,
} from "./security.js";
import { MockPaymentAdapter } from "./payment.js";
import * as v from "./validation.js";
import { mediaService } from "./media.js";
import { gcsStorage } from "./gcs.js";
const API_PREFIX = "/api/v1";
export async function buildApp({
  db,
  config,
  adapter = new MockPaymentAdapter(config.webhook),
  storage = gcsStorage(config.gcs),
}) {
  const app = Fastify({
    logger: true,
    disableRequestLogging: true,
    bodyLimit: 262144,
    genReqId: () => randomUUID(),
    trustProxy: false,
  });
  const media = mediaService(
    db,
    storage,
    config.gcs?.bucket || "wallymall-media-prod",
  );
  const auth = identityRepository(db),
    catalog = catalogRepository(db),
    accounts = accountsRepository(db),
    management = managementRepository(db, media),
    commerce = commerceRepository(db, config),
    payments = paymentRepository(db, adapter);
  await app.register(cors, {
    origin: (origin, cb) =>
      cb(null, !origin || config.origins.includes(origin)),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("x-request-id", req.id)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store");
    if (req.headers.origin)
      ensure(
        config.origins.includes(req.headers.origin),
        "ORIGIN_NOT_ALLOWED",
        403,
      );
  });
  app.setErrorHandler((error, req, reply) => {
    let status = error.statusCode ?? 500,
      code = error.code ?? "INTERNAL_ERROR";
    if (error instanceof v.z.ZodError) {
      status = 400;
      code = "VALIDATION_ERROR";
    } else if (error.code === "23505") {
      status = 409;
      code = "RESOURCE_CONFLICT";
    } else if (["23503", "23514", "22P02", "22003"].includes(error.code)) {
      status = 400;
      code = "INVALID_RESOURCE";
    } else if (status >= 500) code = "INTERNAL_ERROR";
    if (status >= 500) {
      // Never log raw errors: database messages can include SQL and credentials.
      const diagnosticCode =
        /^(08|22|23|28|40|42|53|54|55|57|58|XX)[A-Z0-9]{3}$/.test(
          error.code ?? "",
        ) ||
        [
          "ECONNREFUSED",
          "ECONNRESET",
          "ETIMEDOUT",
          "ENOTFOUND",
          "EAI_AGAIN",
        ].includes(error.code)
          ? error.code
          : error.name === "KnexTimeoutError"
            ? "DATABASE_TIMEOUT"
            : "INTERNAL_ERROR";
      req.log.error(
        {
          request_id: req.id,
          route: req.routeOptions.url,
          status,
          error_code: diagnosticCode,
        },
        "Request failed",
      );
    }
    reply.code(status).send({ error: { code, request_id: req.id } });
  });
  const ctx = (req) => ({
    ...req.user,
    ip: req.ip,
    userAgent: req.headers["user-agent"]?.slice(0, 1000),
    requestId: req.id,
  });
  const authenticate = async (req) => {
    ensure(
      req.headers.authorization?.startsWith("Bearer "),
      "UNAUTHORIZED",
      401,
    );
    req.user = await auth.authenticate(
      verifyAccess(req.headers.authorization.slice(7), config.secret),
    );
  };
  const route = (method, url, roles, schema, handler) =>
    app.route({
      method,
      url: `${API_PREFIX}${url}`,
      config: url.startsWith("/auth/")
        ? { rateLimit: { max: 20, timeWindow: "1 minute" } }
        : {},
      preHandler:
        roles === null
          ? []
          : [
              authenticate,
              async (req) => {
                if (roles.length) requireRoles(req.user, ...roles);
              },
            ],
      handler: async (req, reply) => {
        if (req.params.id) v.id.parse(req.params.id);
        if (req.params.storeId) v.id.parse(req.params.storeId);
        const data = schema ? schema.parse(req.body) : req.body;
        return { data: await handler(req, data, reply) };
      },
    });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => {
    await checkConnection(db);
    return { status: "ready" };
  });
  // Hash once for timing-consistent unknown-user login attempts.
  const dummy = await hashPassword(randomUUID());
  async function issue(userId, req) {
    const refresh = refreshCredential();
    const sid = await auth.createSession(userId, digest(refresh), ctx(req));
    const identity = await auth.authenticate(sid);
    return {
      access_token: signAccess(sid, config.secret),
      refresh_token: refresh,
      expires_in: 900,
      user: { ...publicUser(identity), roles: identity.roles },
    };
  }
  route(
    "POST",
    "/auth/register",
    null,
    v.z.strictObject({
      name: v.text(120),
      email: v.email,
      password: v.password,
    }),
    async (req, data, reply) => {
      const user = await auth.register({
        name: data.name,
        email: data.email,
        password_hash: await hashPassword(data.password),
      });
      reply.code(201);
      return issue(user.id, req);
    },
  );
  route(
    "POST",
    "/auth/login",
    null,
    v.z.strictObject({ email: v.email, password: v.password }),
    async (req, data) => {
      const user = await auth.findEmail(data.email);
      const valid = await verifyPassword(
        data.password,
        user?.password_hash ?? dummy,
      );
      ensure(
        valid && user?.status === "active" && !user.deleted_at,
        "INVALID_CREDENTIALS",
        401,
      );
      return issue(user.id, req);
    },
  );
  route(
    "POST",
    "/auth/refresh",
    null,
    v.z.strictObject({ refresh_token: v.text(100) }),
    async (req, data) => {
      const refresh = refreshCredential();
      const sid = await auth.rotate(
        digest(data.refresh_token),
        digest(refresh),
      );
      return {
        access_token: signAccess(sid, config.secret),
        refresh_token: refresh,
        expires_in: 900,
      };
    },
  );
  route("POST", "/auth/logout", [], null, async (req) => {
    await auth.logout(req.user.sessionId);
    return { revoked: true };
  });
  route("GET", "/users/me", [], null, (req) => ({
    ...publicUser(req.user),
    roles: req.user.roles,
  }));
  route("GET", "/categories", null, null, () => catalog.categories());
  route("GET", "/products", null, null, (req) =>
    catalog.products(v.listing.parse(req.query)),
  );
  route("GET", "/products/by-slug/:slug", null, null, async (req) => {
    const rows = await catalog.products({
      slug: v.text(200).parse(req.params.slug),
    });
    ensure(rows[0], "NOT_FOUND", 404);
    return rows[0];
  });
  route("GET", "/stores", null, null, (req) =>
    catalog.stores(v.listing.parse(req.query)),
  );
  route("GET", "/stores/by-slug/:slug", null, null, async (req) => {
    const rows = await catalog.stores({
      slug: v.text(200).parse(req.params.slug),
    });
    ensure(rows[0], "NOT_FOUND", 404);
    return rows[0];
  });
  route("GET", "/search", null, null, (req) =>
    catalog.search(v.listing.parse(req.query)),
  );
  route("POST", "/products/:id/view", null, null, (req) =>
    catalog.view(req.params.id),
  );
  route("GET", "/favorites", [], null, (req) =>
    catalog.products(v.listing.parse(req.query), req.user.id),
  );
  route("PUT", "/favorites/:id", [], null, async (req) => {
    await catalog.favorite(req.user.id, req.params.id, true);
    return { saved: true };
  });
  route("DELETE", "/favorites/:id", [], null, async (req) => {
    await catalog.favorite(req.user.id, req.params.id, false);
    return { saved: false };
  });
  route("GET", "/addresses", ["buyer"], null, (req) =>
    accounts.addresses(req.user.id),
  );
  route("POST", "/addresses", ["buyer"], v.address, (req, data) =>
    accounts.saveAddress(req.user.id, data),
  );
  route("PATCH", "/addresses/:id", ["buyer"], v.address, (req, data) =>
    accounts.saveAddress(req.user.id, data, req.params.id),
  );
  route("DELETE", "/addresses/:id", ["buyer"], null, async (req) => {
    await accounts.deleteAddress(req.user.id, req.params.id);
    return { deleted: true };
  });
  route("GET", "/notifications", [], null, (req) =>
    accounts.notifications(req.user.id),
  );
  route("PUT", "/notifications/:id/read", [], null, (req) =>
    accounts.readNotification(req.user.id, req.params.id),
  );
  route("GET", "/cart", ["buyer"], null, (req) => commerce.cart(req.user.id));
  route(
    "POST",
    "/cart/items",
    ["buyer"],
    v.z.strictObject({
      variant_id: v.id,
      quantity: v.z.number().int().min(1).max(99999),
    }),
    (req, data) => commerce.putCart(req.user.id, data),
  );
  route(
    "PATCH",
    "/cart/items/:id",
    ["buyer"],
    v.z.strictObject({ quantity: v.z.number().int().min(0).max(99999) }),
    (req, data) => commerce.putCart(req.user.id, data, req.params.id),
  );
  route("POST", "/checkouts", ["buyer"], v.checkout, (req, data) =>
    commerce.checkout(req.user.id, data),
  );
  route(
    "POST",
    "/cart/quote",
    ["buyer"],
    v.checkout.partial({ address_id: true }),
    (req, data) => commerce.checkout(req.user.id, data, true),
  );
  route("GET", "/checkouts/:id", ["buyer"], null, (req) =>
    accounts.checkout(req.user.id, req.params.id),
  );
  route("GET", "/orders", ["buyer"], null, (req) =>
    commerce.orders(
      req.user,
      "buyer",
      undefined,
      v.orderQuery.parse(req.query),
    ),
  );
  route("GET", "/orders/:id", ["buyer"], null, async (req) => {
    const rows = await commerce.orders(req.user, "buyer", req.params.id);
    ensure(rows[0], "NOT_FOUND", 404);
    return rows[0];
  });
  route("GET", "/payments/:id", ["buyer"], null, (req) =>
    accounts.payment(req.user.id, req.params.id),
  );
  route("POST", "/payments/:id/session", ["buyer"], null, (req) =>
    payments.createPayment(req.user.id, req.params.id),
  );
  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (req, body, done) => done(null, body),
    );
    scope.post(`${API_PREFIX}/payments/webhook/mock`, async (req) => {
      const event = v.webhookEvent.parse(
        adapter.handleWebhook(req.body, req.headers["x-payment-signature"]),
      );
      return { data: await commerce.paymentEvent("mock", event) };
    });
  });
  function trustedMedia(url) {
    ensure(
      config.mediaOrigins.includes(new URL(url).origin),
      "MEDIA_ORIGIN_NOT_ALLOWED",
      400,
    );
  }
  route("POST", "/media/uploads", ["seller"], v.mediaUpload, (req, data) =>
    media.createUpload(req.user.id, data),
  );
  route("POST", "/media/uploads/:id/complete", ["seller"], null, (req) =>
    media.completeUpload(req.user.id, req.params.id),
  );
  route("DELETE", "/media/:id", ["seller"], null, (req) =>
    media.deleteMedia(req.user.id, req.params.id),
  );
  route("GET", "/seller/applications", ["buyer", "seller"], null, (req) =>
    management.applications(req.user.id),
  );
  route(
    "POST",
    "/seller/applications",
    ["buyer", "seller"],
    v.z.strictObject({
      proposed_store_name: v.text(60),
      business_description: v.text(500),
      business_category_id: v.id,
      documents: v.z
        .array(
          v.z.strictObject({ document_type: v.text(50), file_url: v.z.url() }),
        )
        .max(10)
        .default([]),
    }),
    (req, data) => {
      data.documents.forEach((d) => trustedMedia(d.file_url));
      return management.apply(req.user.id, data);
    },
  );
  route("GET", "/seller/stores", ["seller"], null, (req) =>
    management.stores(req.user.id),
  );
  route(
    "PATCH",
    "/seller/stores/:id",
    ["seller"],
    v.z.strictObject({
      name: v.text(150).optional(),
      description: v.text(2000).optional(),
      status: v.z.enum(["draft", "active"]).optional(),
      address: v.storeAddress.optional(),
    }),
    (req, data) => management.updateStore(ctx(req), req.params.id, data),
  );
  route("GET", "/seller/stores/:storeId/products", ["seller"], null, (req) =>
    management.products(req.user.id, req.params.storeId),
  );
  route(
    "POST",
    "/seller/stores/:storeId/products",
    ["seller"],
    v.product,
    (req, data) => {
      return management.createProduct(ctx(req), req.params.storeId, data);
    },
  );
  route(
    "PATCH",
    "/seller/products/:id",
    ["seller"],
    v.z.strictObject({
      name: v.text(100).optional(),
      description: v.text(10000).optional(),
      category_id: v.id.optional(),
      status: v.z.enum(["active", "hidden", "draft"]).optional(),
    }),
    (req, data) => management.updateProduct(ctx(req), req.params.id, data),
  );
  route(
    "PATCH",
    "/seller/variants/:id",
    ["seller"],
    v.z.strictObject({
      name: v.text(150).optional(),
      price: v.amount.optional(),
      status: v.z.enum(["active", "inactive"]).optional(),
      on_hand: v.z.number().int().min(0).max(99999).optional(),
    }),
    (req, data) => management.variant(ctx(req), req.params.id, data),
  );
  route("GET", "/seller/orders", ["seller"], null, (req) =>
    commerce.orders(
      req.user,
      "seller",
      undefined,
      v.orderQuery.parse(req.query),
    ),
  );
  route("GET", "/seller/overview", ["seller"], null, (req) =>
    management.sellerMetrics(req.user.id),
  );
  route(
    "PATCH",
    "/seller/orders/:id/status",
    ["seller"],
    v.z.strictObject({
      status: v.z.enum(["processing", "ready", "in_delivery", "completed"]),
    }),
    (req, data) => commerce.transition(req.user, req.params.id, data.status),
  );
  route(
    "POST",
    "/reports",
    [],
    v.z.strictObject({
      target_type: v.z.enum(["product", "store", "order"]),
      target_id: v.id,
      category: v.text(100),
      description: v.text(4000),
    }),
    (req, data) => management.report(req.user.id, data),
  );
  const ops = ["admin", "super_admin"];
  route("GET", "/admin/orders", ops, null, (req) =>
    commerce.orders(
      req.user,
      "admin",
      undefined,
      v.orderQuery.parse(req.query),
    ),
  );
  route(
    "POST",
    "/admin/orders/:id/cancel",
    ops,
    v.z.strictObject({ reason: v.reason }),
    (req, data) => commerce.cancel(ctx(req), req.params.id, data.reason),
  );
  route("GET", "/admin/overview", ops, null, () => management.metrics(false));
  for (const kind of ["applications", "stores", "products", "reports"])
    route("GET", `/admin/${kind}`, ops, null, () =>
      management.operational(kind),
    );
  route("GET", "/admin/categories", ops, null, () => management.categories());
  route(
    "POST",
    "/admin/categories",
    ops,
    v.z.strictObject({ name: v.categoryName }),
    (req, data, reply) => {
      reply.code(201);
      return management.createCategory(ctx(req), data);
    },
  );
  route("PATCH", "/admin/categories/:id", ops, v.categoryUpdate, (req, data) =>
    management.updateCategory(ctx(req), req.params.id, data),
  );
  route("DELETE", "/admin/categories/:id", ops, null, (req) =>
    management.deleteCategory(ctx(req), req.params.id),
  );
  route(
    "POST",
    "/admin/applications/:id/review",
    ops,
    v.z.strictObject({ approve: v.z.boolean(), reason: v.reason }),
    (req, data) => management.reviewApplication(ctx(req), req.params.id, data),
  );
  for (const [kind, statuses] of Object.entries({
    products: ["approved", "rejected", "pending"],
    stores: ["active", "suspended", "closed"],
    reports: ["reviewing", "resolved", "rejected"],
  }))
    route(
      "PATCH",
      `/admin/${kind}/:id`,
      ops,
      v.z.strictObject({ status: v.z.enum(statuses), reason: v.reason }),
      (req, data) => management.moderate(ctx(req), kind, req.params.id, data),
    );
  const superOnly = ["super_admin"];
  route("GET", "/super-admin/transactions", superOnly, null, (req) =>
    commerce.orders(
      req.user,
      "super_admin",
      undefined,
      v.transactionQuery.parse(req.query),
    ),
  );
  route("GET", "/super-admin/overview", superOnly, null, () =>
    management.metrics(true),
  );
  route("GET", "/super-admin/buyers", superOnly, null, () =>
    management.buyers(),
  );
  route(
    "PATCH",
    "/super-admin/buyers/:id",
    superOnly,
    v.z.strictObject({
      status: v.z.enum(["active", "suspended", "blocked"]),
      reason: v.reason,
    }),
    (req, data) => management.moderate(ctx(req), "users", req.params.id, data),
  );
  route("GET", "/super-admin/admins", superOnly, null, () =>
    management.admins(),
  );
  route(
    "POST",
    "/super-admin/admins",
    superOnly,
    v.z.strictObject({
      name: v.text(120),
      email: v.email,
      password: v.password,
      reason: v.reason,
    }),
    async (req, data) =>
      management.createAdmin(ctx(req), {
        name: data.name,
        email: data.email,
        password_hash: await hashPassword(data.password),
        reason: data.reason,
      }),
  );
  route(
    "PATCH",
    "/super-admin/admins/:id",
    superOnly,
    v.z.strictObject({
      action: v.z.enum(["enable", "disable", "reset"]),
      reason: v.reason,
    }),
    (req, data) => management.adminAccess(ctx(req), req.params.id, data),
  );
  route("GET", "/super-admin/fee-rules", superOnly, null, () =>
    management.feeRules(),
  );
  route("POST", "/super-admin/fee-rules", superOnly, v.fee, (req, data) =>
    management.fee(ctx(req), data),
  );
  route(
    "POST",
    "/super-admin/fee-rules/:id/disable",
    superOnly,
    v.z.strictObject({ reason: v.reason }),
    (req, data) => management.disableFee(ctx(req), req.params.id, data.reason),
  );
  route("GET", "/super-admin/audit", superOnly, null, () => management.audit());
  route(
    "POST",
    "/super-admin/orders/:id/refund",
    superOnly,
    v.z.strictObject({ reason: v.reason }),
    (req, data) => payments.refund(ctx(req), req.params.id, data.reason),
  );
  return app;
}
