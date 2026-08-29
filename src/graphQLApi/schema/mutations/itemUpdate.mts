import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputItem } from '@GraphQLInput/GraphQLInputItem.mjs'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { throwIfShopOwnerDontOwnCompany } from '@lib/company/throwIfShopOwnerDontOwnCompany.mjs'
import { funItemUpdate, IItemUpdate } from '@lib/item/funItemUpdate.mjs'
import { holdItemCategory } from '@lib/item/holdItemCategory.mjs'
import { throwIfShopOwnerDontOwnItem } from '@lib/item/throwIfShopOwnerDontOwnItem.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import mongoose, { Types } from 'mongoose'

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
 *
 * The third is `holdItemCategory`, and it is inside the transaction rather than beside the other two: a
 * save can also re-file an item under a different category, so it has to refuse one that does not exist
 * — and it has to keep on refusing until the save lands, or an admin retiring that category in the
 * same instant leaves the item filed under it. Unlike `itemAdd` this mutation uploads nothing, so there
 * is no expensive step to refuse ahead of and no reason to ask the question a second, cheaper time.
 *
 * The two ownership guards stay outside the transaction. They read the session's own companies and the
 * item's, which nothing in that race writes, and holding a transaction open across them would buy
 * contention on the category for nothing.
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

		const session = await mongoose.startSession()

		try {
			await session.withTransaction(async () => {
				await holdItemCategory(args.item.idCategory, session)

				await funItemUpdate(args._id, ctx.state.user._id, args.item, session)
			})
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		} finally {
			await session.endSession()
		}

		return true
	}
}
