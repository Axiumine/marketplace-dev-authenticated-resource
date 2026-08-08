import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Company } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Company'
import { ICompanySchema } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/ICompanySchema'
import { Types } from 'mongoose'

/**
 * Everything the owner may change about a company: its fields, minus the ones the server owns.
 *
 * `deleted` is in that list. It is optional on `ICompanySchema`, so leaving it in the Omit would make it
 * a legal member of the update object — a type the `$set` below would happily write, and the one way a
 * retired company could be brought back or a live one retired without going through `companyDel`.
 */
export type ICompanyUpdate = Omit<ICompanySchema, '_id' | 'idShopOwner' | '__v' | 'deleted'>

/**
 * Saves a company, scoped to its owner.
 *
 * `$set` with the whole object rather than `updateOne(..., data)`: the input is complete, so a field the
 * owner cleared has to be cleared in the document too, and a bare update would leave the stale value
 * behind for `taxCode` and `uniqueCode` — the two the client may omit.
 *
 * `idShopOwner` is in the filter, not in the update. A company cannot change hands by saving its
 * card, and a filter that matched on `_id` alone would let one owner overwrite another's row.
 *
 * `deleted` is not in the filter and does not need to be: `throwIfShopOwnerDontOwnCompany` runs
 * ahead of every call and already refuses a retired company, and the field is outside `ICompanyUpdate`
 * so a `$set` of the whole object cannot clear it either.
 */
export async function funCompanyUpdate(companyId: Types.ObjectId, shopOwnerId: Types.ObjectId, data: ICompanyUpdate) {
	const ret = await Company.updateOne({ _id: companyId, idShopOwner: shopOwnerId }, { $set: data }).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
