import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { funItemUpdatePublished } from '@lib/item/funItemUpdatePublished.mjs'
import { throwIfShopOwnerDontOwnItem } from '@lib/item/throwIfShopOwnerDontOwnItem.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	published: boolean
}

/**
 * Publishes an item of the signed-in owner, or withdraws it from the public site.
 *
 * A separate operation from `itemUpdate` by decision, not by accident: saving the card is one thing an
 * owner does and publishing is another, and folding the second into the first made every save a write
 * of the flag. The operator tier has had this shape since it gained moderation — the same mutation
 * name, on 4024 — and this is the owner's side of it.
 *
 * One guard, unlike `itemUpdate`'s three: nothing moves here, so the only question is whether the item
 * named belongs to the session.
 *
 * No `validate*` call, like the operator tier's: `Boolean!` is the whole contract, so GraphQL has
 * already rejected everything a validator would have.
 */
export const itemUpdatePublished = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'publishes or unpublishes an item',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		published: { type: new GraphQLNonNull(GraphQLBoolean) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		await throwIfShopOwnerDontOwnItem(ctx.state.user._id, args._id)

		try {
			await funItemUpdatePublished(args._id, ctx.state.user._id, args.published)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
