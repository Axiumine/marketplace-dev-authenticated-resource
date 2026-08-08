import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { IItemSchema } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IItemSchema'
import { shopOwnerCompanyIds } from '@lib/company/shopOwnerCompanyIds.mjs'
import { trusted, Types } from 'mongoose'

/**
 * Everything the owner may change about an item: its fields, minus the ones the server owns.
 *
 * `deleted` is in that list for the reason `ICompanyUpdate` excludes it — it is optional on the
 * schema, so leaving it in would make it a legal member of the update object, and a `$set` of the
 * whole object would then be the one way to retire an item, or revive one, without going through
 * `itemDel`.
 *
 * `idCompany` is **not** excluded, unlike `ICompanyUpdate`'s `idShopOwner`. Moving an item between
 * two shops of the same owner is a real operation — a chain reorganising its catalogue — and the
 * resolver checks the destination the same way it checks the source.
 */
export type IItemUpdate = Omit<IItemSchema, '_id' | '__v' | 'deleted'>

/**
 * Saves an item, scoped to the companies its owner holds.
 *
 * `$set` with the whole object rather than a partial: the input is complete, so a field the owner
 * cleared has to be cleared in the document too.
 *
 * ⚠️ **The `idCompany` clause reads the stored item, not the update.** It is defence in depth of the
 * same kind `funCompanyUpdate`'s `idShopOwner` filter is: `throwIfShopOwnerDontOwnItem` has already
 * run, and this refuses the write a second time if the item moved out from under the session between
 * the guard and here. The destination company in `data` is checked separately by the resolver —
 * a filter cannot check a value it is about to write.
 */
export async function funItemUpdate(itemId: Types.ObjectId, shopOwnerId: Types.ObjectId, data: IItemUpdate) {
	const ret = await Item.updateOne(
		{ _id: itemId, idCompany: trusted({ $in: await shopOwnerCompanyIds(shopOwnerId) }) },
		{ $set: data }
	).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
