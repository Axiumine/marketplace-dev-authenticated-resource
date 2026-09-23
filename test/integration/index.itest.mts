import { randomUUID } from 'node:crypto'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { decryptDocument } from '@axiumine/marketplace-common/encryption/decryptDocument'
import { encryptDocument } from '@axiumine/marketplace-common/encryption/encryptDocument'
import {
	ENCRYPTED_FIELDS_COMPANY,
	ENCRYPTED_FIELDS_SHOP_OWNER,
	KEY_ALT_NAME_COMPANY,
	KEY_ALT_NAME_SHOP_OWNER
} from '@axiumine/marketplace-common/encryption/encryptedFields'
import { isCiphertext } from '@axiumine/marketplace-common/encryption/isCiphertext'
import { sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The sources call dotenv.config() transitively (MongoDB/Redis datasources, handler); this is a
// belt-and-suspenders load so the REDIS_*/MONGODB_URI values are present at this file's top level.
dotenv.config()

import { ENDPOINT } from '../../src/index.mts'
import { bootServer, db, drainAndClose } from './harness.mts'

const REDIS_KEY = process.env.REDIS_KEY as string

let httpServer: Server
let base: string

/** POST a GraphQL document to the real endpoint and return status + parsed body. */
async function gql(query: string, headers: Record<string, string> = {}) {
	const res = await fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ query })
	})

	return {
		status: res.status,
		// tdwKoaErrorHandler answers rejected requests with {message, description}; Apollo answers
		// accepted ones with {data, errors}. One parse covers both shapes.
		json: (await res.json()) as {
			data?: Record<string, unknown>
			errors?: Array<{ message: string }>
			message?: string
			description?: string
		}
	}
}

/**
 * Seed a real access session on the cluster and hand back both the header and its cleanup.
 * This is the only way in: there is no login and no cookie on this tier — the session is written
 * by public-authorization and only read back here. Pass an `_id` to bind the session to a
 * document this run seeded in MongoDB.
 *
 * The key is also remembered for afterAll: `cleanup()` runs in a `finally`, which does not fire
 * when a seed throws before the `try` — that is how the namespace collected orphan sessions.
 */
async function withSession(_id = new mongoose.Types.ObjectId(), email = 'oste@marketplace.test') {
	const token = `access:${randomUUID()}`
	const key = sessionKey(token)

	seededKeys.push(key)
	// `tier` is what a real login writes and what this service asserts on every request: the auth
	// middleware calls assertTier before ctx.state.user is set, so a tier-less seed is refused with
	// 403 and every test built on this helper fails at the guard instead of reaching its resolver.
	await redisClient.hSet(key, { _id: _id.toHexString(), email, tier: TIER.shopOwner })

	return {
		_id,
		headers: { authorization: `Bearer ${token}` },
		cleanup: () => redisClient.del(key)
	}
}

/****************************************************************************************
 * Seeds. The end-to-end reads need MongoDB to actually hold something owned by the session,
 * so they write a real company to the dev database and delete it again in afterAll.
 ****************************************************************************************/

const seededCompanies: mongoose.Types.ObjectId[] = []
const seededItems: mongoose.Types.ObjectId[] = []
const seededShopOwners: mongoose.Types.ObjectId[] = []
const seededKeys: string[] = []

/**
 * An 11-digit VAT number derived from an id, digits only, unlike the raw hex slice this replaces.
 *
 * ⚠️ `SHAPE_VAT_NUMBER` now runs on `companyAdd`'s real validate layer, so a value carrying `a`-`f` is
 * refused with a 400 before it ever reaches the index this file's duplicate-key test is about.
 *
 * ⚠️ **A per-character `% 10` map was tried first and it collided.** `ObjectId`'s middle bytes are a
 * random value fixed once per process, so every id this suite mints shares the same hex digits there —
 * only the low-order counter varies, one integer step at a time — and mapping each hex digit to a
 * decimal one independently throws bits away (`'a'` and `'0'` both land on `0`), which is exactly the
 * information a `+1` counter step needs to stay visible. A single `BigInt` conversion of the whole id
 * does not have that problem: incrementing the id by one increments this number by one, so consecutive
 * ids almost never share their last 11 decimal digits — the collision would have to be a carry landing
 * on all eleven at once. `padStart` covers the (practically unreachable) case of a decimal value short
 * enough to need it.
 */
