import type { Next } from 'koa'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextShopOwnerAuthenticatedResource } from '../src/lib/auth/IContextShopOwnerAuthenticatedResource.mts'

const hGetAll = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hGetAll } }))

const { authorizationAuthenticatedResourceHandler } = await import('../src/lib/db/authorizationAuthenticatedResourceHandler.mts')

const ACCESS = 'access:27119032-9043-4a9f-bd4c-9d06fd576290'
// A real 24-hex ObjectId: makeAuthCtx feeds redData._id straight into new Types.ObjectId().
const OID = '507f1f77bcf86cd799439011'

function makeCtx(header?: Record<string, string>) {
	return { request: { header }, state: {} } as unknown as IContextShopOwnerAuthenticatedResource
}

/** Redis returns a prototype-less object; the handler spreads it, so mimic that shape. */
function redisSession(extra: Record<string, string> = {}) {
	// `tier` has to be here: the handler asserts it before building ctx.state.user, so a session
	// without one is refused outright — which is the point of the discriminator, and why every
	// fixture that expects to get past the guard has to carry the tier this service accepts.
	return Object.assign(Object.create(null), { _id: OID, email: 'oste@marketplace.test', tier: 'shopOwner', ...extra })
}

describe('authorizationAuthenticatedResourceHandler', () => {
	let next: Next

	beforeEach(() => {
		hGetAll.mockReset()
		next = vi.fn().mockResolvedValue('next') as unknown as Next
	})

	it('builds state.user from the Redis session', async () => {
		hGetAll.mockResolvedValueOnce(redisSession())

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).resolves.toBe('next')

		// 'access:' is already part of the token, so the key is the prefix + the token verbatim.
		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(`test:${ACCESS}`)
		expect(String(ctx.state.user._id)).toBe(OID)
		expect(ctx.state.user.email).toBe('oste@marketplace.test')
		expect(next).toHaveBeenCalledTimes(1)
	})

	// The onboarding step lives in the session, not in MongoDB — an shopOwner mid-onboarding has
	// to carry it into every request without a second round-trip.
	it('carries onboardingStep through when the session has one', async () => {
		hGetAll.mockResolvedValueOnce(redisSession({ onboardingStep: '2' }))

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })
		await authorizationAuthenticatedResourceHandler()(ctx, next)

		expect(ctx.state.user.onboardingStep).toBe('2')
	})

	it('answers 412 when there is no authorization header', async () => {
		const ctx = makeCtx({})

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Precondition Failed')
		expect(hGetAll).not.toHaveBeenCalled()
		expect(next).not.toHaveBeenCalled()
	})

	// ctx.request.header itself can be absent (the optional-chained read yields undefined), which is
	// a different branch from "header present but carrying no authorization".
	it('answers 412 when the request has no headers at all', async () => {
		const ctx = makeCtx(undefined)

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Precondition Failed')
	})

	it('answers 499 when the header does not use the `Bearer access:` scheme', async () => {
		const ctx = makeCtx({ authorization: `Bearer ${OID}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Token Required')
		expect(hGetAll).not.toHaveBeenCalled()
	})

	it('answers 498 when the session is gone from Redis', async () => {
		hGetAll.mockResolvedValueOnce({})

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Invalid Token')
		expect(next).not.toHaveBeenCalled()
	})

	it('answers 498 when Redis answers null instead of a hash', async () => {
		hGetAll.mockResolvedValueOnce(null)

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Invalid Token')
	})

	// Service-to-service calls: the code stands in for the whole bearer flow, so no Redis lookup
	// happens and state.user is never populated. Resolvers that need ctx.state.user must not be
	// called this way — introspection is what this is for.
	it('lets a valid x-introspectioncode through with no authorization header', async () => {
		const ctx = makeCtx({ 'x-introspectioncode': 'test-introspection-code' })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).resolves.toBe('next')

		expect(hGetAll).not.toHaveBeenCalled()
		expect(ctx.state.user).toBeUndefined()
		expect(next).toHaveBeenCalledTimes(1)
	})

	it('ignores a wrong x-introspectioncode', async () => {
		const ctx = makeCtx({ 'x-introspectioncode': 'wrong-code' })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Precondition Failed')
	})

	// The code is only consulted when the header is missing: a caller that sends both is
	// authenticated normally, and a bad token is still refused.
	it('does not let the introspection code rescue a bearer token whose session expired', async () => {
		hGetAll.mockResolvedValueOnce({})

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}`, 'x-introspectioncode': 'test-introspection-code' })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Invalid Token')
	})
})
