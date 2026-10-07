import { ensure } from "../../src/domain.js";
// All public entry points and purchasability checks share this policy.
export function visibleProducts(db) {
  return db("products as p")
    .join("stores as s", "s.id", "p.store_id")
    .join("categories as c", "c.id", "p.category_id")
    .where({
      "p.status": "active",
      "p.moderation_status": "approved",
      "s.status": "active",
      "s.verification_status": "verified",
      "c.status": "active",
    })
    .whereNull("p.deleted_at")
    .whereNull("s.deleted_at")
    .whereNull("c.deleted_at")
    .whereRaw(
      `NOT EXISTS (WITH RECURSIVE ancestry AS (SELECT id,parent_id,status,deleted_at FROM categories WHERE id = p.category_id UNION SELECT c.id,c.parent_id,c.status,c.deleted_at FROM categories c JOIN ancestry a ON c.id=a.parent_id) SELECT 1 FROM ancestry WHERE status <> 'active' OR deleted_at IS NOT NULL)`,
    )
    .whereExists(
      db("product_variants as v")
        .join("inventories as i", "i.variant_id", "v.id")
        .select(db.raw("1"))
        .whereColumn("v.product_id", "p.id")
        .where("v.status", "active")
        .whereNull("i.store_address_id")
        .whereRaw("i.on_hand > i.reserved"),
    );
}
export async function purchasable(db, variantId) {
  const row = await visibleProducts(db)
    .join("product_variants as v", "v.product_id", "p.id")
    .join("inventories as i", "i.variant_id", "v.id")
    .where("v.id", variantId)
    .where("v.status", "active")
    .whereNull("i.store_address_id")
    .select(
      "p.id as product_id",
      "p.name as product_name",
      "p.store_id",
      "p.category_id",
      "v.id as variant_id",
      "v.name as variant_name",
      "v.sku",
      "v.price",
      "i.id as inventory_id",
      "i.on_hand",
      "i.reserved",
    )
    .first();
  ensure(row, "PRODUCT_UNAVAILABLE", 409);
  return row;
}
export function catalogRepository(db) {
  async function products(filter = {}, userId) {
    const q = visibleProducts(db);
    if (filter.id) q.where("p.id", filter.id);
    if (filter.slug) q.where("p.slug", filter.slug);
    if (filter.store_id) q.where("p.store_id", filter.store_id);
    if (filter.category_id)
      q.whereRaw(
        "p.category_id IN (WITH RECURSIVE sub AS (SELECT id FROM categories WHERE id = ? UNION SELECT c.id FROM categories c JOIN sub ON c.parent_id=sub.id) SELECT id FROM sub)",
        [filter.category_id],
      );
    if (userId)
      q.join("favorites as fav", "fav.product_id", "p.id").where(
        "fav.user_id",
        userId,
      );
    if (filter.city || filter.district)
      q.whereExists(function () {
        this.select(db.raw("1"))
          .from("store_addresses as a")
          .whereColumn("a.store_id", "s.id")
          .where("a.is_primary", true);
        if (filter.city) this.where("a.city", filter.city);
        if (filter.district) this.where("a.district", filter.district);
      });
    if (filter.q) {
      for (const word of filter.q
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .slice(0, 8)) {
        const synonyms = await db("search_synonyms")
          .where({ status: "active" })
          .whereRaw("lower(term)=?", [word])
          .limit(10)
          .pluck("synonym");
        q.where(function () {
          for (const term of [word, ...synonyms]) {
            const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
            this.orWhere(function () {
              this.whereILike("p.name", pattern)
                .orWhereILike("s.name", pattern)
                .orWhereILike("c.name", pattern)
                .orWhereExists(
                  db("product_tags as pt")
                    .join("tags as t", "t.id", "pt.tag_id")
                    .select(db.raw("1"))
                    .whereColumn("pt.product_id", "p.id")
                    .where("t.status", "active")
                    .whereILike("t.name", pattern),
                )
                .orWhereExists(
                  db("product_variants as sv")
                    .select(db.raw("1"))
                    .whereColumn("sv.product_id", "p.id")
                    .where("sv.status", "active")
                    .whereILike("sv.name", pattern),
                );
            });
          }
        });
      }
    }
    // Prices and ratings are derived from actual variants/reviews, never fixture summaries.
    q.select(
      "p.id",
      "p.slug",
      "p.name",
      "p.description",
      "p.condition",
      "p.store_id",
      "p.category_id",
      "p.created_at",
      "s.name as store_name",
      "s.slug as store_slug",
    )
      .select(
        db.raw(
          "(SELECT min(price)::text FROM product_variants WHERE product_id=p.id AND status='active') AS min_price",
        ),
      )
      .select(
        db.raw(
          "(SELECT max(price)::text FROM product_variants WHERE product_id=p.id AND status='active') AS max_price",
        ),
      )
      .select(
        db.raw(
          "(SELECT coalesce(avg(rating),0) FROM reviews WHERE product_id=p.id AND status='active') AS rating_avg",
        ),
      )
      .select(
        db.raw(
          "(SELECT count(*)::int FROM reviews WHERE product_id=p.id AND status='active') AS rating_count",
        ),
      );
    if (filter.min_price)
      q.whereRaw(
        "(SELECT min(price) FROM product_variants WHERE product_id=p.id AND status='active') >= ?",
        [filter.min_price],
      );
    if (filter.max_price)
      q.whereRaw(
        "(SELECT min(price) FROM product_variants WHERE product_id=p.id AND status='active') <= ?",
        [filter.max_price],
      );
    if (filter.rating)
      q.whereRaw(
        "(SELECT coalesce(avg(rating),0) FROM reviews WHERE product_id=p.id AND status='active') >= ?",
        [filter.rating],
      );
    if (filter.sort === "price_asc" || filter.sort === "price_desc")
      q.orderByRaw(
        `(SELECT min(price) FROM product_variants WHERE product_id=p.id AND status='active') ${filter.sort === "price_asc" ? "ASC" : "DESC"}`,
      );
    else q.orderBy("p.created_at", "desc");
    const rows = await q
      .orderBy("p.id")
      .limit(filter.limit ?? 30)
      .offset(filter.offset ?? 0);
    for (const p of rows) {
      p.media = await db("product_media")
        .where({ product_id: p.id })
        .select(
          "id",
          "variant_id",
          "media_type",
          "url",
          "thumbnail_url",
          "alt_text",
          "is_primary",
          "sort_order",
        )
        .orderBy("sort_order");
      p.variants = await db("product_variants as v")
        .leftJoin("inventories as i", function () {
          this.on("i.variant_id", "=", "v.id").onNull("i.store_address_id");
        })
        .where({ "v.product_id": p.id, "v.status": "active" })
        .select("v.id", "v.name", "v.sku", "v.price")
        .select(db.raw("coalesce(i.on_hand-i.reserved,0) as available"));
      p.tags = await db("product_tags as pt")
        .join("tags as t", "t.id", "pt.tag_id")
        .where({ "pt.product_id": p.id, "t.status": "active" })
        .pluck("t.name");
    }
    return rows;
  }
  return {
    products,
    categories: () =>
      db("categories as category")
        .where({ status: "active" })
        .whereNull("deleted_at")
        .whereRaw(
          `NOT EXISTS (WITH RECURSIVE ancestry AS (SELECT id,parent_id,status,deleted_at FROM categories WHERE id=category.id UNION SELECT c.id,c.parent_id,c.status,c.deleted_at FROM categories c JOIN ancestry a ON c.id=a.parent_id) SELECT 1 FROM ancestry WHERE status <> 'active' OR deleted_at IS NOT NULL)`,
        )
        .select(
          "id",
          "parent_id",
          "slug",
          "name",
          "description",
          "icon_url",
          "sort_order",
        )
        .orderBy("sort_order"),
    async stores(filter = {}) {
      const q = db("stores as st")
        .where({ "st.status": "active", "st.verification_status": "verified" })
        .whereNull("st.deleted_at")
        .select(
          "st.id",
          "st.slug",
          "st.name",
          "st.description",
          "st.logo_url",
          "st.banner_url",
          "st.primary_category_id",
        );
      if (filter.slug) q.where("st.slug", filter.slug);
      if (filter.category_id)
        q.where("st.primary_category_id", filter.category_id);
      if (filter.store_id) q.where("st.id", filter.store_id);
      if (filter.city || filter.district)
        q.whereExists(function () {
          this.select(db.raw("1"))
            .from("store_addresses as a")
            .whereColumn("a.store_id", "st.id")
            .where("a.is_primary", true);
          if (filter.city) this.where("a.city", filter.city);
          if (filter.district) this.where("a.district", filter.district);
        });
      if (filter.q)
        for (const word of filter.q.trim().split(/\s+/).slice(0, 8)) {
          const pattern = `%${word.replace(/[\\%_]/g, "\\$&")}%`;
          q.where(function () {
            this.whereILike("st.name", pattern).orWhereExists(
              visibleProducts(db)
                .whereColumn("p.store_id", "st.id")
                .where(function () {
                  this.whereILike("p.name", pattern)
                    .orWhereILike("c.name", pattern)
                    .orWhereExists(
                      db("product_tags as pt")
                        .join("tags as tag", "tag.id", "pt.tag_id")
                        .select(db.raw("1"))
                        .whereColumn("pt.product_id", "p.id")
                        .where("tag.status", "active")
                        .whereILike("tag.name", pattern),
                    );
                })
                .select(db.raw("1")),
            );
          });
        }
      q.select(
        db.raw(
          "(SELECT coalesce(avg(rating),0) FROM reviews WHERE store_id=st.id AND status='active') AS rating_avg",
        ),
        db.raw(
          "(SELECT count(*)::int FROM reviews WHERE store_id=st.id AND status='active') AS rating_count",
        ),
      );
      const rows = await q
        .orderBy("st.id")
        .limit(filter.limit ?? 30)
        .offset(filter.offset ?? 0);
      for (const s of rows)
        s.location =
          (await db("store_addresses")
            .where({ store_id: s.id, is_primary: true })
            .select("province", "city", "district", "subdistrict")
            .first()) ?? null;
      return rows;
    },
    async search(filter) {
      const rows =
        filter.type === "store"
          ? await this.stores(filter)
          : await products(filter);
      await db("search_queries").insert({
        query: filter.q ?? "",
        normalized_query: (filter.q ?? "").trim().toLowerCase(),
        results_count: rows.length,
      });
      return rows;
    },
    async favorite(userId, productId, save) {
      if (!save)
        return db("favorites")
          .where({ user_id: userId, product_id: productId })
          .delete();
      ensure((await products({ id: productId })).length, "NOT_FOUND", 404);
      await db("favorites")
        .insert({ user_id: userId, product_id: productId })
        .onConflict(["user_id", "product_id"])
        .ignore();
    },
    async view(productId) {
      ensure((await products({ id: productId })).length, "NOT_FOUND", 404);
      await db("product_views").insert({
        product_id: productId,
        source: "product_detail",
      });
      return { recorded: true };
    },
  };
}