function vatNumberOf(id: mongoose.Types.ObjectId): string {
	return BigInt(`0x${id.toHexString()}`).toString().slice(-11).padStart(11, '0')
}

/**
 * The legal seat. GeoJSON order: [longitude, latitude]. Plain JS numbers, not Decimal128.
 */
const ADDRESS_SEED = {
	street: '1 Test Street',
	postalCode: '01103',
	city: 'Springfield',
	province: 'MA',
	position: { type: 'Point', coordinates: [9.57, 45.75] }
}

/**
 * One company, owned by an shopOwner.
 *
 * Inserted with the raw driver rather than the Mongoose model so the seed is checked by the collection's
 * own `$jsonSchema` — `additionalProperties: false`, `vatNumber` exactly 11 characters, `province` exactly
 * 2, `position.coordinates` two in-range doubles.
 *
 * `vatNumber` and `certifiedEmail` both carry globally unique indexes, so both are cut from the document's own `_id` —
 * fixed literals make the second seed of the same run collide.
 */
async function seedCompany(idShopOwner: mongoose.Types.ObjectId) {
	const _id = new mongoose.Types.ObjectId()
	const legalName = `Itest Boutique ${randomUUID()}`

	// ⚠️ Encrypted before the insert, not after (ADR-029). `contactPerson` and `administrator` are
	// named people, so what the collection holds for them is `binData` subtype 6 — a seed that wrote
	// plaintext would be a document no resolver on the platform can produce, and every read below
	// would be asserting against a shape production never has.
	await db()
		.collection('company')
		.insertOne(
			await encryptDocument(
				{
					_id,
					idShopOwner,
					legalName,
					vatNumber: vatNumberOf(_id),
					contactPerson: 'Itest ContactPerson',
					administrator: 'Itest Administrator',
					certifiedEmail: `itest-${_id.toHexString()}@certifiedEmail.invalid`,
					address: ADDRESS_SEED,
					registryExtract: 'itest-registryExtract',
					// `published` is in the collection's `required` list since 20260804010000-alter-company-public,
					// so a seed without it is rejected outright — the migration widened, backfilled and only then
					// demanded the field, and this fixture predates all three steps. False is the honest value: the
					// public face is a separate concern from the legal entity these tests exercise, and a false flag
					// is exactly what `companyAdd` writes. `publicName` and `slug` stay off deliberately — the
					// collection's `$expr` demands them only of a published company, and `slug` carries a unique index
					// that a fixed literal would collide on.
					published: false
				},
				ENCRYPTED_FIELDS_COMPANY,
				KEY_ALT_NAME_COMPANY
			)
		)
	seededCompanies.push(_id)

	return { _id, legalName }
}

/**
 * One item, hanging off a company.
 *
 * The raw driver again, so the seed is checked by `item`'s own `$jsonSchema` — `additionalProperties:
 * false`, `name` at most 150, `slug` matching the URL grammar and unique per company. Nothing on this
 * collection is encrypted: an item is a catalogue entry, not a person.
 *
 * `idCategory` is a fresh id pointing at nothing. The reference is required and unenforced, and the
 * mutation under test never reads it — the guards this file exercises traverse `idCompany`.
 */
async function seedItem(idCompany: mongoose.Types.ObjectId, published = false) {
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('item')
		.insertOne({
			_id,
			idCompany,
			idCategory: new mongoose.Types.ObjectId(),
			name: 'Itest Item',
			description: 'Seeded by the integration suite',
			slug: `itest-${_id.toHexString()}`,
			published
		})
	seededItems.push(_id)

	return _id
}

