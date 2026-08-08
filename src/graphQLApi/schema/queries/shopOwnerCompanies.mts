import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { GraphQLCompany } from '@ptypes/GraphQLCompany.mjs'
import { GraphQLList, GraphQLNonNull } from 'graphql'
import { trusted } from 'mongoose'

/**
 * The signed-in owner's live companies — what the shop form picks from.
 *
 * Owner and liveness, the same pair every owner-scoped query filters on. The `deleted` clause matters
 * twice over: this query draws the companies list *and* the `<select>` the shop form offers, so a
 * retired company left in would be pickable and then refused by `throwIfShopOwnerDontOwnCompany`
 * with a 403 the owner cannot act on. trusted(): `sanitizeFilter` is on globally, so a bare
 * `{ $exists: false }` would be read as a literal value and the query would fail casting it against
 * the `deleted` path.
 */
export const shopOwnerCompanies = {
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLCompany))),
	description: 'Get companies shopOwner',
	async resolve(_: unknown, {}, ctx: IContextShopOwnerAuthenticatedResource) {
		return Company.find({ idShopOwner: ctx.state.user._id, deleted: trusted({ $exists: false }) }).lean()
	}
}
