import { randomUUID } from "node:crypto";
import { ensure, pick } from "../../src/domain.js";
export const publicUser = (u) =>
  pick(u, ["id", "public_id", "name", "email", "status", "avatar_url"]);
export function identityRepository(db) {
  async function roles(userId, cx = db) {
    return (
      await cx("user_roles as ur")
        .join("roles as r", "r.id", "ur.role_id")
        .where("ur.user_id", userId)
        .whereNull("ur.revoked_at")
        .select("r.code")
    ).map((r) => r.code);
  }
  return {
    roles,
    findEmail: (email) => db("users").where({ email }).first(),
    async register(input) {
      return db.transaction(async (t) => {
        const [user] = await t("users")
          .insert({
            ...input,
            public_id: `WU-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          })
          .returning("*");
        const role = await t("roles").where({ code: "buyer" }).first();
        ensure(role, "ROLES_NOT_MIGRATED", 503);
        await t("user_roles").insert({ user_id: user.id, role_id: role.id });
        return publicUser(user);
      });
    },
    async createSession(userId, hash, context) {
      return db.transaction(async (t) => {
        const user = await t("users")
          .where({ id: userId, status: "active" })
          .whereNull("deleted_at")
          .forUpdate()
          .first();
        ensure(user, "UNAUTHORIZED", 401);
        const [session] = await t("user_sessions")
          .insert({
            user_id: userId,
            refresh_token_hash: hash,
            expires_at: new Date(Date.now() + 30 * 86400000),
            ip_address: context.ip,
            user_agent: context.userAgent,
          })
          .returning("id");
        await t("users")
          .where({ id: userId })
          .update({ last_login_at: t.fn.now() });
        return session.id;
      });
    },
    async authenticate(sid) {
      const u = await db("user_sessions as s")
        .join("users as u", "u.id", "s.user_id")
        .where("s.id", sid)
        .whereNull("s.revoked_at")
        .where("s.expires_at", ">", new Date())
        .where("u.status", "active")
        .whereNull("u.deleted_at")
        .select("u.*")
        .first();
      ensure(u, "UNAUTHORIZED", 401);
      return { ...publicUser(u), roles: await roles(u.id), sessionId: sid };
    },
    async rotate(oldHash, newHash) {
      return db.transaction(async (t) => {
        const s = await t("user_sessions")
          .where({ refresh_token_hash: oldHash })
          .whereNull("revoked_at")
          .where("expires_at", ">", new Date())
          .forUpdate()
          .first();
        ensure(s, "UNAUTHORIZED", 401);
        const u = await t("users")
          .where({ id: s.user_id, status: "active" })
          .whereNull("deleted_at")
          .first();
        ensure(u, "UNAUTHORIZED", 401);
        await t("user_sessions")
          .where({ id: s.id })
          .update({ refresh_token_hash: newHash });
        return s.id;
      });
    },
    logout: (sid) =>
      db("user_sessions")
        .where({ id: sid })
        .update({ revoked_at: db.fn.now() }),
  };
}
