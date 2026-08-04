import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { shopOwnerCompanyIds } from '@lib/company/shopOwnerCompanyIds.mjs'
import { Item } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Item'
import { trusted, Types } from 'mongoose'

/**
 * Withdraws an item. A soft delete, like `funCompanyDelete`: the row stays and gains the instant it
 * went. `Date.now()` is a number and the schema path is a `Date` — mongoose casts it.
 *
 * A stamp rather than a removal because the slug index is `{ idCompany, slug }` and stays occupied,
 * which is deliberate: a link that used to be an item should not silently become a different item
 * when the shop reuses the name.
 *
 * No `deleted` clause on the write itself, deliberately — the filter lives on the read paths and on
 * `throwIfShopOwnerDontOwnItem`, which already refuses a withdrawn item before this runs. The
 * `idCompany` clause is the same defence in depth `funItemUpdate` carries.
 */
export async function funItemDelete(itemId: Types.ObjectId, shopOwnerId: Types.ObjectId) {
	const ret = await Item.updateOne(
		{ _id: itemId, idCompany: trusted({ $in: await shopOwnerCompanyIds(shopOwnerId) }) },
		{ $set: { deleted: Date.now() } }
	).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
