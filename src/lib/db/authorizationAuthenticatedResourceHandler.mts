import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwAccessTokenExpiredOrDeleted } from '@axiumine/koa-utils/graphQL/throw/throwAccessTokenExpiredOrDeleted'
import { throwAccessTokenRequired } from '@axiumine/koa-utils/graphQL/throw/throwAccessTokenRequired'
import { throwPreconditionFailedNoAuthHeader } from '@axiumine/koa-utils/graphQL/throw/throwPreconditionFailedNoAuthHeader'
import { assertTier } from '@axiumine/marketplace-common/others/assertTier'
import { constantTimeEquals } from '@axiumine/marketplace-common/others/constantTimeEquals'
import { isIntrospectionBypassAllowed } from '@axiumine/marketplace-common/others/isIntrospectionBypassAllowed'
import { IRedisDataShopOwner } from '@axiumine/marketplace-common/others/Redis/IRedisDataShopOwner'
import { readSessionHash } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { makeAuthCtx } from '@lib/auth/makeAuthCtx.mjs'
import * as dotenv from 'dotenv'
import { Next } from 'koa'

dotenv.config()

export const authorizationAuthenticatedResourceHandler =
	() => async (ctx: IContextShopOwnerAuthenticatedResource, next: Next) => {
		/***************************
		 * CLIENT: sends the opaque token
		 * - in authorization: ctx.request.header.authorization =  'Bearer TOKEN_HERE
		 * - in cookie: ctx.request.header.cookie = firstName_cookie=TOKEN_HERE
		 */
		//console.debug('[authorizationAuthenticatedResourceHandler]')

		let introspection = false

		const authorization = ctx.request.header?.authorization // access
		// more detailed errors code instead of generic 401 unauthorized (tampering)
		if (typeof authorization === 'undefined') {
			// ⚠️ The environment gate is evaluated **before** the code is read (E13-S11). Outside `development`
			// and `test` the bypass does not exist at all, and a caller sending the correct header gets exactly
			// the error a caller sending nothing gets — a wrong code and a disabled feature must not be
			// distinguishable from the outside. `INTROSPECTION_CODE` stays in REQUIRED_ENV_VARS regardless:
			// unset, it stringifies to the literal `'undefined'`, and that word would be the bypass.
			//
			// The comparison is `constantTimeEquals`, never `===` (E13-S03): string equality stops at the first
			// differing character, and that gradient is a working oracle for the configured value.
			if (
				isIntrospectionBypassAllowed() &&
				typeof ctx.request.header !== 'undefined' &&
				constantTimeEquals(ctx.request.header['x-introspectioncode'], `${process.env.INTROSPECTION_CODE}`)
			) {
				introspection = true
			} else {
				throw throwPreconditionFailedNoAuthHeader()
			}
		}
		// `!introspection &&` is load-bearing: the branch above lets a valid x-introspectioncode through
		// with NO Authorization header at all, so dereferencing `authorization` unconditionally threw a
		// TypeError (500) and made the bypass unusable. Guarded, the non-null assertion is sound —
		// when introspection is false the `typeof authorization === 'undefined'` branch has already thrown.
		if (!introspection && !authorization!.startsWith('Bearer access:')) {
			throw throwAccessTokenRequired()
		}

		if (!introspection) {
			// No `accessToken !== ''` guard: the startsWith check above already guarantees the token
			// keeps its `access:` prefix after the replace, so the empty case was unreachable.
			const accessToken = authorization!.replace('Bearer ', '')

			// Keyed by the digest of the prefixed token, with a raw-key fallback for sessions minted before
			// the cutover (E13-S01/S02). The `access:` prefix stays part of the hashed value: it is what
			// tells an access hash from a refresh one, so it belongs inside the digest, not beside it.
			const redAccessSession = await readSessionHash(redisClient, accessToken) // 'access:' already present
			// `readSessionHash` normalises a missing or nullish reply to an empty hash, so this one test is
			// the whole "is there a session" question — the `!= null` arm it replaces is now unreachable.
			if (Object.keys(redAccessSession).length !== 0) {
				const redData = { ...redAccessSession } as unknown as IRedisDataShopOwner // For safety, Redis return an object without the default Object.prototype  in its prototype chain.
				// This is the check that made cross-tier tokens work. Every service reads Redis under the
				// same `REDIS_KEY` prefix and this handler used to accept *any* non-empty session hash, so
				// an Admin access token authenticated here and its `_id` was then handed to shop-owner
				// resolvers. Nothing downstream re-derives the tier — `makeAuthCtx` builds the `ForNode`
				// shape, which deliberately drops it — so this call site is the whole boundary. A session
				// with no `tier` predates the discriminator and is refused too: fail closed, re-login.
				assertTier(redData.tier, TIER.shopOwner)
				ctx.state.user = makeAuthCtx(redData)
			} else throwAccessTokenExpiredOrDeleted()
		}

		return next()
	}
