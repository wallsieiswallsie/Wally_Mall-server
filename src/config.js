import { validateProvider } from "./payment.js";
import { isIP } from "node:net";
export function trustedProxiesFromEnv(env = process.env) {
  const values = (env.TRUSTED_PROXY_CIDRS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  for (const value of values) {
    const [ip, bits, extra] = value.split('/');
    const version = isIP(ip);
    if (!version || extra !== undefined || (bits !== undefined &&
        (!/^\d+$/.test(bits) || Number(bits) < 1 || Number(bits) > (version === 4 ? 32 : 128))))
      throw new Error('TRUSTED_PROXY_CIDRS must contain explicit IP addresses or non-zero CIDRs');
  }
  return values.length ? values : false;
}
export function originsFromEnv(env = process.env) {
  if (env.NODE_ENV === "production" && !env.CORS_ORIGINS?.trim())
    throw new Error("CORS_ORIGINS is required in production");
  const origins = (env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",").map(value => value.trim()).filter(Boolean);
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error("Invalid CORS_ORIGINS"); }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
      throw new Error("CORS_ORIGINS must contain exact HTTP(S) origins without paths or trailing slashes");
  }
  if (env.NODE_ENV === "production" && !origins.length)
    throw new Error("CORS_ORIGINS is required in production");
  return [...new Set(origins)];
}

export function databaseFromEnv(env = process.env) {
  return env.DATABASE_URL;
}

export function seedFromEnv(env = process.env) {
  return { production: env.NODE_ENV === "production", email: env.SEED_SUPER_ADMIN_EMAIL, password: env.SEED_SUPER_ADMIN_PASSWORD };
}

export function bucketFromEnv(env = process.env) {
  if (env.NODE_ENV === "production" && !env.GCS_BUCKET?.trim())
    throw new Error("GCS_BUCKET is required in production");
  return env.GCS_BUCKET || "wallymall-media-prod";
}

export function configFromEnv(env = process.env) {
  const secret = env.ACCESS_TOKEN_SECRET;
  const webhook = env.PAYMENT_WEBHOOK_SECRET;

  if (!secret || secret.length < 32 || !webhook || webhook.length < 32) {
    throw new Error(
      "Configure ACCESS_TOKEN_SECRET and PAYMENT_WEBHOOK_SECRET with at least 32 characters",
    );
  }

  const provider = validateProvider(env.PAYMENT_PROVIDER ?? "mock");
  let credentials;
  if (env.GCP_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(env.GCP_SERVICE_ACCOUNT_JSON);
      if (!credentials.client_email || !credentials.private_key)
        throw new Error();
      credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
    } catch {
      throw new Error("Invalid GCP_SERVICE_ACCOUNT_JSON");
    }
  }

  for (const key of [
    "BUYER_SERVICE_FEE",
    "SELLER_DELIVERY_FEE",
    "WALLY_LOCAL_FEE",
  ]) {
    if (!/^(0|[1-9]\d{0,11})$/.test(env[key] ?? "0")) {
      throw new Error(`Invalid ${key}`);
    }
  }

  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid PORT");
  return {
    listen: { host: env.HOST ?? "0.0.0.0", port },
    secret,
    webhook,
    provider,
    trustedProxies: trustedProxiesFromEnv(env),
    gcs: {
      bucket: bucketFromEnv(env),
      projectId: env.GCP_PROJECT_ID || undefined,
      credentials,
    },

    origins: originsFromEnv(env),

    mediaOrigins: (env.MEDIA_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),

    serviceFee: env.BUYER_SERVICE_FEE ?? "0",

    delivery: {
      pickup: "0",
      seller_delivery: env.SELLER_DELIVERY_FEE ?? "0",
      wally_local: env.WALLY_LOCAL_FEE ?? "0",
    },
  };
}
