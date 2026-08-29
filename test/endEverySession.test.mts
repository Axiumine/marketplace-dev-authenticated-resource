import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextShopOwnerAuthenticatedResource } from '../src/lib/auth/IContextShopOwnerAuthenticatedResource.mts'

const hKeys = vi.fn()
const hGet = vi.fn()
const del = vi.fn()
const hDel = vi.fn()

/*
 * ⚠️ Only the client is faked. `revokeAllSessionsForAccount` and `deleteSession` run for real, so what
 * this suite asserts is the Redis conversation itself — the key shapes, their order and their count —
 * rather than that two mocks were called. A mocked helper would agree with a wrong key.
 */
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hKeys, hGet, del, hDel } }))

const { endEverySession } = await import('../src/lib/auth/endEverySession.mts')

const REDIS_KEY = 'test:'
const ACCOUNT_ID = '507f1f77bcf86cd799439011'

/** The index this tier's sessions are filed under. `shopOwner`, and the tier half is what makes it this one. */
const INDEX_KEY = `${REDIS_KEY}idx:shopOwner:${ACCOUNT_ID}`

// Three live sessions, one of them the caller's own. The digests are arbitrary here: the index stores
// the body of each refresh session's key, and this service never sees a refresh token to derive one from.
const CALLER_REFRESH_FIELD = 'a'.repeat(64)
const FIELDS = [CALLER_REFRESH_FIELD, 'b'.repeat(64), 'c'.repeat(64)]

/*
 * Each refresh session names the access session it minted, in its own `accessKey` field. The stub answers
 * the session key upper-cased, which is not a key shape the platform ever writes and is exactly why it is
 * used here: a `del` of one of these can only have come from reading the field, never from the routine
 * deriving a key from the field it already had.
 */
const accessKeyOf = (sessionKey: string) => sessionKey.toUpperCase()
const SESSION_KEYS = FIELDS.map((field) => `${REDIS_KEY}${field}`)

// The access token the mutation arrived with, and the digest of it written out as a literal — computed
// elsewhere, because a test that hashed it with the same call the implementation makes would agree with
// that call about any algorithm, including a mutated one.
const ACCESS_TOKEN = 'access:access-token-1'
const ACCESS_DIGEST = '19195cd4fbcc945be28c2decfc4a2fb1bf34f4ec333f3973d3e2522bd9dbebc1'

// ⚠️ The header is passed as the whole object, never as `ctx(undefined)`: an explicit `undefined`
// argument takes the default parameter, so the no-header case would have quietly tested the header one.
const ctx = (header: Record<string, string> = { authorization: `Bearer ${ACCESS_TOKEN}` }) =>
	({
		state: { user: { _id: new Types.ObjectId(ACCOUNT_ID) } },
		request: { header }
	}) as unknown as IContextShopOwnerAuthenticatedResource

// `request.header` is optional on the context type and genuinely absent on some requests, which is a
// different shape from a header object with no `authorization` in it and has to be built separately.
const ctxWithoutHeaders = () =>
	({
		state: { user: { _id: new Types.ObjectId(ACCOUNT_ID) } },
		request: {}
	}) as unknown as IContextShopOwnerAuthenticatedResource

