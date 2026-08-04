import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextImprenditoreAuthenticatedResource } from '@lib/auth/IContextImprenditoreAuthenticatedResource.mjs'
import { funAziendaDelete } from '@lib/azienda/funAziendaDelete.mjs'
import { throwIfImprenditoreDontOwnAzienda } from '@lib/azienda/throwIfImprenditoreDontOwnAzienda.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

/**
 * Retires a company of the signed-in owner.
 *
 * A soft delete: the row keeps its place and gains a `deleted` instant, so every read path drops it and
 * nothing on the platform can name it again. The ownership guard runs first and filters `deleted` too,
 * which is why a second call on the same company answers 403 rather than repeating the stamp.
 */
export const aziendaDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'del azienda',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextImprenditoreAuthenticatedResource) {
		await throwIfImprenditoreDontOwnAzienda(ctx.state.user._id, args._id)

		try {
			await funAziendaDelete(args._id, ctx.state.user._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
