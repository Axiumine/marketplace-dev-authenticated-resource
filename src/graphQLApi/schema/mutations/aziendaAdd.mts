import { OnlyIdType } from '@axiumine/koa-utils/graphQL/schema/types/OnlyIdType'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputAzienda } from '@GraphQLInput/GraphQLInputAzienda.mjs'
import { IContextImprenditoreAuthenticatedResource } from '@lib/auth/IContextImprenditoreAuthenticatedResource.mjs'
import { IAziendaUpdate } from '@lib/azienda/funAziendaUpdate.mjs'
import { Azienda } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda'
import { IAziendaSchema } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/IAziendaSchema'
import { GraphQLError, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	azienda: IAziendaUpdate
}

/**
 * Creates a company for the signed-in owner.
 *
 * New with 20260803000100: the company used to be typed into `puntoVenditaAdd` and stored inside the
 * shop, which made the second pizzeria of the same chain collide on the unique partita IVA. It is
 * created once here and then referenced by id.
 *
 * The new `_id` is the return value — unlike the operator tier's `Boolean`, because the owner's own flow
 * is "create the company, then create the shop under it" and the second step needs the id the first one
 * produced.
 */
export const aziendaAdd = {
	type: new GraphQLNonNull(OnlyIdType),
	description: 'add azienda',
	args: {
		azienda: { type: new GraphQLNonNull(GraphQLInputAzienda) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextImprenditoreAuthenticatedResource) {
		const nuovaAzienda: IAziendaSchema = {
			_id: new Types.ObjectId(),
			idImprenditore: ctx.state.user._id,
			...args.azienda
		}

		// `return await`, not `return`: without the await the promise escapes the try, so the catch
		// below can never run and a duplicate partita IVA would surface as an unhandled rejection
		// instead of the 409 tryCatchRethrow makes of it.
		try {
			return await Azienda.create(nuovaAzienda)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
