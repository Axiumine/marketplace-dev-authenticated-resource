import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { shopOwnerCompanyIds } from '@lib/company/shopOwnerCompanyIds.mjs'
import { trusted, Types } from 'mongoose'

/**
 * Puts one item of the owner's on the public site, or takes it off, and touches nothing else.
 *
 * The owner's half of the pair the admin tier already had. Publishing is a decision about an item,
 * not a property of the card, so it is one flag and one call — `funItemUpdate` no longer carries
 * `published` at all, and a save of the name, the description or the category leaves the flag where it
 * was. The window that used to exist is closed with it: a form opened before someone else flipped the
 * flag cannot flip it back on save, because a save no longer writes it.
 *
 * ⚠️ **Composes with the company's flag, and does not check it.** An item is publicly visible only if
 * both it and its shop are published, so publishing an item in a draft shop is legal and simply shows
 * nobody anything — which is the state an owner preparing a shop wants.
 *
 * The `idCompany` clause is the defence in depth `funItemUpdate` and `funItemDelete` carry, for the
 * same reason: `throwIfShopOwnerDontOwnItem` has already run, and this refuses the write a second time
 * if the item moved out from under the session in between. trusted(): `sanitizeFilter` is on globally.
 *
 * `matchedCount`, not `modifiedCount` — publishing something already published is the state the owner
 * asked for, and a no-op is not an error.
 */
export async function funItemUpdatePublished(itemId: Types.ObjectId, shopOwnerId: Types.ObjectId, published: boolean) {
	const ret = await Item.updateOne(
		{ _id: itemId, idCompany: trusted({ $in: await shopOwnerCompanyIds(shopOwnerId) }) },
		{ $set: { published } }
	).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
