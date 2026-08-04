import { Company } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Company'
import { trusted, Types } from 'mongoose'

/**
 * The live companies of one owner, as ids.
 *
 * The catalogue chain is `shopOwner ──idShopOwner──> company ──idCompany──> item`, and `item` carries
 * no `idShopOwner`: ownership of an item is transitive through its company. Every item read and every
 * item write on this tier therefore starts here, which is why it is one function rather than the same
 * two-line `find` copied into four resolvers.
 *
 * An empty array is a correct answer, not an error — an owner with no company matches no item under
 * `$in`, which is exactly the refusal wanted.
 *
 * trusted(): `sanitizeFilter` is on globally, so a bare `{ $exists: false }` would be read as a
 * literal value and the query would fail casting it against the `deleted` path.
 */
export async function shopOwnerCompanyIds(shopOwnerId: Types.ObjectId) {
	const companies = await Company.find({ idShopOwner: shopOwnerId, deleted: trusted({ $exists: false }) }, { _id: 1 })
		.lean()
		.exec()

	return companies.map(({ _id }) => _id)
}
