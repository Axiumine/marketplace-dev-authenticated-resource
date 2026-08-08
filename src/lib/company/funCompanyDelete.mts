import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { Types } from 'mongoose'

/**
 * Retires a company. A soft delete: the document stays and gains the instant it was retired.
 * `Date.now()` is a number and the schema path is a `Date` — mongoose casts it.
 *
 * ⚠️ The VAT number stays registered. `vatNumber_unique` and `certifiedEmail_unique` are plain global indexes with no
 * `partialFilterExpression` excluding the retired, so the owner cannot re-register the same company
 * after deleting it — the same trade `shopOwner.login.email_unique` already makes.
 *
 * No `deleted` clause on the write itself, deliberately: the filter lives on the read paths and on
 * `throwIfShopOwnerDontOwnCompany`, which already refuses a retired company before this runs.
 *
 * Used to refuse while a live shop record from the collection removed on 2026-08-04 still pointed at
 * the company, along with the `countDocuments` guard that read it. There
 * is nothing left on the platform that can reference an `company`, so retiring one no longer has a
 * referential check to make.
 */
export async function funCompanyDelete(companyId: Types.ObjectId, shopOwnerId: Types.ObjectId) {
	const ret = await Company.updateOne({ _id: companyId, idShopOwner: shopOwnerId }, { $set: { deleted: Date.now() } }).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
