import { throwForbiddenError } from '@axiumine/koa-utils/graphQL/throw/throwForbiddenError'
import { Company } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Company'
import { trusted, Types } from 'mongoose'

/**
 * The company an owner names has to be one of theirs, and still live.
 *
 * `_id` is an id the client sends on `companyUpdate` and `companyDel`, so without this check any owner
 * could edit or retire any company on the platform by guessing an ObjectId.
 *
 * The `deleted` clause is what stops a retired company being acted on twice: it is gone from
 * `shopOwnerCompanies`, so the only way to name one is an id the client kept from before, and a second
 * `companyDel` on it answers 403 rather than repeating the stamp. trusted(): `sanitizeFilter` is on
 * globally, so a bare `{ $exists: false }` would be read as a literal value and the query would fail
 * casting it against the `deleted` path.
 */
export async function throwIfShopOwnerDontOwnCompany(shopOwnerId: Types.ObjectId, companyId: Types.ObjectId) {
	const found = await Company.countDocuments({
		_id: companyId,
		idShopOwner: shopOwnerId,
		deleted: trusted({ $exists: false })
	}).lean()

	if (found === 0) {
		throw throwForbiddenError()
	}
}
