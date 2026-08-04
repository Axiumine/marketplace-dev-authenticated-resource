import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { funCompanyDelete } from '@lib/company/funCompanyDelete.mjs'
import { throwIfShopOwnerDontOwnCompany } from '@lib/company/throwIfShopOwnerDontOwnCompany.mjs'
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
export const companyDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'del company',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		await throwIfShopOwnerDontOwnCompany(ctx.state.user._id, args._id)

		try {
			await funCompanyDelete(args._id, ctx.state.user._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
