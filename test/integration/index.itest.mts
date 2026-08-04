import { randomUUID } from 'node:crypto'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
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
const INTROSPECTION_CODE = process.env.INTROSPECTION_CODE as string

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
	const key = `${REDIS_KEY}${token}`

	seededKeys.push(key)
	await redisClient.hSet(key, { _id: _id.toHexString(), email })

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
const seededKeys: string[] = []

/**
 * The legal seat. GeoJSON order: [longitude, latitude]. Plain JS numbers, not Decimal128.
 */
const ADDRESS_SEED = {
	street: 'Via Test 1',
	postalCode: '24031',
	city: 'Almenno San Salvatore',
	province: 'BG',
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
	const legalName = `Itest Pizzeria ${randomUUID()}`

	await db()
		.collection('company')
		.insertOne({
			_id,
			idShopOwner,
			legalName,
			vatNumber: _id.toHexString().slice(-11),
			contactPerson: 'Itest ContactPerson',
			administrator: 'Itest Administrator',
			certifiedEmail: `itest-${_id.toHexString()}@certifiedEmail.invalid`,
			address: ADDRESS_SEED,
			registryExtract: 'itest-registryExtract'
		})
	seededCompanies.push(_id)

	return { _id, legalName }
}

beforeAll(async () => {
	;({ httpServer, base } = await bootServer())
})

// Drop whatever this run created while the handles are still open: documents, then every session key.
afterAll(() => drainAndClose(httpServer, { companies: seededCompanies, keys: seededKeys }))

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

	// Introspection stays open outside production (buildValidationRules returns no rules), and the
	// schema it reports is the one really assembled in createServer — not a copy rebuilt by a test.
	it('exposes the assembled schema to a caller carrying the introspection code', async () => {
		const { status, json } = await gql('{ __schema { queryType { name } mutationType { name } } }', {
			'x-introspectioncode': INTROSPECTION_CODE
		})

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({
			__schema: { queryType: { name: 'QueriesApi' }, mutationType: { name: 'MutationsApi' } }
		})
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
 * `companyDel` retires a company instead of removing it, so every assertion here is about a row that
 * is still on disk. Unit tests mock the model and cannot see any of it: that `trusted({ $exists: false })`
 * survives the global `sanitizeFilter` is a driver-level fact, and so is the collection's reaction to a
 * `$set` of a field the validator only recently gained.
 *
 * `vatNumber` and `certifiedEmail` carry plain global unique indexes — no `partialFilterExpression` — so a retired
 * company keeps its partita IVA occupied. That is a decision, not an oversight, and the last case here
 * pins it: the same VAT number cannot be registered again after the retirement.
 */
describe('companyDel (soft delete against the real collection)', () => {
	it('stamps deleted and keeps the row', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)
		const before = new Date()

		try {
			const { json } = await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)

			expect(json.errors).toBeUndefined()
			expect(json.data?.companyDel).toBe(true)

			const after = await db().collection('company').findOne({ _id: company._id })
			// The row survives, which is the whole point, and the rest of it is untouched. `Date.now()`
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
	// reach it. `certifiedEmail` is deliberately different so the collision can only be the partita IVA.
	it('leaves the partita IVA registered, so the same one cannot be added again', async () => {
		const session = await withSession()
		const company = await seedCompany(session._id)
		const vatNumber = company._id.toHexString().slice(-11)

		try {
			await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)

			const { json } = await gql(
				`mutation { companyAdd(company: { legalName: "Itest Ripescata", vatNumber: "${vatNumber}", contactPerson: "Itest ContactPerson", administrator: "Itest Administrator", certifiedEmail: "itest-${randomUUID()}@certifiedEmail.invalid", registryExtract: "itest-registryExtract", address: { street: "Via Test 1", postalCode: "24031", city: "Almenno San Salvatore", province: "BG", position: { type: "Point", coordinates: [9.57, 45.75] } } }) { _id } }`,
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
