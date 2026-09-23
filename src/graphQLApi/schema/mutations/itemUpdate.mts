import { moveFileStaticDomain } from '@axiumine/koa-utils/files/moveFileStaticDomain'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputItem } from '@GraphQLInput/GraphQLInputItem.mjs'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { holdCompany } from '@lib/company/holdCompany.mjs'
import { throwIfShopOwnerDontOwnCompany } from '@lib/company/throwIfShopOwnerDontOwnCompany.mjs'
import { funItemUpdate, IItemUpdate, IItemUpdateBefore } from '@lib/item/funItemUpdate.mjs'
import { holdItemCategory } from '@lib/item/holdItemCategory.mjs'
import { throwIfShopOwnerDontOwnItem } from '@lib/item/throwIfShopOwnerDontOwnItem.mjs'
import { validateItem } from '@lib/validate/validateItem.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import mongoose, { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	item: IItemUpdate
}

/**
 * Saves an item of the signed-in owner.
 *
 * `validateItem` runs first, ahead of every guard: `name`, `description` and `slug` are checked for
 * shape alone, so a 400 from it costs nothing and names no item, company or category that exists.
 *
 * ⚠️ **Three guards, because this mutation can move an item between shops.** `idCompany` is part of
 * the input, so a save is also potentially a transfer, and the source and the destination are two
 * different companies that both have to belong to the session:
 * `throwIfShopOwnerDontOwnItem` checks where the item is now, `throwIfShopOwnerDontOwnCompany` checks
 * where it is going. Dropping either one leaves half the check — the first alone lets an owner push
 * their item into a stranger's shop, the second alone lets them pull a stranger's item into theirs.
 *
 * The third and fourth are `holdItemCategory` and `holdCompany`, and both are inside the transaction
 * rather than beside the other two: a save can re-file an item under a different category or re-point it
 * at a different company, so each has to refuse a target that does not exist any more — and keep on
 * refusing until the save lands, or an admin retiring that category, or the owner retiring that company,
 * in the same instant leaves the item filed under something gone. Unlike `itemAdd` this mutation uploads
 * nothing, so there is no expensive step to refuse ahead of and no reason to ask either question a
 * second, cheaper time.
 *
 * The two ownership guards stay outside the transaction. They read the session's own companies and the
 * item's, which nothing in that race writes, and holding a transaction open across them would buy
 * contention on the category and the destination company for nothing.
 *
 * ## The picture
 *
 * ⚠️ **A transfer that carries a picture has to move the file, or the card ships a broken image.**
 * `funItemUpdate` answers what the item held *before* this save — its previous `idCompany` and `image` —
 * because `STATIC_FOLDER/item/<idCompany>/` is keyed on the company, and the picture that was reachable
 * under the old one is not reachable under the new one until something moves it. Comparing the two ids
 * with `String(...)` rather than relying on "idCompany is part of the input" catches the ordinary case
 * too, where a save leaves the item exactly where it was and there is nothing to move — `moveFileStaticDomain`
 * runs only when the company actually changed and the item actually had a picture.
 *
 * ⚠️ **The move runs after the transaction commits, outside it, the same placement `itemAdd` gives its
 * own move.** A `rename` is not undone by an abort, and `withTransaction` re-runs its callback on a
 * `WriteConflict` — a step inside it is a step that can happen twice, and the *last* successful attempt
 * is the one whose `before` this reads, since every earlier one was thrown away with the write it lost.
 *
 * The destination name is `String(args._id)`, not a name parsed out of the stored `image`: `itemAdd`
 * already names every picture after the item's own `_id`, and the id does not change on a transfer — so
 * the new name is the same one the old file already carried, and there is nothing to parse.
 */
export const itemUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'update item',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		item: { type: new GraphQLNonNull(GraphQLInputItem) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		const item = validateItem(args.item)

		await throwIfShopOwnerDontOwnItem(ctx.state.user._id, args._id)
		await throwIfShopOwnerDontOwnCompany(ctx.state.user._id, item.idCompany)

		const session = await mongoose.startSession()
		let before: IItemUpdateBefore | undefined

		try {
			await session.withTransaction(async () => {
				await holdItemCategory(item.idCategory, session)
				await holdCompany(item.idCompany, session)

				before = await funItemUpdate(args._id, ctx.state.user._id, item, session)
			})

			if (before && before.image && String(before.idCompany) !== String(item.idCompany)) {
				await moveFileStaticDomain(
					`${process.env.STATIC_FOLDER}/item/${String(before.idCompany)}/${before.image}`,
					'item',
					String(item.idCompany),
					String(args._id)
				)
			}
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		} finally {
			await session.endSession()
		}

		return true
	}
}