beforeEach(() => {
	vi.stubEnv('REDIS_KEY', REDIS_KEY)
	hKeys.mockReset().mockResolvedValue(FIELDS)
	hGet.mockReset().mockImplementation((key: string) => Promise.resolve(accessKeyOf(key)))
	del.mockReset().mockResolvedValue(1)
	hDel.mockReset().mockResolvedValue(1)
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('endEverySession', () => {
	/*
	 * ⚠️ **The tier is read off the index key, and the assertion spells it out.** The session index is keyed
	 * by tier, so a call carrying the wrong one reads an index that is empty, revokes nothing and reports
	 * success — a closed account every device is still inside, with no failure anywhere to say so. The
	 * negative assertion names the tier this file was copied from, which is the way it would go wrong.
	 */
	it('revokes against the shopOwner index, not another tier’s', async () => {
		await endEverySession(ctx())

		expect(hKeys.mock.calls).toEqual([[INDEX_KEY], [INDEX_KEY]])
		expect(del.mock.calls.map(([key]) => key)).not.toContain(`${REDIS_KEY}idx:user:${ACCOUNT_ID}`)
	})

	/*
	 * ⚠️ **The caller's own session goes with the rest.** Sparing it is friendlier and was rejected: the
	 * server cannot tell the account holder's session from an intruder's, so an exemption granted to
	 * whichever session sent the mutation is one an attacker can aim at.
	 */
	it('revokes every session the account holds, the caller’s included', async () => {
		await endEverySession(ctx())

		expect(del.mock.calls.slice(0, FIELDS.length).flat()).toEqual(SESSION_KEYS.map(accessKeyOf))
		expect(del.mock.calls.slice(FIELDS.length, FIELDS.length * 2).flat()).toEqual(SESSION_KEYS)
		expect(del.mock.calls.map(([key]) => key)).toContain(`${REDIS_KEY}${CALLER_REFRESH_FIELD}`)
	})

	/*
	 * ⚠️ **Both of the caller's keys, and the access one under its digest.** The scheme is stripped before
	 * the token is hashed: hashing `Bearer access:…` produces a digest of a string nothing ever wrote, so
	 * the caller's access token would outlive the account by the minutes it has left. The `access:` half
	 * must survive the strip — it is what tells an access hash from a refresh one inside the digest.
	 */
	it('deletes the caller’s access session, under the digest and not under the token', async () => {
		await endEverySession(ctx())

		const keys = del.mock.calls.map(([key]) => key)

		expect(keys).toContain(`${REDIS_KEY}${ACCESS_DIGEST}`)
		expect(keys).not.toContain(`${REDIS_KEY}${ACCESS_TOKEN}`)
		expect(keys).not.toContain(`${REDIS_KEY}Bearer ${ACCESS_TOKEN}`)
	})

	/*
	 * ⚠️ **Refresh sessions first, the caller's access key second, and that order is the safe residue.** A
	 * process death between the two leaves an access token alive for the minutes it has left, which every
	 * other session already carries. Reversed, the refresh sessions survive — and an intruder simply
	 * refreshes into a new access token.
	 */
	it('ends the refresh sessions before the caller’s access key', async () => {
		await endEverySession(ctx())

		expect(del.mock.calls.map(([key]) => key).indexOf(`${REDIS_KEY}${ACCESS_DIGEST}`)).toBeGreaterThan(FIELDS.length * 2 - 1)
	})

	/*
	 * The introspection bypass reaches a resolver with no `Authorization` header at all, so there is no
	 * caller session to end — the account's own sessions still go. Deriving a key from a missing header
	 * would delete the digest of the empty string: a key belonging to nobody, and a delete reported as a
	 * success.
	 */
	it('deletes no access key when the request carried no Authorization header', async () => {
		await endEverySession(ctx({}))

		expect(del).toHaveBeenCalledTimes(FIELDS.length * 2 + 1)
		expect(del.mock.calls.map(([key]) => key)).not.toContain(`${REDIS_KEY}${ACCESS_DIGEST}`)
	})

	/*
	 * ⚠️ **`request.header` missing entirely, not merely empty.** The optional access is load-bearing: a
	 * context built without headers at all reaches here, and reading `.authorization` straight off
	 * `undefined` throws a `TypeError` out of a resolver that has already closed the account — turning a
	 * completed closure into a 500 and skipping the revocation entirely.
	 */
	it('revokes the account’s sessions when the request carried no headers at all', async () => {
		await expect(endEverySession(ctxWithoutHeaders())).resolves.toBeUndefined()

		expect(del.mock.calls).toEqual([
			...SESSION_KEYS.map((key) => [accessKeyOf(key)]),
			...SESSION_KEYS.map((key) => [key]),
			[INDEX_KEY]
		])
	})

	// An account whose sessions have all expired revokes quietly: `hKeys` on a missing key answers an empty
	// array, and there is then nothing to delete but the caller's own access key.
	it('still ends the caller’s access session when the index is empty', async () => {
		hKeys.mockResolvedValueOnce([])

		await endEverySession(ctx())

		expect(del).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}${ACCESS_DIGEST}`)
	})
})
