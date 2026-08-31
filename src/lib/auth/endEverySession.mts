import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { revokeAllSessionsForAccount } from '@axiumine/marketplace-common/others/revokeAllSessionsForAccount'
import { deleteSession } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'

/**
 * Logs the calling shop owner out of everything, everywhere. Called after a write that ends the account
 * has landed, never before one and never instead of one.
 *
 * The ShopOwner-tier twin of the User tier's function of the same name, down to the order of the two
 * calls, and it differs in one value: `TIER.shopOwner`. That tier is not decoration — the session index is
 * keyed by tier, so passing the wrong one revokes nothing and reports success.
 *
 * ⚠️ **The calling session goes with the rest.** Sparing the caller is friendlier and defeats the point:
 * the server cannot tell the account holder's session from an intruder's, so an exemption granted to
 * *whichever session sent the mutation* is a rule an attacker can aim at.
 *
 * ⚠️ **Refresh sessions first, the caller's access key second, and that order is the safe residue.** A
 * process death between the two leaves the caller's access token alive for the minutes it has left, which
 * is the residual every other session already carries. The reverse order leaves the refresh sessions
 * alive, and an intruder simply refreshes into a new access token.
 *
 * The missing-header branch keeps this helper total rather than trusting a caller two layers away: the
 * authorization handler refuses a request with no `Authorization` header before any resolver runs, and a
 * key derived from a header that is not there would be the digest of the empty string — a key belonging to
 * nobody, deleted with a success reported.
 */
export async function endEverySession(ctx: IContextShopOwnerAuthenticatedResource) {
	await revokeAllSessionsForAccount({ store: redisClient, tier: TIER.shopOwner, accountId: `${ctx.state.user._id}` })

	const authorization = ctx.request.header?.authorization

	if (typeof authorization === 'undefined') {
		return
	}

	// `Bearer access:<token>` minus the scheme is the prefixed token every session helper takes, and the
	// `access:` half must stay: it is what tells an access hash from a refresh one inside the digest.
	await deleteSession(redisClient, authorization.replace('Bearer ', ''))
}
