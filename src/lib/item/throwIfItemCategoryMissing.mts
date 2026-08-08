import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { trusted, Types } from 'mongoose'

/**
 * The category an item is filed under has to exist and still be live.
 *
 * ⚠️ **Nothing enforces this reference.** `item.idCategory` is required and typed, and nothing in
 * the collection validator stops it naming a category that was never created — the same
 * arrangement `company.idShopOwner` has. This is the check, and it runs on every item write.
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
