# Recoverable learning

After independent acceptance checks pass, V5 persists COMPLETED and a pending
learning payload before calling the learning engine. A separate private local
outbox preserves that payload across later goals. A learning-store failure does
not change the verified task outcome to BLOCKED.

The owning host drains pending learning on startup and after verified runs.
Delivery uses saved receipts and parameterized tool steps; it makes no model
calls and does not replay tools, browser submissions or other external actions.
Goal/receipt provenance deduplicates repeated deliveries, including a crash
after the procedure save but before acknowledgement. Existing XP receipt
deduplication continues to apply.

The current goal exposes learning.status (pending, saved, or not_learned).
PARTIAL/failed tasks without independent verification are not promoted to
successful procedures. Existing traces/checkpoints still retain their errors.
This cannot retroactively certify an old application from model prose or a
screenshot alone. Model weights are never trained.
