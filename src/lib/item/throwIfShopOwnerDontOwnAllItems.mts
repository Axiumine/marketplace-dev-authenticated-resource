import { throwForbiddenError } from '@axiumine/koa-utils/graphQL/throw/throwForbiddenError'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { shopOwnerCompanyIds } from '@lib/company/shopOwnerCompanyIds.mjs'
import { trusted, Types } from 'mongoose'

/**
 * Every item in the list has to hang off a company of the signed-in owner, and all of them have to be live.
 *
 * The bulk form of `throwIfShopOwnerDontOwnItem`, and the same two hops for the same reason: `item`
 * carries no `idShopOwner`, so ownership is only readable through `idCompany`, and a guard that read the
 * items alone would accept any id on the platform.
 *
 * ⚠️ **All or nothing, and never partially.** One id the session does not own refuses the whole call.
 * Two reasons, and both are decisions rather than convenience:
 *
 * - A partial success is unreportable. The mutation answers `Boolean!`, the owner's list is not
 *   re-fetched per item, and "some of them worked" leaves nobody able to say which half landed.
 * - Anything else is an existence oracle. Skipping the ids that did not match and applying the rest
 *   tells the caller, one bulk call at a time, exactly which item ids exist on the platform — the
 *   singular guard's 403 says nothing, and this one must not say more.
 *
 * ⚠️ **The caller has to de-duplicate first.** The count is compared against `itemIds.length`, so a list
 * carrying the same id twice counts one document against two entries and is refused as if it were a
 * stranger's. `itemsUpdatePublished` de-duplicates before calling.
 *
 * `countDocuments` and not a `find`: nothing downstream needs the documents, only whether the set is
 * whole. trusted(): `sanitizeFilter` is on globally, so each `$`-keyed value would otherwise be read as
 * a literal and match nothing.
 */
export async function throwIfShopOwnerDontOwnAllItems(shopOwnerId: Types.ObjectId, itemIds: Types.ObjectId[]) {
	const found = await Item.countDocuments({
		_id: trusted({ $in: itemIds }),
		deleted: trusted({ $exists: false }),
		idCompany: trusted({ $in: await shopOwnerCompanyIds(shopOwnerId) })
	}).lean()

	if (found !== itemIds.length) {
		throw throwForbiddenError()
	}
}
