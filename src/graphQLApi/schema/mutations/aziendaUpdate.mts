import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputAzienda } from '@GraphQLInput/GraphQLInputAzienda.mjs'
import { IContextImprenditoreAuthenticatedResource } from '@lib/auth/IContextImprenditoreAuthenticatedResource.mjs'
import { funAziendaUpdate, IAziendaUpdate } from '@lib/azienda/funAziendaUpdate.mjs'
import { throwIfImprenditoreDontOwnAzienda } from '@lib/azienda/throwIfImprenditoreDontOwnAzienda.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	azienda: IAziendaUpdate
}

/** Saves a company of the signed-in owner. The ownership guard runs first, as on every write here. */
export const aziendaUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'update azienda',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		azienda: { type: new GraphQLNonNull(GraphQLInputAzienda) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextImprenditoreAuthenticatedResource) {
		await throwIfImprenditoreDontOwnAzienda(ctx.state.user._id, args._id)

		try {
			await funAziendaUpdate(args._id, ctx.state.user._id, args.azienda)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
