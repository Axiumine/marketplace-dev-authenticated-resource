import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { ClientSession, trusted, Types } from 'mongoose'

/**
 * ⚠️ **Holds one category still for as long as the item write that names it takes.** This is the item
 * half of the rule the operator tier enforces from the other side: `funItemCategoryDelete` on 4024
 * refuses to retire a category while a live item still points at it, and without this the two are a
 * race — that delete counts the items, finds none, and stamps `deleted` while this service is creating
 * the item that would have stopped it. The result is a live item filed under a retired category:
 * resolvable, but under a filter no read path returns, and nothing anywhere says so.
 *
 * ⚠️ **A transaction alone does not close it, which is why this reads with a write.** MongoDB
 * transactions are snapshot-isolated rather than serialisable, and snapshot isolation permits write
 * skew: the delete reads items while this writes one, this reads the category while the delete writes
 * it, and both commit having each seen a consistent snapshot. `$inc` on `__v` makes this transaction a
 * writer of the very document the delete stamps, so the two collide on it, the server aborts one with a
 * `WriteConflict`, that error carries the `TransientTransactionError` label, and `withTransaction`
 * retries the loser. Whichever way it falls the retry sees the taxonomy the winner left: either the
 * category is gone and the item write answers 404, or the item exists and the delete answers "the
 * category still holds items".
 *
 * `__v` is the field to touch because nothing reads it: mongoose maintains it for `save()` on documents
 * with arrays, this collection is never written that way, and its validator already declares it
 * `bsonType: 'int'`. The projection is `_id` alone — the answer needed is whether the document is
 * there, and the category's own fields are none of this service's business.
 *
 * `throwIfParentNotTopLevel` in `marketplace-dev-admin-authenticated-resource` is the same technique on
 * the same collection, for the sibling rule about a subcategory's parent. Changing one without the other
 * reopens a window.
 *
 * 404 rather than 403, for the reason `throwIfItemCategoryMissing` gives: a category is platform-wide
 * public data, so a missing one is a stale client or a typo.
 *
 * ⚠️ **The cost is contention on a document every item write touches.** Two owners stocking the same
 * category at the same instant now serialise on it, one of them retried, and a taxonomy is a small set
 * of documents that a whole marketplace's items point at. It is one extra write per item write and no
 * held lock beyond the transaction, so the queue is short — but it is the reason this is called once,
 * inside the transaction, and not on any read path.
 */
export async function holdItemCategory(idCategory: Types.ObjectId, session: ClientSession) {
	const held = await ItemCategory.findOneAndUpdate(
		{ _id: idCategory, deleted: trusted({ $exists: false }) },
		{ $inc: { __v: 1 } },
		{ projection: { _id: 1 } }
	)
		.session(session)
		.lean()

	if (held === null) {
		throwNotFoundError()
	}
}
