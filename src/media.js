import { randomUUID } from "node:crypto";
import { ensure } from "./domain.js";

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const UPLOAD_SECONDS = 900;
export const mediaTypes = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function validateMedia(input) {
  ensure(
    Object.hasOwn(mediaTypes, input.content_type),
    "UNSUPPORTED_MEDIA_TYPE",
    400,
  );
  ensure(
    Number.isSafeInteger(input.size) && input.size > 0,
    "INVALID_MEDIA_SIZE",
    400,
  );
  ensure(input.size <= MAX_MEDIA_BYTES, "MEDIA_TOO_LARGE", 400);
}

export function buildPublicUrl(bucket, objectKey) {
  ensure(
    /^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(bucket),
    "INVALID_MEDIA_BUCKET",
    400,
  );
  ensure(
    /^products\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(objectKey),
    "INVALID_MEDIA_KEY",
    400,
  );
  return `https://storage.googleapis.com/${bucket}/${objectKey}`;
}

export function assertPermanentMedia(asset) {
  ensure(
    asset.public_url === buildPublicUrl(asset.bucket, asset.object_key),
    "INVALID_MEDIA_URL",
    400,
  );
}

// Storage adapter owns GCS; this service owns authorization and the asset lifecycle.
export function mediaService(db, storage, bucket) {
  async function owned(t, ownerId, id) {
    const asset = await t("media_assets").where({ id }).forUpdate().first();
    ensure(asset, "MEDIA_UPLOAD_NOT_FOUND", 404);
    ensure(asset.owner_id === ownerId, "MEDIA_NOT_OWNED", 403);
    assertPermanentMedia(asset);
    return asset;
  }
  return {
    async createUpload(ownerId, input) {
      validateMedia(input);
      const id = randomUUID();
      const object_key = `products/${ownerId}/${id}.${mediaTypes[input.content_type]}`;
      const asset = {
        id,
        owner_id: ownerId,
        source: input.source,
        purpose: input.purpose,
        bucket,
        object_key,
        public_url: buildPublicUrl(bucket, object_key),
        original_filename: input.filename,
        content_type: input.content_type,
        size_bytes: input.size,
        status: "pending",
        expires_at: new Date(Date.now() + UPLOAD_SECONDS * 1000),
      };
      const signed = await storage.createUpload(asset);
      await db.transaction(async (t) => {
        await t("users").where({ id: ownerId }).forUpdate().first();
        const { count } = await t("media_assets")
          .where({ owner_id: ownerId })
          .whereIn("status", ["pending", "uploaded"])
          .count()
          .first();
        ensure(Number(count) < 30, "MEDIA_UPLOAD_LIMIT", 429);
        await t("media_assets").insert(asset);
      });
      return {
        upload_id: id,
        public_url: asset.public_url,
        expires_in: UPLOAD_SECONDS,
        ...signed,
      };
    },
    async completeUpload(ownerId, id) {
      return db.transaction(async (t) => {
        const asset = await owned(t, ownerId, id);
        ensure(
          ["pending", "uploaded"].includes(asset.status),
          "MEDIA_UPLOAD_INCOMPLETE",
        );
        if (asset.status === "pending")
          ensure(
            new Date(asset.expires_at) > new Date(),
            "MEDIA_UPLOAD_EXPIRED",
          );
        const generation = await storage.verify(asset, true);
        const [result] = await t("media_assets")
          .where({ id })
          .update({
            status: "uploaded",
            generation,
            updated_at: t.fn.now(),
          })
          .returning("*");
        return result;
      });
    },
    async attach(t, ownerId, productId, media) {
      // Stable lock order prevents concurrent attachment/deletion races and deadlocks.
      ensure(
        new Set(media.map((m) => m.media_asset_id)).size === media.length,
        "DUPLICATE_MEDIA",
        400,
      );
      const assets = new Map();
      for (const item of [...media].sort((a, b) =>
        a.media_asset_id.localeCompare(b.media_asset_id),
      )) {
        const asset = await owned(t, ownerId, item.media_asset_id);
        ensure(
          asset.status === "uploaded" && asset.purpose === "product",
          "MEDIA_UPLOAD_INCOMPLETE",
        );
        await storage.verify(asset, false);
        assets.set(asset.id, asset);
      }
      for (const [i, item] of media.entries()) {
        const asset = assets.get(item.media_asset_id);
        await t("product_media").insert({
          product_id: productId,
          media_asset_id: asset.id,
          media_type: "image",
          url: asset.public_url,
          alt_text: item.alt_text,
          sort_order: i,
          is_primary: i === 0,
        });
        await t("media_assets")
          .where({ id: asset.id })
          .update({ status: "attached", updated_at: t.fn.now() });
      }
    },
    async deleteMedia(ownerId, id) {
      return db.transaction(async (t) => {
        const asset = await owned(t, ownerId, id);
        ensure(
          !(await t("product_media").where({ media_asset_id: id }).first()),
          "MEDIA_IN_USE",
        );
        // Wait for the signed PUT to expire before physical deletion, preventing recreation.
        await t("media_assets")
          .where({ id })
          .update({ status: "deleted", updated_at: t.fn.now() });
        return { deleted: true };
      });
    },
    async cleanup() {
      const rows = await db("media_assets")
        .whereNull("purged_at")
        .whereNotExists(
          db("product_media")
            .select(db.raw("1"))
            .whereRaw("product_media.media_asset_id = media_assets.id"),
        )
        .where("expires_at", "<", new Date(Date.now() - 3600_000))
        .where((q) =>
          q
            .where("status", "deleted")
            .orWhere((q) =>
              q
                .whereIn("status", ["pending", "uploaded", "attached"])
                .where("updated_at", "<", new Date(Date.now() - 86400_000)),
            ),
        )
        .orderBy("created_at")
        .limit(100);
      let purged = 0;
      for (const row of rows)
        await db.transaction(async (t) => {
          const asset = await owned(t, row.owner_id, row.id);
          if (
            asset.purged_at ||
            (await t("product_media")
              .where({ media_asset_id: asset.id })
              .first())
          )
            return;
          if (
            asset.status !== "deleted" &&
            new Date(asset.updated_at) > new Date(Date.now() - 86400_000)
          )
            return;
          await storage.deleteMedia(asset);
          await t("media_assets")
            .where({ id: asset.id })
            .update({
              status: "deleted",
              purged_at: t.fn.now(),
              updated_at: t.fn.now(),
            });
          purged++;
        });
      return { purged };
    },
  };
}
