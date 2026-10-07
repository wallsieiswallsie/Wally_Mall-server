# Database design gaps and boundaries

The schema is unchanged. These are documented limits, not implemented migration proposals.

## Requirement: editable platform settings

**Evidence:** `client/src/pages/internal/Administration.jsx` Settings and `PrototypeContext.action('settings')` save region, city and supportHours.

**Existing database support:** addresses store geographic snapshots; platform_fee_rules stores fees. There is no platform-settings entity.

**Why existing schema cannot represent it:** neither an address nor a fee rule is a platform configuration record. `audit_logs` is append-only history, not an authoritative settings store; overloading it would hide a new model.

**Proposed future schema change:** design a versioned, authorized settings store after explicit approval. Current deployment configuration is read-only environment configuration; no settings mutation endpoint is exposed.

## Requirement: preserve onboarding location before approval

**Evidence:** SellerOnboarding.jsx collects location/address before the completion step.

**Existing database support:** seller_applications stores name, description, category and review lifecycle; seller_documents stores files; store_addresses requires a store. Applications have no address fields or store relation.

**Why existing schema cannot represent it:** creating a store before approval would bypass the selected lifecycle, and embedding address JSON in business_description would invent an undocumented data contract.

**Proposed future schema change:** consider application address fields or a reviewed application-address relation. Current API accepts representable application fields, creates a draft store on approval, then accepts its address before activation. Client adaptation must explicitly explain this additional post-approval step.

## Requirement: inventory allocation across locations

**Evidence:** executable migration 004 allows multiple inventory rows per variant, keyed by optional store_address_id. Checkout must release or commit the same allocated stock reliably.

**Existing database support:** inventories has location; inventory_movements and order_items identify the variant but not the allocated inventory row. A movement reference can identify checkout, but does not independently identify location.

**Why existing schema cannot represent it:** pooled reservation totals alone cannot reconstruct which location an individual order reserved after unrelated checkouts or adjustments. Reusing a free-text field for hidden allocation data would create an implicit schema.

**Proposed future schema change:** review an explicit allocation/location reference if multi-location fulfillment becomes required. The current client has no warehouse selector, so this backend deliberately operates only the existing default-location row and excludes location-only stock from purchasability. It does not create inventory_reservations.

## Missing design artifact (not a schema gap)

The original migration README claims coverage of Wally_Mall.sql, but the supplied module contains only ten JavaScript migrations and README. No SQL/ERD is present anywhere under server at audit time. Executable migration behavior is tested; SQL/ERD parity cannot be verified. Supply the original artifact to complete that comparison; do not generate a competing ERD from the backend.

## Provider/configuration boundaries (not schema gaps)

Production payments, storage/upload ownership, private document access, delivery quotation, real courier data, admin invitation/recovery delivery and distributed rate limiting need provider/configuration decisions. Existing fields can represent their supported data, so no schema is added. Current admin reset revokes sessions, and admin creation takes a securely hashed explicit password; it never pretends an invitation was sent. No bank account or payout workflow is exposed.

The mock gateway does not assess gateway fees, so the persisted gateway fee is zero. Discounts remain zero until the existing promotion lifecycle is connected to a validated product flow. Global buyer-service/delivery policy comes from environment configuration; this is documented deployment behavior, not a new persistent settings model.