/**
 * One shop owner, and the account the self-closure actually writes to.
 *
 * The raw driver again, so the seed is checked by `shopOwner`'s own `$jsonSchema`: `login` and
 * `registeredAt` are the whole `required` list — `personalData` stopped being required when shop owners
 * became able to sign themselves up — and `login.password` is a bcrypt hash, which the validator pins at
 * exactly 60 characters. Nothing here ever logs in, so any 60 characters do.
 *
 * ⚠️ Encrypted before the insert (ADR-029): `login.email` is deterministic ciphertext and carries the
 * platform's one globally unique index, so it is cut from the document's own `_id` — a fixed literal
 * collides with the second seed of the same run, and with the leftovers of a run that died mid-drain.
 *
 * The approval gate is deliberately absent from the seed. This tier may not name that field at all — BC-03
 * bans the identifier repo-wide, eslint included — so a fixture that set it could not be written here, and
 * a closure that cleared it could not be written either. The admin's queue filters closed accounts out
 * by `deleted` regardless.
 */
async function seedShopOwner(over: Record<string, unknown> = {}) {
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('shopOwner')
		.insertOne(
			await encryptDocument(
				{
					_id,
					login: { email: `itest-${_id.toHexString()}@shopowner.invalid`, password: 'x'.repeat(60) },
					registeredAt: new Date(),
					...over
				},
				ENCRYPTED_FIELDS_SHOP_OWNER,
				KEY_ALT_NAME_SHOP_OWNER
			)
		)
	seededShopOwners.push(_id)

	return _id
}

beforeAll(async () => {
	;({ httpServer, base } = await bootServer())
})

// Drop whatever this run created while the handles are still open: documents, then every session key.
afterAll(() =>
	drainAndClose(httpServer, {
		companies: seededCompanies,
		items: seededItems,
		shopOwners: seededShopOwners,
		keys: seededKeys
	})
)

describe('authenticated-resource service (integration, real MongoDB + real Redis cluster)', () => {
	// start() is what wires both datasources and arms ClamAV; asserting the live handles is what
	// makes the rest of this file an integration suite rather than an in-process schema test.
	it('has a live MongoDB connection', () => {
		expect(mongoose.connection.readyState).toBe(1)
	})

	it('has a live Redis cluster connection, round-tripping a key in the isolated namespace', async () => {
		const key = `${REDIS_KEY}ping:${randomUUID()}`

		// EX so this one cannot outlive the run. It is never registered for the afterAll drain, so
		// without a TTL a hard kill — or a throw on the assertion below — strands it on the cluster
		// forever. 60s is far longer than the round trip and short enough to be self-cleaning.
		await redisClient.set(key, 'pong', { EX: 60 })
		expect(await redisClient.get(key)).toBe('pong')

		await redisClient.del(key)
		expect(await redisClient.get(key)).toBeNull()
	})
})

describe('bearer-token gate over HTTP', () => {
	const query = '{ shopOwnerCompanies { _id } }'

	it('answers 412 when the request carries no authorization header', async () => {
		const { status, json } = await gql(query)

		expect(status).toBe(412)
		expect(json.message).toBe('Precondition Failed')
	})

	it('answers 499 when the header does not use the `Bearer access:` scheme', async () => {
		const { status, json } = await gql(query, { authorization: `Bearer ${randomUUID()}` })

		expect(status).toBe(499)
		expect(json.message).toBe('Token Required')
	})

	it('answers 498 when the session is not on the cluster', async () => {
		const { status, json } = await gql(query, { authorization: `Bearer access:${randomUUID()}` })

		expect(status).toBe(498)
		expect(json.message).toBe('Invalid Token')
	})
})

