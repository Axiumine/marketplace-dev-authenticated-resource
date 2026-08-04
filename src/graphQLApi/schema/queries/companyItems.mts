import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { throwIfShopOwnerDontOwnCompany } from '@lib/company/throwIfShopOwnerDontOwnCompany.mjs'
import { GraphQLItem } from '@ptypes/GraphQLItem.mjs'
import { Item } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Item'
import { GraphQLID, GraphQLList, GraphQLNonNull } from 'graphql'
import { trusted, Types } from 'mongoose'

interface IArgs {
	idCompany: Types.ObjectId
}

/**
 * The live items of one of the signed-in owner's shops.
 *
 * Takes `idCompany` rather than deriving the whole catalogue from the session: an owner may hold
 * several companies and the item list is a per-shop screen. That makes the argument client-supplied,
 * which is why `throwIfShopOwnerDontOwnCompany` runs first — without it this is a read of any shop's
 * catalogue, drafts included, by anyone holding any ShopOwner token.
 *
 * Both drafts and published items come back: this is the owner's own management list, and the
 * `published` flag is what the row renders. The public tier filters it; this one must not.
 *
 * trusted(): `sanitizeFilter` is on globally, so a bare `{ $exists: false }` would be taken as a
 * literal value and cast against the `deleted` path instead of being read as an operator.
 */
export const companyItems = {
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLItem))),
	description: 'Get items of a company',
	args: {
		idCompany: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		await throwIfShopOwnerDontOwnCompany(ctx.state.user._id, args.idCompany)

		return Item.find({ idCompany: args.idCompany, deleted: trusted({ $exists: false }) }).lean()
	}
}
