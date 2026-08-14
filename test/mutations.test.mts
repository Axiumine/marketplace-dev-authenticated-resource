import { GraphQLError } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextShopOwnerAuthenticatedResource } from '../src/lib/auth/IContextShopOwnerAuthenticatedResource.mts'

const captureException = vi.fn()

const companyCreate = vi.fn()
const throwIfShopOwnerDontOwnCompany = vi.fn()
const funCompanyDelete = vi.fn()
const funCompanyUpdate = vi.fn()
const funCompanyUpdatePublished = vi.fn()

// tryCatchRethrow is deliberately NOT mocked: turning a driver error into the right GraphQL status
// is the behaviour under test here. Only Sentry is stubbed, so its `else` branch stays silent.
vi.mock('@sentry/node', () => ({ captureException, captureMessage: vi.fn() }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Company', () => ({
	Company: { create: companyCreate }
}))
vi.mock('@lib/company/throwIfShopOwnerDontOwnCompany.mjs', () => ({ throwIfShopOwnerDontOwnCompany }))
vi.mock('@lib/company/funCompanyDelete.mjs', () => ({ funCompanyDelete }))
vi.mock('@lib/company/funCompanyUpdate.mjs', () => ({ funCompanyUpdate }))
vi.mock('@lib/company/funCompanyUpdatePublished.mjs', () => ({ funCompanyUpdatePublished }))

const { companyAdd } = await import('../src/graphQLApi/schema/mutations/companyAdd.mts')
const { companyDel } = await import('../src/graphQLApi/schema/mutations/companyDel.mts')
const { companyUpdate } = await import('../src/graphQLApi/schema/mutations/companyUpdate.mts')
const { companyUpdatePublished } = await import('../src/graphQLApi/schema/mutations/companyUpdatePublished.mts')

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
const idCompany = new Types.ObjectId('507f1f77bcf86cd799439015')

const ctx = { state: { user: { _id: userId } } } as unknown as IContextShopOwnerAuthenticatedResource

/** Anything not a Mongo duplicate-key / [Validator] error ends up a 500 through tryCatchRethrow. */
const driverError = new Error('connection reset')

type Resolver = { resolve: (...a: never[]) => unknown }

function run(mutation: Resolver, args: unknown) {
	return mutation.resolve(null as never, args as never, ctx as never)
}

beforeEach(() => {
	vi.clearAllMocks()
	companyCreate.mockResolvedValue({ _id: idCompany })
	throwIfShopOwnerDontOwnCompany.mockResolvedValue(undefined)
	funCompanyDelete.mockResolvedValue(undefined)
	funCompanyUpdate.mockResolvedValue(undefined)
	funCompanyUpdatePublished.mockResolvedValue(undefined)
})

