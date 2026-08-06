import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { funItemDelete } from '@lib/item/funItemDelete.mjs'
import { throwIfShopOwnerDontOwnItem } from '@lib/item/throwIfShopOwnerDontOwnItem.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

/**
 * Withdraws an item of the signed-in owner.
 *
 * A soft delete, like `companyDel`: the row keeps its place and gains a `deleted` instant, so every
 * read path drops it and its slug stays occupied inside the shop. The ownership guard runs first and
 * filters `deleted` too, which is why a second call on the same item answers 403 rather than
 * repeating the stamp.
 */
export const itemDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'del item',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		await throwIfShopOwnerDontOwnItem(ctx.state.user._id, args._id)

		try {
			await funItemDelete(args._id, ctx.state.user._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