describe('GraphQL over HTTP', () => {
	// The company list the shop form used to pick from, straight off the real collection. Same
	// ownership filter throughout this tier, and the negative half below is what proves the filter
	// is doing the work.
	it('lists the companies of the authenticated shopOwner, and only those', async () => {
		const session = await withSession()
		const stranger = await withSession()
		const company = await seedCompany(session._id)
		await seedCompany(stranger._id)

		try {
			const query = '{ shopOwnerCompanies { _id legalName taxCode uniqueCode address { city } } }'
			const { json } = await gql(query, session.headers)

			expect(json.errors).toBeUndefined()
			// `taxCode` and `uniqueCode` are the two nullable fields on the type and the seed omits both: they
			// come back null rather than failing the read, which is what the collection allows.
			expect(json.data?.shopOwnerCompanies).toEqual([
				{
					_id: company._id.toHexString(),
					legalName: company.legalName,
					taxCode: null,
					uniqueCode: null,
					address: { city: ADDRESS_SEED.city }
				}
			])
		} finally {
			await session.cleanup()
			await stranger.cleanup()
		}
	})

	// ADR-029, end to end and in both directions: what the collection holds for the two named people
	// on a company, and what the resolver hands back for the same document. `.lean()` is the shape
	// worth pinning — the read hook runs on the plain object mongoose never wrapped in a document, so
	// this is the query that would quietly return `Binary` if the plugin were dropped from the model.
	it('stores contactPerson and administrator as ciphertext, and reads them back in the clear', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)

		try {
			const raw = await db().collection('company').findOne({ _id: company._id })
			// isCiphertext() is `binData` AND subtype 6, not "is a Binary": every other subtype would mean
			// the value went in as something other than a CSFLE payload.
			expect(isCiphertext(raw?.contactPerson)).toBe(true)
			expect(isCiphertext(raw?.administrator)).toBe(true)
			// Random, not deterministic: neither field is ever a query filter, so two companies sharing a
			// contact person must not share a ciphertext. Nothing else in this suite would notice the
			// algorithm being switched.
			const other = await seedCompany(session._id)
			const otherRaw = await db().collection('company').findOne({ _id: other._id })
			expect(otherRaw?.contactPerson).not.toEqual(raw?.contactPerson)

			await decryptDocument(raw)
			expect(raw?.contactPerson).toBe('Itest ContactPerson')
			expect(raw?.administrator).toBe('Itest Administrator')

			const { json } = await gql('{ shopOwnerCompanies { _id contactPerson administrator } }', session.headers)

			expect(json.errors).toBeUndefined()
			expect(json.data?.shopOwnerCompanies).toContainEqual({
				_id: company._id.toHexString(),
				contactPerson: 'Itest ContactPerson',
				administrator: 'Itest Administrator'
			})
		} finally {
			await session.cleanup()
		}
	})

	// Introspection stays open outside production (buildValidationRules returns no rules), and the
	// schema it reports is the one really assembled in createServer — not a copy rebuilt by a test.
	// It still travels the ordinary way in: every request to this service carries a session or is
	// refused before Apollo sees it.
	it('exposes the assembled schema to an authenticated caller', async () => {
		const session = await withSession()

		try {
			const { status, json } = await gql('{ __schema { queryType { name } mutationType { name } } }', session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data).toEqual({
				__schema: { queryType: { name: 'QueriesApi' }, mutationType: { name: 'MutationsApi' } }
			})
		} finally {
			await session.cleanup()
		}
	})

	it('rejects a GET on the GraphQL endpoint (csrfPrevention / method not allowed)', async () => {
		const session = await withSession()

		try {
			const res = await fetch(`${base}${ENDPOINT}?query=%7B__typename%7D`, { headers: session.headers })

			expect(res.status).toBeGreaterThanOrEqual(400)
		} finally {
			await session.cleanup()
		}
	})
})

/*
 * `companyDel` retires a company instead of removing it, so every assertion here is about a document that
 * is still on disk. Unit tests mock the model and cannot see any of it: that `trusted({ $exists: false })`
 * survives the global `sanitizeFilter` is a driver-level fact, and so is the collection's reaction to a
 * `$set` of a field the validator only recently gained.
 *
 * `vatNumber` and `certifiedEmail` carry plain global unique indexes — no `partialFilterExpression` — so a retired
 * company keeps its VAT number occupied. That is a decision, not an oversight, and the last case here
 * pins it: the same VAT number cannot be registered again after the retirement.
 */