describe('companyAdd', () => {
	const args = { company: { legalName: 'Test Boutique Ltd', vatNumber: '01234567890' } }

	// The owner comes from the session, never from the input. Unlike every other write here there is
	// no ownership guard to run first — the company does not exist yet, so `idShopOwner` is what
	// establishes the ownership rather than what is checked.
	it('stamps the caller as owner and creates the company', async () => {
		await expect(run(companyAdd, args)).resolves.toEqual({ _id: idCompany })

		const [doc] = companyCreate.mock.calls[0]
		expect(doc).toMatchObject({ idShopOwner: userId, ...args.company })
		expect(doc._id).toBeInstanceOf(Types.ObjectId)
		expect(throwIfShopOwnerDontOwnCompany).not.toHaveBeenCalled()
	})

	// `published` left `GraphQLInputCompany` when publishing became `companyUpdatePublished`, so the
	// resolver writes the flag itself — it is `required` on the collection. `false` is also the only
	// value that could work here: the validator refuses a published shop without a `slug` and a
	// `publicName`, and this input carries neither.
	it('stamps the new company as an unpublished draft', async () => {
		await run(companyAdd, args)

		const [doc] = companyCreate.mock.calls[0]
		expect(doc.published).toBe(false)
	})

	// `vatNumber_unique` is global, so a VAT number already used by another owner's company fails here —
	// and has to reach this one as a 409, not as the 500 every other write failure becomes. The code
	// sits under `errorResponse` because that is where `throwIfMongoErr` reads it, not at the top level.
	it('turns a duplicate VAT number into a 409', async () => {
		companyCreate.mockRejectedValueOnce(
			Object.assign(new Error('E11000 duplicate key error collection: company index: vatNumber_unique'), {
				errorResponse: { code: 11000 }
			})
		)

		await expect(run(companyAdd, args)).rejects.toMatchObject({
			message: 'Conflict',
			extensions: { http: { status: 409 } }
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		companyCreate.mockRejectedValueOnce(driverError)

		await expect(run(companyAdd, args)).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})

describe('companyUpdate', () => {
	const args = { _id: idCompany, company: { legalName: 'Test Boutique Ltd', vatNumber: '01234567890' } }

	it('checks ownership then delegates the save and answers true', async () => {
		await expect(run(companyUpdate, args)).resolves.toBe(true)

		expect(throwIfShopOwnerDontOwnCompany).toHaveBeenCalledExactlyOnceWith(userId, idCompany)
		expect(funCompanyUpdate).toHaveBeenCalledExactlyOnceWith(idCompany, userId, args.company)
	})

	// The guard runs *before* the write, so a company belonging to someone else is never touched —
	// its 403 has to come back out untouched too, not flattened into a 500 by the catch.
	it('does not write when the caller does not own the company', async () => {
		throwIfShopOwnerDontOwnCompany.mockRejectedValueOnce(
			new GraphQLError('Forbidden', { extensions: { http: { status: 403 } } })
		)

		await expect(run(companyUpdate, args)).rejects.toMatchObject({
			message: 'Forbidden',
			extensions: { http: { status: 403 } }
		})
		expect(funCompanyUpdate).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		funCompanyUpdate.mockRejectedValueOnce(driverError)

		await expect(run(companyUpdate, args)).rejects.toThrow('Internal Server Error')
	})
})

describe('companyUpdatePublished', () => {
	const args = { _id: idCompany, published: true }

	// The same ownership guard `companyUpdate` runs, and then one flag: no input object, nothing else
	// written. That separation is the point — an owner saving the card of a shop an operator has just
	// taken down no longer puts it back.
	it('checks ownership then delegates the flag and answers true', async () => {
		await expect(run(companyUpdatePublished, args)).resolves.toBe(true)

		expect(throwIfShopOwnerDontOwnCompany).toHaveBeenCalledExactlyOnceWith(userId, idCompany)
		expect(funCompanyUpdatePublished).toHaveBeenCalledExactlyOnceWith(idCompany, userId, true)
		expect(funCompanyUpdate).not.toHaveBeenCalled()
	})

	it('passes false through unchanged when the owner takes the shop off the site', async () => {
		await expect(run(companyUpdatePublished, { _id: idCompany, published: false })).resolves.toBe(true)

		expect(funCompanyUpdatePublished).toHaveBeenCalledExactlyOnceWith(idCompany, userId, false)
	})

	it('does not write when the caller does not own the company', async () => {
		throwIfShopOwnerDontOwnCompany.mockRejectedValueOnce(
			new GraphQLError('Forbidden', { extensions: { http: { status: 403 } } })
		)

		await expect(run(companyUpdatePublished, args)).rejects.toMatchObject({ message: 'Forbidden' })
		expect(funCompanyUpdatePublished).not.toHaveBeenCalled()
	})

	// The one this mutation really needs: publishing a shop with no `slug` or `publicName` is refused by
	// the collection's `$expr`, and that refusal has to reach the client as itself rather than as a 500.
	it('keeps a downstream GraphQL error instead of flattening it', async () => {
		funCompanyUpdatePublished.mockRejectedValueOnce(new GraphQLError('Conflict', { extensions: { http: { status: 409 } } }))

		await expect(run(companyUpdatePublished, args)).rejects.toMatchObject({
			message: 'Conflict',
			extensions: { http: { status: 409 } }
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		funCompanyUpdatePublished.mockRejectedValueOnce(driverError)

		await expect(run(companyUpdatePublished, args)).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})

describe('companyDel', () => {
	it('checks ownership then delegates the delete and answers true', async () => {
		await expect(run(companyDel, { _id: idCompany })).resolves.toBe(true)

		expect(throwIfShopOwnerDontOwnCompany).toHaveBeenCalledExactlyOnceWith(userId, idCompany)
		expect(funCompanyDelete).toHaveBeenCalledExactlyOnceWith(idCompany, userId)
	})

	it('does not delete when the caller does not own the company', async () => {
		throwIfShopOwnerDontOwnCompany.mockRejectedValueOnce(
			new GraphQLError('Forbidden', { extensions: { http: { status: 403 } } })
		)

		await expect(run(companyDel, { _id: idCompany })).rejects.toMatchObject({ message: 'Forbidden' })
		expect(funCompanyDelete).not.toHaveBeenCalled()
	})

	// A GraphQLError raised downstream of the ownership guard keeps its status instead of being
	// flattened to a 500 — that is the whole reason the catch goes through tryCatchRethrow.
	it('keeps a downstream GraphQL error instead of flattening it', async () => {
		funCompanyDelete.mockRejectedValueOnce(new GraphQLError('Conflict', { extensions: { http: { status: 409 } } }))

		await expect(run(companyDel, { _id: idCompany })).rejects.toMatchObject({
			message: 'Conflict',
			extensions: { http: { status: 409 } }
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		funCompanyDelete.mockRejectedValueOnce(driverError)

		await expect(run(companyDel, { _id: idCompany })).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})
