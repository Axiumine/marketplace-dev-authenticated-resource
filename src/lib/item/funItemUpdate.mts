import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { IItemSchema } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IItemSchema'
import { shopOwnerCompanyIds } from '@lib/company/shopOwnerCompanyIds.mjs'
import { trusted, Types } from 'mongoose'

/**
 * Everything the owner may change about an item: its fields, minus the ones the server owns.
 *
 * `deleted` is in that list for the reason `ICompanyUpdate` excludes it — it is optional on the
 * schema, so leaving it in would make it a legal member of the update object, and a `$set` of the
 * whole object would then be the one way to retire an item, or revive one, without going through
 * `itemDel`.
 *
 * `published` is in that list too, and for a related reason: publishing is `itemUpdatePublished`, so a
 * `$set` of the whole object here must not carry the flag at all. Leaving it in would make every save
 * of the card a write of the flag, which is the behaviour that let a stale form republish an item an
 * operator had taken down.
 *
 * `image` is in that list for a third reason, and it is the one that needs a runtime guard as well:
 * `GraphQLInputItem` carries an `Upload` under that key so `itemAdd` can take a picture, and the same
 * input is what `itemUpdate` accepts. A save is therefore free to arrive with a stream where the
 * document holds a file name — see `funItemUpdate` below, which drops the key rather than trusting the
 * type.
 *
 * `idCompany` is **not** excluded, unlike `ICompanyUpdate`'s `idShopOwner`. Moving an item between
 * two shops of the same owner is a real operation — a chain reorganising its catalogue — and the
 * resolver checks the destination the same way it checks the source.
 */
export type IItemUpdate = Omit<IItemSchema, '_id' | '__v' | 'deleted' | 'published' | 'image'>

/**
 * Saves an item, scoped to the companies its owner holds.
 *
 * `$set` with the whole object rather than a partial: the input is complete, so a field the owner
 * cleared has to be cleared in the document too.
 *
 * ⚠️ **The `idCompany` clause reads the stored item, not the update.** It is defence in depth of the
 * same kind `funCompanyUpdate`'s `idShopOwner` filter is: `throwIfShopOwnerDontOwnItem` has already
 * run, and this refuses the write a second time if the item moved out from under the session between
 * the guard and here. The destination company in `data` is checked separately by the resolver —
 * a filter cannot check a value it is about to write.
 *
 * ⚠️ **`image` is dropped here, and the type saying it cannot be present is not enough.** `IItemUpdate`
 * omits it, but the value this receives came off the wire through `GraphQLInputItem`, which declares an
 * `image: Upload` for `itemAdd`'s benefit — and GraphQL will hand the same field to `itemUpdate`
 * without complaint. A `$set` of the whole object would then write a *promise of a stream* into a path
 * the validator declares a string, so the write fails, and it fails on the one mutation a client can
 * reach it from. Dropping the key at the write, rather than in the resolver, puts the guard where the
 * `$set` is: there is one `$set` and it cannot be bypassed by a second caller added later.
 *
 * Changing an item's picture is not this mutation's job either way. There is no replace path yet —
 * `itemAdd` is the only writer of the field — so this drops rather than diverts.
 */
export async function funItemUpdate(itemId: Types.ObjectId, shopOwnerId: Types.ObjectId, data: IItemUpdate) {
	// A copy with the key removed, rather than a rest-destructure: the discarded half of
	// `const { image, ...card } =` is a binding nothing reads, and `no-unused-vars` is an error here.
	const card: Partial<IItemUpdate & { image?: unknown }> = { ...data }
	delete card.image

	const ret = await Item.updateOne(
		{ _id: itemId, idCompany: trusted({ $in: await shopOwnerCompanyIds(shopOwnerId) }) },
		{ $set: card }
	).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
