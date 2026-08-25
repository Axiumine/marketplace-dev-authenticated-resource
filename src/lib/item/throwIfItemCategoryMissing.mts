import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { trusted, Types } from 'mongoose'

/**
 * The category an item is filed under has to exist and still be live.
 *
 * ⚠️ **Nothing enforces this reference.** `item.idCategory` is required and typed, and nothing in
 * the collection validator stops it naming a category that was never created — the same
 * arrangement `company.idShopOwner` has.
 *
 * ⚠️ **This is no longer the check that holds, and one caller is left.** `holdItemCategory` is the
 * enforcement now: it asks the same question inside the transaction that carries the write, and holds
 * the answer still until that write lands. This one asks it early and cheaply, and `itemAdd` is the only
 * mutation that needs it — the guard sits ahead of `storeItemImage`, which writes a file, hands it to
 * ClamAV and re-encodes it through sharp, and none of that should be spent on a request whose category
 * id is a typo. `itemUpdate` uploads nothing and therefore calls only the holding one.
 *
 * Being a count rather than a write is the point of it: a pre-flight that took the same document lock as
 * `holdItemCategory` would hold the category for the whole length of a virus scan.
 *
 * 404 rather than 403: a category is platform-wide public data, so a missing one is a stale client
 * or a typo, not an owner reaching for something that is not theirs. `throwIfShopOwnerDontOwnCompany`
 * answers 403 for the opposite reason.
 *
 * `deleted` is filtered because a retired category is invisible to every read path: filing a new item
 * under one would produce an item no listing can reach.
 */
export async function throwIfItemCategoryMissing(categoryId: Types.ObjectId) {
	const found = await ItemCategory.countDocuments({
		_id: categoryId,
		deleted: trusted({ $exists: false })
	}).lean()

	if (found === 0) {
		throw throwNotFoundError()
	}
}
