import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { funItemsUpdatePublished } from '@lib/item/funItemsUpdatePublished.mjs'
import { throwIfShopOwnerDontOwnAllItems } from '@lib/item/throwIfShopOwnerDontOwnAllItems.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLList, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_ids: Types.ObjectId[]
	published: boolean
}

/**
 * How many items one call may carry.
 *
 * ⚠️ **A bound is required, not a preference.** `[ID!]!` puts the length of the `$in` in the client's
 * hands, and an unbounded list is a query the caller sizes: the guard's `countDocuments` and the write
 * both scan a set the request chose. The number is what a real shop can hold rather than what MongoDB
 * tolerates — the owner's item list is not paged, so a select-all on a large catalogue is the case this
 * has to serve, and the frontend sends the selection in runs of this size when it is bigger.
 */
export const MAX_ITEMS_PER_CALL = 500

/**
 * The same list with each id kept once, in the order it first arrived.
 *
 * Keyed on the string form because that is what `GraphQLID` coerces to and what a client repeating an id
 * sends twice — comparing the values themselves would let `[a, a]` through as two entries.
 *
 * ⚠️ Duplicates cannot simply be passed along: the ownership guard is all-or-nothing against the length
 * of the list, so a repeated id would count one document against two entries and refuse a call that is
 * entirely the owner's own.
 */
const uniqueIds = (ids: Types.ObjectId[]) => [...new Map(ids.map((id) => [String(id), id])).values()]

/**
 * Publishes a list of the signed-in owner's items, or withdraws all of them from the public site.
 *
 * The bulk half of `itemUpdatePublished`, added for the owner's select-all control. It is a mutation of
 * its own rather than a widened `itemUpdatePublished` because the singular's contract is worth keeping
 * exactly as narrow as it is: one id, one 403, one flag.
 *
 * ⚠️ **Ownership is checked once, for the whole list, and refuses all of it or none of it.** See
 * `throwIfShopOwnerDontOwnAllItems` for why a partial application would be both unreportable and an
 * existence oracle.
 *
 * The two input refusals are here rather than in a `validate*` module: `[ID!]!` and `Boolean!` are the
 * whole contract, so GraphQL has already rejected everything except a list that is empty or too long.
 * An empty list is refused rather than answered `true` — it is a client that lost its selection, not an
 * owner asking for nothing, and a silent success would look like the flag had been written.
 */
export const itemsUpdatePublished = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'publishes or unpublishes several items at once',
	args: {
		_ids: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))) },
		published: { type: new GraphQLNonNull(GraphQLBoolean) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		const itemIds = uniqueIds(args._ids)

		if (itemIds.length === 0) {
			throwErrorWrongUserInput('_ids: at least one item is required')
		}

		if (itemIds.length > MAX_ITEMS_PER_CALL) {
			throwErrorWrongUserInput(`_ids: at most ${MAX_ITEMS_PER_CALL} items per call`)
		}

		await throwIfShopOwnerDontOwnAllItems(ctx.state.user._id, itemIds)

		try {
			await funItemsUpdatePublished(itemIds, ctx.state.user._id, args.published)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
