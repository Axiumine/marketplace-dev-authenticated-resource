import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwAccessTokenExpiredOrDeleted } from '@axiumine/koa-utils/graphQL/throw/throwAccessTokenExpiredOrDeleted'
import { throwAccessTokenRequired } from '@axiumine/koa-utils/graphQL/throw/throwAccessTokenRequired'
import { throwPreconditionFailedNoAuthHeader } from '@axiumine/koa-utils/graphQL/throw/throwPreconditionFailedNoAuthHeader'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { makeAuthCtx } from '@lib/auth/makeAuthCtx.mjs'
import { assertTier } from '@thedoctorweb_agency/marketplace-common/others/assertTier'
import { IRedisDataShopOwner } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataShopOwner'
import { TIER } from '@thedoctorweb_agency/marketplace-common/others/Tier'
import * as dotenv from 'dotenv'
import { Next } from 'koa'

dotenv.config()

export const authorizationAuthenticatedResourceHandler =
	() => async (ctx: IContextShopOwnerAuthenticatedResource, next: Next) => {
		/***************************
		 * CLIENT: Invia opaque token
		 * - in authorization: ctx.request.header.authorization =  'Bearer TOKEN_HERE
		 * - in cookie: ctx.request.header.cookie = firstName_cookie=TOKEN_HERE
		 */
		//console.debug('[authorizationAuthenticatedResourceHandler]')

		let introspection = false

		const authorization = ctx.request.header?.authorization // access
		// more detailed errors code instead of generic 401 unauthorized (tampering)
		if (typeof authorization === 'undefined') {
			if (
				typeof ctx.request.header !== 'undefined' &&
				ctx.request.header['x-introspectioncode'] === `${process.env.INTROSPECTION_CODE}`
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

			const redAccessSession = await redisClient.hGetAll(`${process.env.REDIS_KEY}${accessToken}`) // 'access:' already present
			if (redAccessSession != null && Object.keys(redAccessSession).length !== 0) {
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
