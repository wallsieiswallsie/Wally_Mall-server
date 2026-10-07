import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
import { ensure } from "./domain.js";
const scrypt = promisify(scryptCallback);
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  const [, salt, hash] = encoded.split("$");
  if (!salt || !hash) return false;
  const result = await scrypt(password, salt, 64, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  const expected = Buffer.from(hash, "hex");
  return expected.length === result.length && timingSafeEqual(expected, result);
}
export const refreshCredential = () => randomBytes(48).toString("base64url");
export const digest = (token) =>
  createHash("sha256").update(token).digest("hex");
export function signAccess(sessionId, secret) {
  const payload = Buffer.from(
    JSON.stringify({ sid: sessionId, exp: Date.now() + 15 * 60000 }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function verifyAccess(token, secret) {
  const [payload, signature, extra] = String(token).split(".");
  ensure(payload && signature && !extra, "UNAUTHORIZED", 401);
  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  ensure(
    received.length === expected.length && timingSafeEqual(received, expected),
    "UNAUTHORIZED",
    401,
  );
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url"));
  } catch {
    ensure(false, "UNAUTHORIZED", 401);
  }
  ensure(
    typeof data.sid === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        data.sid,
      ) &&
      typeof data.exp === "number" &&
      data.exp > Date.now(),
    "UNAUTHORIZED",
    401,
  );
  return data.sid;
}
