import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import {
  buildPublicUrl,
  assertPermanentMedia,
  validateMedia,
} from "../src/media.js";
import { gcsStorage, validateImage } from "../src/gcs.js";
import { product } from "../src/validation.js";
import { configFromEnv } from "../src/config.js";

const asset = () => {
  const bucket = "wallymall-media-prod",
    object_key = `products/${randomUUID()}/${randomUUID()}.png`;
  return {
    bucket,
    object_key,
    public_url: buildPublicUrl(bucket, object_key),
    content_type: "image/png",
    size_bytes: 100,
    expires_at: new Date(Date.now() + 900000),
  };
};
test("permanent URLs reject queries, tokens and unsafe paths", () => {
  const a = asset();
  assertPermanentMedia(a);
  assert.ok(
    a.public_url.startsWith(
      "https://storage.googleapis.com/wallymall-media-prod/",
    ),
  );
  for (const query of [
    "?X-Goog-Signature=x",
    "?X-Goog-Expires=900",
    "#fragment",
  ])
    assert.throws(
      () => assertPermanentMedia({ ...a, public_url: a.public_url + query }),
      { code: "INVALID_MEDIA_URL" },
    );
  assert.throws(() => buildPublicUrl(a.bucket, "../../bad.png"));
  assert.throws(
    () => validateMedia({ content_type: "image/svg+xml", size: 20 }),
    { code: "UNSUPPORTED_MEDIA_TYPE" },
  );
  assert.throws(
    () => validateMedia({ content_type: "image/png", size: 5242881 }),
    { code: "MEDIA_TOO_LARGE" },
  );
  assert.throws(() =>
    product.parse({ media: [{ url: a.public_url + "?X-Goog-Signature=x" }] }),
  );
});
test("signed PUT binds size, MIME and create-only precondition; never signs a GET", async () => {
  const a = asset();
  const storage = gcsStorage(
    {},
    {
      client: {
        bucket: (bucket) => {
          assert.equal(bucket, a.bucket);
          return {
            file: (key) => {
              assert.equal(key, a.object_key);
              return {
                getSignedUrl: async (options) => {
                  assert.equal(options.action, "write");
                  assert.equal(options.version, "v4");
                  assert.equal(options.contentType, "image/png");
                  assert.equal(
                    options.extensionHeaders["content-length"],
                    "100",
                  );
                  assert.equal(
                    options.extensionHeaders["x-goog-if-generation-match"],
                    "0",
                  );
                  return ["https://upload.test/?X-Goog-Signature=x"];
                },
              };
            },
          };
        },
      },
    },
  );
  const result = await storage.createUpload(a);
  assert.equal(result.headers["x-goog-if-generation-match"], "0");
  assert.equal(result.headers["content-length"], undefined);
  assertPermanentMedia(a);
});
test("actual image decoding rejects spoofed MIME and corrupt bytes", async () => {
  for (const [format, mime] of [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ]) {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .toFormat(format)
      .toBuffer();
    await validateImage(bytes, mime);
    await assert.rejects(
      validateImage(bytes, mime === "image/png" ? "image/jpeg" : "image/png"),
      { code: "UNSUPPORTED_MEDIA_TYPE" },
    );
  }
  await assert.rejects(
    validateImage(Buffer.from("<script>bad</script>"), "image/png"),
    { code: "UNSUPPORTED_MEDIA_TYPE" },
  );
});
test("GCS verification handles missing, wrong-sized, changed and non-public objects", async () => {
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const a = { ...asset(), size_bytes: bytes.length };
  let missing = true,
    size = bytes.length,
    publicRead = true;
  const storage = gcsStorage(
    {},
    {
      client: {
        bucket: () => ({
          file: () => ({
            getMetadata: async () => {
              if (missing) throw Object.assign(new Error(), { code: 404 });
              return [{ size, contentType: "image/png", generation: "12" }];
            },
            createReadStream: () => Readable.from([bytes]),
          }),
        }),
      },
      fetchImpl: async () => ({ ok: publicRead }),
    },
  );
  await assert.rejects(storage.verify(a, true), {
    code: "MEDIA_OBJECT_NOT_FOUND",
  });
  missing = false;
  size++;
  await assert.rejects(storage.verify(a, true), {
    code: "MEDIA_METADATA_MISMATCH",
  });
  size--;
  publicRead = false;
  await assert.rejects(storage.verify(a, true), { code: "MEDIA_NOT_PUBLIC" });
  publicRead = true;
  assert.equal(await storage.verify(a, true), "12");
  await assert.rejects(storage.verify({ ...a, generation: "11" }, false), {
    code: "MEDIA_OBJECT_CHANGED",
  });
});
test("credential JSON accepts escaped newlines without exposing it to client", () => {
  const config = configFromEnv({
    ACCESS_TOKEN_SECRET: "a".repeat(32),
    PAYMENT_WEBHOOK_SECRET: "b".repeat(32),
    GCP_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "service@example.test",
      private_key: "line1\\nline2",
    }),
  });
  assert.equal(config.gcs.credentials.private_key, "line1\nline2");
  assert.equal(config.gcs.bucket, "wallymall-media-prod");
});
