import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { ClientSession, trusted, Types } from 'mongoose'

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
 *
 * The session is `null` on every path but one. `funItemUpdate` runs inside a transaction that holds the
 * destination category still, and a read it makes outside that session answers from a different
 * snapshot than the write it feeds. `null` is what mongoose spells "no session", so the call is
 * unconditional and there is no branch here for a later reader to get wrong.
 */
export async function shopOwnerCompanyIds(shopOwnerId: Types.ObjectId, session: ClientSession | null = null) {
	const companies = await Company.find({ idShopOwner: shopOwnerId, deleted: trusted({ $exists: false }) }, { _id: 1 })
		.session(session)
		.lean()
		.exec()

	return companies.map(({ _id }) => _id)
}
