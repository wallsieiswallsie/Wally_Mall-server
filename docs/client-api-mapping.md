# Client to API mapping

Live integration is implemented in `client/src/live/ServerApp.jsx` through `client/src/api/client.js`. The original page names below identify feature counterparts in the isolated prototype. See [current integration coverage, verification and gaps](../../docs/client-server-integration.md).

Prefix: `/api/v1`. All persistence IDs are UUIDs; prototype slugs are only public discovery keys. Requests use strict JSON objects. Money responses are decimal strings, not JS floating-point values. Authenticated routes require `Authorization: Bearer <access_token>`. Roles, user ownership, store ownership, prices and stock never come from client assertions.

| Client source/action | Production endpoint/behavior |
| --- | --- |
| Auth.jsx / login | POST /auth/login `{email,password}`; POST /auth/register `{name,email,password}` creates buyer only |
| PrototypeContext.logout | POST /auth/logout; POST /auth/refresh rotates `{refresh_token}` |
| RequireRole / current identity | GET /users/me; capability checks also execute on every server route |
| Home, Categories | GET /categories, GET /products |
| Search / Listing | GET /search?q=...&type=product or store; optional category_id, store_id, city, district, min_price, max_price, rating, sort, limit, offset |
| ProductDetail | GET /products/by-slug/:slug; POST /products/:id/view records an actual view |
| Store | GET /stores/by-slug/:slug; GET /products?store_id=UUID |
| Favorites / toggleFavorite | GET /favorites; PUT or DELETE /favorites/:productId |
| SellerOnboarding | POST /seller/applications; GET /seller/applications; draft-store access only after approval |
| SellerDashboard | GET /seller/stores, /seller/overview, /seller/orders, /seller/stores/:storeId/products |
| Store details/location | PATCH /seller/stores/:id with allowed fields and optional primary `address` |
| AddProduct | POST /seller/stores/:storeId/products; variants each contain name, string price, on_hand; media and tags are separate collections |
| Product maintenance | PATCH /seller/products/:id; PATCH /seller/variants/:id for price or stock |
| saveAddress | GET/POST /addresses; PATCH/DELETE /addresses/:id (PATCH submits the complete address representation) |
| addToCart | POST /cart/items `{variant_id,quantity}`; same variant increments existing quantity |
| changeQuantity | PATCH /cart/items/:id `{quantity}`; zero removes it |
| estimate | POST /cart/quote `{method,fulfillment}`; optional address_id; server recomputes authoritative totals without reserving stock |
| checkout | POST /checkouts `{address_id,method,fulfillment:{storeUUID:canonicalType}}` |
| Payment page | GET /checkouts/:id; GET /payments/:id; POST /payments/:id/session retrieves provider intent/reference |
| paymentEvent | No browser equivalent. Verified provider calls POST /payments/webhook/mock in development |
| Buyer Orders | GET /orders and /orders/:id; snapshots and projected status |
| Seller updateOrder | PATCH /seller/orders/:id/status `{status}`; active store membership required |
| Notifications | GET /notifications; PUT /notifications/:id/read |
| Operational overview | GET /admin/overview; order counts from actual rows |
| Operational orders/intervention | GET /admin/orders; POST /admin/orders/:id/cancel `{reason}` cancels the entire unpaid checkout and releases stock |
| Seller verification | GET /admin/applications; POST /admin/applications/:id/review `{approve,reason}` |
| Operational People/Operations | GET /admin/stores, /admin/products, /admin/categories, /admin/reports |
| Product/category/store/report action | PATCH /admin/{products,categories,stores,reports}/:id `{status,reason}` |
| Report/support creation | POST /reports `{target_type,target_id,category,description}`; operational support cases use existing reports |
| Financial Transactions/Overview | GET /super-admin/transactions, /super-admin/overview |
| Buyer administration | GET /super-admin/buyers; PATCH /super-admin/buyers/:id `{status,reason}` |
| AdminManagement | GET/POST /super-admin/admins; PATCH /super-admin/admins/:id `{action:enable|disable|reset,reason}` |
| FeeSettings | GET/POST /super-admin/fee-rules; POST /super-admin/fee-rules/:id/disable `{reason}`; revisions create new rules |
| Refund action | POST /super-admin/orders/:id/refund `{reason}`; full-order, provider-mediated, persisted retry |
| AuditLog | GET /super-admin/audit; no update/delete API |
| Settings | Database gap: no mutable region/city/support-hours persistence; no fake settings save endpoint |

Public discovery uses a centralized product policy including category ancestry, moderation, verification and available inventory. Reviews supply real ratings; absent reviews produce zero counts. Related listings use existing category/store filters. Search accepts sort `newest`, `price_asc`, `price_desc`, `relevant` (token matching with stable newest ordering, not fabricated relevance scores). Initial store search supports names and eligible catalog/category/tag text; product search also supports variants and DB synonyms. Store-specific price/rating filters are not implemented; the UI must not apply product-only controls to that tab.

Buyer/seller order responses omit platform fee, gateway fee and seller-net internals. Operational Admin responses additionally omit all money, full buyer identity, contact details and precise address. Super Admin financial projection includes the financial snapshot. Private lists are initially capped at 100; full reporting exports and cursor pagination remain scaling work.

Order lists accept canonical `status`, `store_id`, `from`, `to`, `limit` and `offset`. Date filters are UTC calendar days with an inclusive end date. Super Admin transactions additionally accept `method`, `min_amount` and `max_amount` (goods subtotal). These financial filters are rejected on operational lists.

Example product body:

```json
{"name":"Canvas bag","description":"Locally made bag","category_id":"<category UUID>","condition":"new","variants":[{"name":"Default","price":"85000","on_hand":8}],"tags":["canvas","bag"],"media":[]}
```

URLs in media/documents must match configured origins, and the server does not fetch remote URLs. This is metadata registration, not an upload or proof of asset ownership; private uploads/document review need a selected storage adapter before launch. No contact messaging, invitation email, QRIS payment code, courier tracking or pickup code is fabricated.
