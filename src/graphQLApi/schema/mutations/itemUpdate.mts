import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputItem } from '@GraphQLInput/GraphQLInputItem.mjs'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { throwIfShopOwnerDontOwnCompany } from '@lib/company/throwIfShopOwnerDontOwnCompany.mjs'
import { funItemUpdate, IItemUpdate } from '@lib/item/funItemUpdate.mjs'
import { throwIfItemCategoryMissing } from '@lib/item/throwIfItemCategoryMissing.mjs'
import { throwIfShopOwnerDontOwnItem } from '@lib/item/throwIfShopOwnerDontOwnItem.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	item: IItemUpdate
}

/**
 * Saves an item of the signed-in owner.
 *
 * ⚠️ **Three guards, because this mutation can move an item between shops.** `idCompany` is part of
 * the input, so a save is also potentially a transfer, and the source and the destination are two
 * different companies that both have to belong to the session:
 * `throwIfShopOwnerDontOwnItem` checks where the item is now, `throwIfShopOwnerDontOwnCompany` checks
 * where it is going. Dropping either one leaves half the check — the first alone lets an owner push
 * their item into a stranger's shop, the second alone lets them pull a stranger's item into theirs.
 */
export const itemUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'update item',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		item: { type: new GraphQLNonNull(GraphQLInputItem) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		await throwIfShopOwnerDontOwnItem(ctx.state.user._id, args._id)
		await throwIfShopOwnerDontOwnCompany(ctx.state.user._id, args.item.idCompany)
		await throwIfItemCategoryMissing(args.item.idCategory)

		try {
			await funItemUpdate(args._id, ctx.state.user._id, args.item)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
