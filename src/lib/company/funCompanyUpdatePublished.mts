import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { Types } from 'mongoose'

/**
 * Puts one shop of the owner's on the public site, or takes it off, and touches nothing else.
 *
 * Publishing a shop is a decision about the shop, not a property of its card, so it is one flag and one
 * call — `funCompanyUpdate` no longer carries `published`, and saving the VAT number or the address
 * leaves the flag where it was.
 *
 * ⚠️ **The database can refuse `true` here, and that is the only check there is.** The `company`
 * validator carries an `$expr` clause saying a published shop must be linkable and renderable, so
 * `published: true` without both `slug` and `publicName` fails the write — on this call exactly as it
 * failed on `companyUpdate` before the split. There is deliberately no application-side pre-check
 * duplicating it: two copies of one rule drift, and the copy that matters is the one the collection
 * enforces on every writer.
 *
 * `idShopOwner` is in the filter, not in the update, the way `funCompanyUpdate` has it: a filter on
 * `_id` alone would let one owner publish another's shop.
 *
 * `matchedCount`, not `modifiedCount` — publishing something already published is the state the owner
 * asked for, and a no-op is not an error.
 */
export async function funCompanyUpdatePublished(companyId: Types.ObjectId, shopOwnerId: Types.ObjectId, published: boolean) {
	const ret = await Company.updateOne({ _id: companyId, idShopOwner: shopOwnerId }, { $set: { published } }).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