describe('companyDel (soft delete against the real collection)', () => {
	it('stamps deleted and keeps the document', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)
		const before = new Date()

		try {
			const { json } = await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)

			expect(json.errors).toBeUndefined()
			expect(json.data?.companyDel).toBe(true)

			const after = await db().collection('company').findOne({ _id: company._id })
			// The document survives, which is the whole point, and the rest of it is untouched. `Date.now()`
			// is a number — mongoose casts it to the `deleted` path — so a cast that stopped happening
			// would store an int the validator refuses and `toBeInstanceOf` would catch what a truthy
			// check would not.
			expect(after).not.toBeNull()
			expect(after?.deleted).toBeInstanceOf(Date)
			expect((after?.deleted as Date).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
			expect(after?.legalName).toBe(company.legalName)
			expect(after?.idShopOwner).toEqual(session._id)
		} finally {
			await session.cleanup()
		}
	})

	// The read side of the same stamp: the company disappears from the list that draws the shop form's
	// company picker, without disappearing from the database.
	it('drops the company out of shopOwnerCompanies', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)

		try {
			await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)
			const { json } = await gql('{ shopOwnerCompanies { _id } }', session.headers)

			expect(json.errors).toBeUndefined()
			expect(json.data?.shopOwnerCompanies).toEqual([])
			expect(await db().collection('company').countDocuments({ _id: company._id })).toBe(1)
		} finally {
			await session.cleanup()
		}
	})

	// The consequence of leaving `vatNumber_unique` a plain global index. The index is what refuses the
	// second registration, and it only exists on the collection — no unit test of `companyAdd` can
	// reach it. `certifiedEmail` is deliberately different so the collision can only be the VAT number.
	it('leaves the VAT number registered, so the same one cannot be added again', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)
		const vatNumber = vatNumberOf(company._id)

		try {
			await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)

			const { json } = await gql(
				`mutation { companyAdd(company: { legalName: "Itest Refetched", vatNumber: "${vatNumber}", contactPerson: "Itest ContactPerson", administrator: "Itest Administrator", certifiedEmail: "itest-${randomUUID()}@certifiedEmail.invalid", registryExtract: "itest-registryExtract", address: { street: "1 Test Street", postalCode: "01103", city: "Springfield", province: "MA", position: { type: "Point", coordinates: [9.57, 45.75] } } }) { _id } }`,
				session.headers
			)

			expect(json.errors?.[0]?.message).toBe('Conflict')
			expect(await db().collection('company').countDocuments({ vatNumber })).toBe(1)
		} finally {
			await session.cleanup()
		}
	})

	// The ownership guard filters `deleted` as well, so the second call cannot tell a retired company
	// from somebody else's: it answers Forbidden rather than re-stamping. Asserting the instant did not
	// move is what separates "refused" from "silently applied twice".
	it('answers Forbidden on a company it already retired', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)

		try {
			await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)
			const first = (await db().collection('company').findOne({ _id: company._id }))?.deleted as Date

			const { json } = await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)

			expect(json.errors?.[0]?.message).toBe('Forbidden')
			expect((await db().collection('company').findOne({ _id: company._id }))?.deleted).toEqual(first)
		} finally {
			await session.cleanup()
		}
	})
})

/**
 * Publishing is its own mutation on this tier, and the rule that decides whether it may succeed lives
 * in the collection rather than in any resolver: `PUBLISHED_IMPLIES_LINKABLE`, the `$expr` clause that
 * refuses `published: true` without both a `slug` and a `publicName`. No unit test can reach it — the
 * model is mocked there — which is the same reason `vatNumber_unique` is exercised here.
 */
