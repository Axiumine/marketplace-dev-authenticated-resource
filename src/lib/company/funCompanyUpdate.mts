import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { ICompanySchema } from '@axiumine/marketplace-common/models/MongoDBInterfaces/ICompanySchema'
import { Types } from 'mongoose'

/**
 * Everything the owner may change about a company: its fields, minus the ones the server owns.
 *
 * `deleted` is in that list. It is optional on `ICompanySchema`, so leaving it in the Omit would make it
 * a legal member of the update object — a type the `$set` below would happily write, and the one way a
 * retired company could be brought back or a live one retired without going through `companyDel`.
 *
 * `published` is in it for the same shape of reason: publishing a shop is `companyUpdatePublished`, and
 * a whole-object `$set` that carried the flag would make every save of the card decide it — including a
 * save from a form opened before an admin unpublished the shop.
 */
export type ICompanyUpdate = Omit<ICompanySchema, '_id' | 'idShopOwner' | '__v' | 'deleted' | 'published'>

/**
 * Saves a company, scoped to its owner.
 *
 * ⚠️ **Split into `$set` and `$unset` here, not written as one `$set: data`.** `data` comes from
 * `validateCompany`, which hands back every key of `ICompanyUpdate` — including the five optional ones,
 * `undefined` rather than absent when the owner cleared them (see its own header for why). A top-level
 * `$set` only touches the keys the operand names: a value genuinely missing from it leaves whatever the
 * document already held for that path untouched, which is how a cleared `taxCode` used to survive a
 * save. Splitting on `undefined` here is what turns "the key came back empty" into the `$unset` that
 * actually clears it, the same technique `funShopOwnerUpdateStatus` and `funItemCategoryUpdate` use for
 * their own single optional field — this one just has five.
 *
 * `idShopOwner` is in the filter, not in the update. A company cannot change hands by saving its
 * card, and a filter that matched on `_id` alone would let one owner overwrite another's company.
 *
 * `deleted` is not in the filter and does not need to be: `throwIfShopOwnerDontOwnCompany` runs
 * ahead of every call and already refuses a retired company, and the field is outside `ICompanyUpdate`
 * so a `$set`/`$unset` of it cannot clear it either.
 */
export async function funCompanyUpdate(companyId: Types.ObjectId, shopOwnerId: Types.ObjectId, data: ICompanyUpdate) {
	const set: Record<string, unknown> = {}
	const unset: Record<string, 1> = {}

	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) unset[key] = 1
		else set[key] = value
	}

	const ret = await Company.updateOne({ _id: companyId, idShopOwner: shopOwnerId }, { $set: set, $unset: unset }).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
