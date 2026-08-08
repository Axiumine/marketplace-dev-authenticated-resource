import { OnlyIdType } from '@axiumine/koa-utils/graphQL/schema/types/OnlyIdType'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { IItemSchema } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IItemSchema'
import { GraphQLInputItem } from '@GraphQLInput/GraphQLInputItem.mjs'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { throwIfShopOwnerDontOwnCompany } from '@lib/company/throwIfShopOwnerDontOwnCompany.mjs'
import { IItemUpdate } from '@lib/item/funItemUpdate.mjs'
import { throwIfItemCategoryMissing } from '@lib/item/throwIfItemCategoryMissing.mjs'
import { GraphQLError, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	item: IItemUpdate
}

/**
 * Adds an item to one of the signed-in owner's shops.
 *
 * Two guards, in this order, and both are load-bearing. `throwIfShopOwnerDontOwnCompany` refuses an
 * `idCompany` the session does not hold — without it, an owner could stock any shop on the platform,
 * because `idCompany` is a client-supplied id rather than something the session determines (an owner
 * may hold several companies, so it cannot be). `throwIfItemCategoryMissing` refuses a category that
 * does not exist, which MongoDB will not do for us: there are no foreign keys.
 *
 * Ownership first, existence second: a caller who does not own the shop learns nothing about which
 * category ids are real.
 *
 * Answers the new `_id`, like `companyAdd` and unlike the operator tier's `Boolean` — the owner's
 * flow continues with the item that was just created (uploading its image, most obviously), and the
 * id is what the second step needs.
 */
export const itemAdd = {
	type: new GraphQLNonNull(OnlyIdType),
	description: 'add item',
	args: {
		item: { type: new GraphQLNonNull(GraphQLInputItem) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		await throwIfShopOwnerDontOwnCompany(ctx.state.user._id, args.item.idCompany)
		await throwIfItemCategoryMissing(args.item.idCategory)

		const newItem: IItemSchema = {
			_id: new Types.ObjectId(),
			...args.item
		}

		// `return await`, not `return`: without the await the promise escapes the try, so the catch
		// below can never run and a slug already taken in this shop would surface as an unhandled
		// rejection instead of the 409 tryCatchRethrow makes of it.
		try {
			return await Item.create(newItem)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