describe('companyUpdatePublished (the publish rule against the real collection)', () => {
	const publish = (id: string, published: boolean, headers: Record<string, string>) =>
		gql(`mutation { companyUpdatePublished(_id: "${id}", published: ${published}) }`, headers)

	// A shop that has not been named cannot be published, and the refusal has to leave the flag alone
	// rather than half-apply. `seedCompany` writes neither `slug` nor `publicName`, so this is the state
	// every company is in the moment `companyAdd` creates it.
	it('refuses to publish a company with no slug and no publicName, and leaves the flag false', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)
		const _id = company._id.toHexString()

		try {
			const { json } = await publish(_id, true, session.headers)

			expect(json.errors).toBeDefined()
			expect(await db().collection('company').findOne({ _id: company._id })).toMatchObject({ published: false })
		} finally {
			await session.cleanup()
		}
	})

	// Named first, published second — and both directions, because taking a shop off the site is the
	// same mutation with the flag the other way round and the `$expr` has nothing to say about `false`.
	// The two fields go in with the raw driver: what is under test is the publish call, not the save.
	it('publishes and unpublishes a company that carries both, without touching the rest of the card', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)
		const _id = company._id.toHexString()

		try {
			await db()
				.collection('company')
				.updateOne({ _id: company._id }, { $set: { publicName: 'Itest Shop', slug: `itest-${randomUUID()}` } })

			const published = await publish(_id, true, session.headers)
			expect(published.json.errors).toBeUndefined()
			expect(await db().collection('company').findOne({ _id: company._id })).toMatchObject({ published: true })

			const withdrawn = await publish(_id, false, session.headers)
			expect(withdrawn.json.errors).toBeUndefined()

			// The legal card is asserted untouched on the way back out: this mutation writes one field,
			// so a regression that widened it into a save would show up here as a lost `registryExtract`.
			expect(await db().collection('company').findOne({ _id: company._id })).toMatchObject({
				published: false,
				legalName: company.legalName,
				registryExtract: 'itest-registryExtract'
			})
		} finally {
			await session.cleanup()
		}
	})
})

