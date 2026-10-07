import { Storage } from "@google-cloud/storage";
import sharp from "sharp";
import { ensure } from "./domain.js";
import { assertPermanentMedia, MAX_MEDIA_BYTES } from "./media.js";

export async function validateImage(bytes, contentType) {
  const formats = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
  };
  try {
    const image = sharp(bytes, {
      limitInputPixels: 25_000_000,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    ensure(
      metadata.format === formats[contentType] && (metadata.pages ?? 1) === 1,
      "UNSUPPORTED_MEDIA_TYPE",
      400,
    );
    // Decode pixels, not just the header, to reject corrupt/truncated files.
    await image.stats();
  } catch {
    ensure(false, "UNSUPPORTED_MEDIA_TYPE", 400);
  }
}

export function gcsStorage(config = {}, { client, fetchImpl = fetch } = {}) {
  let storage = client;
  function file(asset) {
    assertPermanentMedia(asset);
    storage ??= new Storage({
      projectId: config.projectId,
      credentials: config.credentials,
      retryOptions: { totalTimeout: 30, maxRetries: 2 },
    });
    return storage.bucket(asset.bucket).file(asset.object_key);
  }
  return {
    async createUpload(asset) {
      const headers = {
        "Content-Type": asset.content_type,
        "x-goog-if-generation-match": "0",
      };
      const [upload_url] = await file(asset).getSignedUrl({
        version: "v4",
        action: "write",
        expires: new Date(asset.expires_at),
        contentType: asset.content_type,
        extensionHeaders: {
          "content-length": String(asset.size_bytes),
          "x-goog-if-generation-match": "0",
        },
      });
      // Browsers set Content-Length themselves; it is nevertheless signed and enforced.
      return { upload_url, headers };
    },
    async verify(asset, decode) {
      const object = file(asset);
      let metadata;
      try {
        [metadata] = await object.getMetadata();
      } catch (error) {
        if (Number(error.code) === 404)
          ensure(false, "MEDIA_OBJECT_NOT_FOUND", 409);
        throw error;
      }
      ensure(Number(metadata.size) <= MAX_MEDIA_BYTES, "MEDIA_TOO_LARGE", 400);
      ensure(
        Number(metadata.size) === Number(asset.size_bytes) &&
          metadata.contentType === asset.content_type,
        "MEDIA_METADATA_MISMATCH",
        400,
      );
      ensure(
        !asset.generation || asset.generation === metadata.generation,
        "MEDIA_OBJECT_CHANGED",
      );
      if (decode) {
        const chunks = [];
        let size = 0;
        const stream = storage
          .bucket(asset.bucket)
          .file(asset.object_key, { generation: metadata.generation })
          .createReadStream({
            start: 0,
            end: MAX_MEDIA_BYTES,
            decompress: false,
          });
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > MAX_MEDIA_BYTES) {
            stream.destroy();
            ensure(false, "MEDIA_TOO_LARGE", 400);
          }
          chunks.push(chunk);
        }
        ensure(
          size === Number(asset.size_bytes),
          "MEDIA_METADATA_MISMATCH",
          400,
        );
        await validateImage(Buffer.concat(chunks), asset.content_type);
        const response = await fetchImpl(asset.public_url, {
          method: "HEAD",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        ensure(response.ok, "MEDIA_NOT_PUBLIC", 409);
      }
      return metadata.generation;
    },
    async deleteMedia(asset) {
      await file(asset).delete({
        ignoreNotFound: true,
        ...(asset.generation ? { ifGenerationMatch: asset.generation } : {}),
      });
    },
  };
}
