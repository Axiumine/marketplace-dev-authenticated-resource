import { IContextImprenditoreAuthenticatedResource } from '@lib/auth/IContextImprenditoreAuthenticatedResource.mjs'
import { GraphQLAzienda } from '@ptypes/GraphQLAzienda.mjs'
import { Azienda } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda'
import { GraphQLList, GraphQLNonNull } from 'graphql'
import { trusted } from 'mongoose'

/**
 * The signed-in owner's live companies — what the shop form picks from.
 *
 * Owner and liveness, the same pair the punto vendita queries filter on. The `deleted` clause matters
 * twice over: this query draws the companies list *and* the `<select>` the shop form offers, so a
 * retired company left in would be pickable and then refused by `throwIfImprenditoreDontOwnAzienda`
 * with a 403 the owner cannot act on. trusted(): `sanitizeFilter` is on globally, so a bare
 * `{ $exists: false }` would be read as a literal value and the query would fail casting it against
 * the `deleted` path.
 */
export const aziendeImprenditore = {
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLAzienda))),
	description: 'Get aziende imprenditore',
	async resolve(_: unknown, {}, ctx: IContextImprenditoreAuthenticatedResource) {
		return Azienda.find({ idImprenditore: ctx.state.user._id, deleted: trusted({ $exists: false }) }).lean()
	}
}