describe('itemsUpdatePublished (the bulk publish against the real collections)', () => {
	const bulkPublish = (ids: mongoose.Types.ObjectId[], published: boolean, headers: Record<string, string>) =>
		gql(
			`mutation { itemsUpdatePublished(_ids: [${ids.map((_id) => `"${_id.toHexString()}"`).join(', ')}], published: ${published}) }`,
			headers
		)

	const publishedFlags = async (ids: mongoose.Types.ObjectId[]) =>
		await Promise.all(ids.map(async (_id) => (await db().collection('item').findOne({ _id }))?.published))

	/*
	 * ⚠️ The one thing no unit test can prove: that the `$in` clauses actually match. `sanitizeFilter` is
	 * on process-wide, and an unwrapped `$`-keyed value is rewritten to `{ $eq: … }` — which matches
	 * nothing, for ever, while every call reports success. Against a real collection the same mistake is a
	 * `matchedCount` of zero and a 500, which is what makes this test the proof and the mocked ones the
	 * explanation.
	 */
	it('publishes a whole list in one call, and withdraws it again', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)
		const items = [await seedItem(company._id), await seedItem(company._id), await seedItem(company._id)]

		try {
			const published = await bulkPublish(items, true, session.headers)
			expect(published.json.errors).toBeUndefined()
			expect(published.json.data).toEqual({ itemsUpdatePublished: true })
			expect(await publishedFlags(items)).toEqual([true, true, true])

			const withdrawn = await bulkPublish(items, false, session.headers)
			expect(withdrawn.json.errors).toBeUndefined()
			expect(await publishedFlags(items)).toEqual([false, false, false])
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ⚠️ All or nothing, against real data: two of the owner's own items and one stranger's, and the two
	 * that were legitimate must come back untouched. A guard that counted `found > 0` — or a write that
	 * simply applied to whatever matched — passes every mocked test and fails here, with the owner's own
	 * two cards published by a call that was refused.
	 */
	it('refuses the whole list for one foreign id, and leaves every flag where it was', async () => {
		const session = await withSession()
		const stranger = await withSession()
		const company = await seedCompany(session._id)
		const foreignCompany = await seedCompany(stranger._id)
		const mine = [await seedItem(company._id), await seedItem(company._id)]
		const theirs = await seedItem(foreignCompany._id)

		try {
			const { json } = await bulkPublish([...mine, theirs], true, session.headers)

			expect(json.errors?.[0].message).toBe('Forbidden')
			expect(await publishedFlags([...mine, theirs])).toEqual([false, false, false])
		} finally {
			await session.cleanup()
			await stranger.cleanup()
		}
	})

	/*
	 * The `deleted` clause of the guard, which is the difference between "not yours" and "gone": a
	 * withdrawn item is absent from `companyItems`, so the only way to name one is an id a client kept
	 * from before, and the answer has to be the same 403 a stranger's id gets.
	 */
	it('refuses a list carrying an item the owner has already withdrawn', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)
		const live = await seedItem(company._id)
		const retired = await seedItem(company._id)

		try {
			await db()
				.collection('item')
				.updateOne({ _id: retired }, { $set: { deleted: new Date() } })

			const { json } = await bulkPublish([live, retired], true, session.headers)

			expect(json.errors?.[0].message).toBe('Forbidden')
			expect(await publishedFlags([live])).toEqual([false])
		} finally {
			await session.cleanup()
		}
	})

	// The 400 half, end to end: GraphQL accepts `[]` against `[ID!]!`, so the refusal is the resolver's
	// and it has to reach the client as a request error rather than a quiet success.
	it('refuses an empty selection', async () => {
		const session = await withSession()

		try {
			const { json } = await bulkPublish([], true, session.headers)

			expect(json.errors?.[0].message).toBe('Bad Request')
		} finally {
			await session.cleanup()
		}
	})
})

