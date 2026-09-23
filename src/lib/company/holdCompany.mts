import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { ClientSession, trusted, Types } from 'mongoose'

/**
 * ⚠️ **Holds one company still for as long as the item write that names it as a destination takes.**
 * `itemUpdate` re-points an item at a different company by writing its `idCompany`, and
 * `throwIfShopOwnerDontOwnCompany` has already proved that company live and the caller's — outside the
 * transaction, before it opens. Between that check and the commit, the same owner can run `companyDel`
 * on the very company the item is moving into: `funCompanyDelete` stamps `deleted` with no live-reference
 * guard of its own, on the reasoning that nothing references a company any more — the reasoning this
 * write is the exception to. Without this, the item lands on a company that is retired the instant the
 * transaction commits: gone from `shopOwnerCompanyIds`, unreachable by every mutation this service has,
 * with no repair path.
 *
 * ⚠️ **A transaction alone does not close it, which is why this reads with a write.** MongoDB
 * transactions are snapshot-isolated rather than serialisable, and snapshot isolation permits write
 * skew: `companyDel` reads nothing about the item, and this transaction would read the company without
 * writing it — so a delete and a move can each see a consistent snapshot and both commit. `$inc` on
 * `__v` makes this transaction a writer of the very document `funCompanyDelete` writes, so the two
 * collide on it, the server aborts one with a `WriteConflict`, and `withTransaction` retries the loser.
 * Whichever way it falls, the retry sees what the winner left: either the company is gone and the move
 * answers 404, or the company is live and the delete has to wait its turn.
 *
 * `__v` is the field to touch because nothing reads it: mongoose maintains it for `save()` on documents
 * with arrays, this collection is never written that way, and its validator already declares it
 * `bsonType: 'int'`. The projection is `_id` alone — the answer needed is whether the document is there
 * and live, and the rest of the company's card is none of this write's business.
 *
 * `holdItemCategory` is the same technique on the same shape of race, for the sibling rule about an
 * item's category. Changing one without the other reopens a window on the half left behind.
 *
 * 404 rather than 403: `throwIfShopOwnerDontOwnCompany` has already answered 403 for a destination that
 * was never the caller's, so a miss here means the company the pre-flight found went away in the
 * meantime — a race, not a permission the caller lacked.
 */
export async function holdCompany(idCompany: Types.ObjectId, session: ClientSession) {
	const held = await Company.findOneAndUpdate(
		{ _id: idCompany, deleted: trusted({ $exists: false }) },
		{ $inc: { __v: 1 } },
		{ projection: { _id: 1 } }
	)
		.session(session)
		.lean()

	if (held === null) {
		throwNotFoundError()
	}
}
