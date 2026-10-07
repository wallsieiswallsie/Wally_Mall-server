export function configFromEnv(env = process.env) {
  const secret = env.ACCESS_TOKEN_SECRET;
  const webhook = env.PAYMENT_WEBHOOK_SECRET;

  if (!secret || secret.length < 32 || !webhook || webhook.length < 32) {
    throw new Error(
      "Configure ACCESS_TOKEN_SECRET and PAYMENT_WEBHOOK_SECRET with at least 32 characters",
    );
  }

  const provider = env.PAYMENT_PROVIDER ?? "mock";
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

  return {
    secret,
    webhook,
    provider,
    gcs: {
      bucket: env.GCS_BUCKET || "wallymall-media-prod",
      projectId: env.GCP_PROJECT_ID || undefined,
      credentials,
    },

    origins: (env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),

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