describe('shopOwnerDel (the owner closing their own account, against the real collections)', () => {
	const CLOSE = 'mutation { shopOwnerDel }'

	const shopOwnerDoc = async (_id: mongoose.Types.ObjectId) => await db().collection('shopOwner').findOne({ _id })

	/*
	 * ⚠️ **The stamp and the cascade, in one call and in one transaction.** A closed owner whose shop is
	 * still on the public site is the single failure ADR-045 exists to prevent, and it is not a shape any
	 * mocked test can rule out: the cascade's `$in` runs against real ciphertext-bearing documents, and an
	 * unwrapped `$`-keyed filter would be rewritten by the global `sanitizeFilter` into a match on nothing
	 * — every item left published, and every assertion but this one still green.
	 */
	it('stamps the account and darkens every company and item', async () => {
		const owner = await seedShopOwner()
		const session = await withSession(owner)
		const company = await seedCompany(owner)
		const item = await seedItem(company._id, true)

		// On air the only way the collection allows: `PUBLISHED_IMPLIES_LINKABLE` refuses `published: true`
		// without both a `slug` and a `publicName`, and `seedCompany` writes neither. The slug is a fresh
		// UUID because it carries a unique index, exactly as the publish suite above does it.
		await db()
			.collection('company')
			.updateOne(
				{ _id: company._id },
				{ $set: { published: true, publicName: 'Itest Storefront', slug: `itest-${randomUUID()}` } }
			)

		const { json } = await gql(CLOSE, session.headers)

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ shopOwnerDel: true })

		const doc = await shopOwnerDoc(owner)

		expect(doc?.deleted).toBeInstanceOf(Date)
		expect((await db().collection('company').findOne({ _id: company._id }))?.published).toBe(false)
		expect((await db().collection('item').findOne({ _id: item }))?.published).toBe(false)
	})

	/*
	 * ⚠️ **No `deletedBy`, and the absence is the whole record** (ADR-044). `deleted` standing alone is what
	 * says the account holder closed it themselves; an id written here — the owner's own included — makes a
	 * self-closure indistinguishable from an admin's, which is the distinction the retention work and the
	 * admin console both read.
	 */
	it('names no actor, which is what makes it a self-closure', async () => {
		const owner = await seedShopOwner()
		const session = await withSession(owner)

		await gql(CLOSE, session.headers)

		expect(await shopOwnerDoc(owner)).not.toHaveProperty('deletedBy')
	})

	/*
	 * ⚠️ **A standing suspension survives the closure, in both directions.** Clearing it would let anyone
	 * launder one by closing and registering again inside the thirty-day undo window; raising one would hand
	 * the owner's own way back to an admin, since only the Admin tier lifts a suspension. The seed carries
	 * the reason the collection's `dependencies` rule demands of every suspended document.
	 */
	it('leaves a suspension exactly as it found it', async () => {
		const owner = await seedShopOwner({ disabled: true, disabledReason: 'suspended by the admin before the close' })
		const session = await withSession(owner)

		const { json } = await gql(CLOSE, session.headers)

		expect(json.errors).toBeUndefined()

		const doc = await shopOwnerDoc(owner)

		expect(doc?.disabled).toBe(true)
		expect(doc?.deleted).toBeInstanceOf(Date)
	})

	/*
	 * The revoke, end to end: the token that closed the account is refused by the bearer gate on the very
	 * next request. 498 rather than 403 — the session key is gone from the cluster, not merely rejected —
	 * which is what says the closure ended the session rather than the resolver declining to serve it.
	 */
	it('leaves the caller signed out of the session it was called with', async () => {
		const owner = await seedShopOwner()
		const session = await withSession(owner)

		await gql(CLOSE, session.headers)

		const { status, json } = await gql('{ shopOwnerCompanies { _id } }', session.headers)

		expect(status).toBe(498)
		expect(json.message).toBe('Invalid Token')
	})

	/*
	 * ⚠️ **The second close is refused rather than allowed to restamp.** `deleted` is what the hourly sweep
	 * measures from and what ADR-046 turns into a thirty-day undo window, so a second stamp would push the
	 * scrub thirty days out and postpone the erasure the first one promised. The second session is seeded
	 * before the first call, because the first ends the one it was made with — this is the narrow window the
	 * 410 exists for.
	 */
	it('answers 410 to a second close, and leaves the first stamp where it is', async () => {
		const owner = await seedShopOwner()
		const first = await withSession(owner)
		const second = await withSession(owner)

		await gql(CLOSE, first.headers)
		const stamped = (await shopOwnerDoc(owner))?.deleted

		try {
			const { json } = await gql(CLOSE, second.headers)

			expect(json.errors?.[0].message).toBe('Oops')
			expect((await shopOwnerDoc(owner))?.deleted).toEqual(stamped)
		} finally {
			await second.cleanup()
		}
	})

	// The other refusal: a session naming an account that is not in the collection at all. `withSession`
	// mints a free id when it is given none, which is exactly that shape.
	it('answers 401 when the session names no document', async () => {
		const session = await withSession()

		try {
			const { json } = await gql(CLOSE, session.headers)

			expect(json.errors?.[0].message).toBe('Unauthorized')
		} finally {
			await session.cleanup()
		}
	})
})

describe('non-GraphQL routes', () => {
	it('serves /health once the bearer gate is satisfied', async () => {
		const session = await withSession()

		try {
			const res = await fetch(`${base}/health`, { headers: session.headers })

			expect(res.status).toBe(200)
			const json = (await res.json()) as { status: string; timestamp: string }
			expect(json.status).toBe('OK')
		} finally {
			await session.cleanup()
		}
	})

	it('falls through to 404 for an unknown path', async () => {
		const session = await withSession()

		try {
			const res = await fetch(`${base}/nope`, { headers: session.headers })

			expect(res.status).toBe(404)
		} finally {
			await session.cleanup()
		}
	})
})
