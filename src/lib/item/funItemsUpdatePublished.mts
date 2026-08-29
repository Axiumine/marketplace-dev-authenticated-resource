import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { shopOwnerCompanyIds } from '@lib/company/shopOwnerCompanyIds.mjs'
import { trusted, Types } from 'mongoose'

/**
 * Puts a list of the owner's items on the public site, or takes them all off, in one write.
 *
 * The bulk form of `funItemUpdatePublished`, and it exists for one screen: the owner's list is not
 * paged, so "take my whole shop down" is a single intent, and issuing it one item at a time would be one
 * round trip per card with a half-published shop visible in between.
 *
 * ⚠️ **One `updateMany`, not a loop.** The flag is the same value for every item — nothing here is
 * derived per document, unlike the retention scrub on 4024, which needs one write each because it stamps
 * an address built from the `_id`. A single command is also the closest this gets to atomic: the
 * documents are not written under a transaction, but they are written by one server-side operation
 * rather than N racing with whatever else the owner has open.
 *
 * The `idCompany` clause is the defence in depth the singular carries, for the same reason:
 * `throwIfShopOwnerDontOwnAllItems` has already run, and this refuses the write a second time for
 * anything that moved out from under the session in between.
 *
 * `matchedCount`, not `modifiedCount` — publishing what is already published is the state the owner
 * asked for, and a list where half the flags were already right is not an error. It is compared against
 * the id count rather than checked for zero: the guard has just proved every id is the session's, so
 * anything less means the set changed underneath and the owner should be told the call failed.
 */
export async function funItemsUpdatePublished(itemIds: Types.ObjectId[], shopOwnerId: Types.ObjectId, published: boolean) {
	const ret = await Item.updateMany(
		{ _id: trusted({ $in: itemIds }), idCompany: trusted({ $in: await shopOwnerCompanyIds(shopOwnerId) }) },
		{ $set: { published } }
	).exec()

	if (ret.matchedCount !== itemIds.length) {
		throwInternalError()
	}
}
