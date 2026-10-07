# Status projection

Database enums remain unchanged. The API returns database `status`, plus `display_status` on order views. Client integration must render the latter as its existing label while sending canonical transition values.

| Client display | Existing state combination |
| --- | --- |
| pending_payment | order awaiting_payment, pending payment |
| paid | order confirmed, successful payment |
| processing | order processing |
| ready_for_pickup | order ready, fulfillment type pickup |
| ready_for_delivery | order ready, fulfillment type seller_delivery or wally_local |
| in_delivery | order in_delivery |
| completed | order completed; fulfillment picked_up for pickup, delivered for delivery |
| payment_failed | payment failed |
| cancelled | cancelled order or expired payment |
| refunded | a successful refund for this particular order |

Projection precedence: successful order refund, payment failure, cancellation/expiry, then order/fulfillment display mapping. Payment `partially_refunded` is checkout-wide and does not imply that every sibling order was refunded. A refund leaves the operational order enum intact; seller transitions are blocked while its refund is requested, processing or successful.

Seller transition API accepts `processing → ready → completed` for pickup and `processing → ready → in_delivery → completed` for delivery, starting from `confirmed`. Skips and seller payment/refund transitions are rejected. Fulfillment history records pending, processing, ready, then picked_up or in_delivery/delivered as appropriate. It is normal for a confirmed order to retain pending fulfillment until a seller begins work.

Client fulfillment values map at integration: `local → wally_local`, `seller → seller_delivery`, `pickup → pickup`. API request validation accepts only database names. Payment methods similarly use `qris`, `virtual_account`, `e_wallet` in requests rather than UI labels.

Other display mappings: client product “removed” maps to rejected moderation/hidden visibility rather than a new enum; category “hidden” maps to inactive; buyer “review” is an operational review action, not a user status. Seller “review” belongs to application under_review, not store status. Activation cannot override verification or suspension restrictions. Admin “inactive” revokes its admin grant/staff access rather than adding a users enum.
