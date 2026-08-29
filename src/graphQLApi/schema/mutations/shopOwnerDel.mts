import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { endEverySession } from '@lib/auth/endEverySession.mjs'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { funShopOwnerDel } from '@lib/shopOwner/funShopOwnerDel.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull } from 'graphql'

/**
 * Closes the signed-in shop owner's own account.
 *
 * The self-service half of the Admin tier's `shopOwnerDel`, and the only write on this tier that ends an
 * account. What it costs the owner is bounded: closing starts the thirty-day window ADR-046 makes an
 * *undo* window, and registering again at the same address inside it restores this same document —
 * `_id` and all, so every company and item is still theirs. Dark, but theirs.
 */
export const shopOwnerDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'closes the signed-in shopOwner account',
	// No `_id` argument, and the absence is load-bearing: every shop owner authenticates against the same
	// collection and the platform has no role field, so an id accepted from the client would turn this
	// into "close any owner's account". The account is the one the request is authenticated as, taken from
	// the Redis session below. No ownership guard either — there is no client-chosen id to guard.
	async resolve(_: unknown, {}, ctx: IContextShopOwnerAuthenticatedResource) {
		try {
			await funShopOwnerDel(ctx.state.user._id)

			// ⚠️ **After the write and inside the try, both deliberately.** Before it, an account that then
			// failed to close would have logged the owner out of every device for nothing. Outside it, a
			// Redis that refused would leave this answering `true` with every session of a closed account
			// still live — a closed account somebody is still inside is the outcome this exists to prevent.
			//
			// The caller's own session goes with the rest, which is what closing an account means, and it is
			// also what makes a second call unreachable: the next request is refused by the auth middleware.
			await endEverySession(ctx)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
