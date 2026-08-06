import { throwForbiddenError } from '@axiumine/koa-utils/graphQL/throw/throwForbiddenError'
import { shopOwnerCompanyIds } from '@lib/company/shopOwnerCompanyIds.mjs'
import { Item } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Item'
import { trusted, Types } from 'mongoose'

/**
 * The item an owner names has to hang off a company of theirs, and both have to be live.
 *
 * ⚠️ **Two hops, and the second one is the whole point.** `item` carries no `idShopOwner` — ownership
 * is transitive through `idCompany` — so a guard that read only the item would accept any item on the
 * platform whose id the client guessed. `shopOwnerCompanyIds` first, then a count scoped to that set,
 * is one extra round trip that cannot be traded away.
 *
 * The company's own `deleted` is filtered inside `shopOwnerCompanyIds`, for the reason
 * `throwIfShopOwnerDontOwnCompany` filters it: a retired company is gone from every read path, so an
 * item under it is unreachable and acting on it would be acting on a shop that no longer exists.
 *
 * The item's `deleted` clause is what stops a retired item being acted on twice — it is gone from
 * `companyItems`, so the only way to name one is an id the client kept from before, and a second
 * `itemDel` on it answers 403 rather than repeating the stamp.
 *
 * trusted(): `sanitizeFilter` is on globally, so a bare `{ $exists: false }` would be read as a
 * literal value and the query would fail casting it against the `deleted` path.
 */
export async function throwIfShopOwnerDontOwnItem(shopOwnerId: Types.ObjectId, itemId: Types.ObjectId) {
	const found = await Item.countDocuments({
		_id: itemId,
		deleted: trusted({ $exists: false }),
		idCompany: trusted({ $in: await shopOwnerCompanyIds(shopOwnerId) })
	}).lean()

	if (found === 0) {
		throw throwForbiddenError()
	}
}
