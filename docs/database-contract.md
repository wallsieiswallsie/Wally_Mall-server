# Use of the frozen database contract

Executable baseline: [original migration README](../database/migrations/README.md) and its ten migrations. That README refers to `Wally_Mall.sql`; no such SQL file or separate ERD is present. Comparison with the original SQL/ERD is therefore **NOT RUN**. This document explains usage; it does not define another schema or ERD.

| Migration | Existing entities used or retained |
| --- | --- |
| 001_identity | users, roles, user_roles, user_sessions, user_addresses, staff_profiles |
| 002_seller_store | seller_applications, seller_documents, stores, store_members, store_addresses |
| 003_catalog | categories, products, product_variants, product_media, tags, product_tags, search_synonyms, search_queries, product_views, analytics_events |
| 004_inventory | inventories, inventory_movements |
| 005_cart | carts, cart_items, favorites |
| 006_commerce | checkouts, orders, order_items, order_addresses, order_status_history, promotions, promo_codes, promotion_usages |
| 007_payment | payments, payment_events, refunds |
| 008_fulfillment | fulfillments, fulfillment_status_history |
| 009_trust_moderation | reviews, reports, moderation_actions, notifications, notification_reads, audit_logs |
| 010_finance | platform_fee_rules, order_fees, store_bank_accounts, seller_ledger, seller_payouts |

There are 50 application tables and 19 enum types. Existing foreign keys, indexes, uniqueness, checks and ordering are preserved. Knex creates its normal migration bookkeeping tables; these are not a competing business schema.

Identity resolves `users → user_roles → roles`, excluding revoked grants. Sessions use `user_sessions` with hashed refresh credentials, expiry and revocation. A public account never selects its role. Staff provisioning writes `staff_profiles` and an append-only audit entry.

Seller onboarding starts with `seller_applications` and optional `seller_documents`. Approval creates a verified **draft** store plus `store_members` owner and a seller grant. Store activation requires a primary `store_addresses` entry. There is no `stores.owner_user_id`, and membership is rechecked inside writes. The approval audit records the generated store ID; the frozen schema has no direct application-to-store foreign key.

Catalog follows `stores → products → product_variants → inventories`. New products await moderation. Purchasable units are variants, including the default variant of an apparently unvaried product. Discovery derives current min/max price from active variants, media from `product_media`, tags from `product_tags → tags`, and reputation from actual active reviews. A product must have approved moderation, active product/store/category ancestry, verified store and available default inventory. Favorites, search and direct product lookup use the same policy.

Search uses existing name/category/store/variant/tag fields and active `search_synonyms`. Product queries require every token to match a field or its expansion. Search records actual responses in `search_queries`; explicit detail-view requests record `product_views`. No fixture-derived ratings or multiplied funnel counts are returned. No new search tables, extensions or indexes are created. The initial SQL search and batched detail loading need profiling before large-scale operation.

Commerce follows `carts → cart_items.variant_id`; one `checkouts` row owns one `orders` row per participating store. Items, addresses and fees are copied into `order_items`, `order_addresses` and `order_fees`. Historical reads never replace these snapshots with current catalog/address/fee values. All applicable fee rules are resolved from `platform_fee_rules`; persisted `percentage_snapshot` and `fixed_snapshot` preserve applied values.

Transactions lock the buyer/cart and inventory rows. The partial unique active-cart index provides additional protection. The default-location inventory partial unique index guarantees one supported inventory row per variant. Inventory checks enforce `0 <= reserved <= on_hand`; movement checks require nonzero changes. Reserve/release movement before/after values describe reserved quantity; sale before/after values describe on-hand quantity. See the gap report for location allocation limitations.

Payment follows `checkouts → payments → payment_events`. Unique provider-event identity handles replay; payment row locks serialize competing events. A transaction updates payment, checkout, orders, inventory, histories and notifications together. Expiry uses the same reconciliation routine. Fulfillment follows `orders → fulfillments → fulfillment_status_history`; every order transition also writes `order_status_history`. Full-order refunds use `refunds` and change payment state independently of order enums.

Finance uses `platform_fee_rules → order_fees`. `seller_ledger`, `seller_payouts` and encrypted `store_bank_accounts` are retained but not exposed as an invented settlement workflow. No bank account plaintext is accepted or projected. Promotions are retained but not activated without a validated flow.

Moderation uses `reports` and `moderation_actions`; sensitive staff, seller-approval, fee, moderation, refund and manual-cancellation operations append `audit_logs` in the same local transaction. Audit actor/session/request context is generated by the server. Existing triggers reject ordinary audit updates and deletes. No mutation endpoint for audit exists.

Notifications are in-app `notifications` plus owner-scoped `notification_reads`. No email, SMS, push or WhatsApp sender is implied. Reviews remain available as the authoritative reputation source; the current prototype does not submit reviews, so this task adds no review-writing UI/API.
