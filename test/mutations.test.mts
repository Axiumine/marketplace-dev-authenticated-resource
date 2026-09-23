import { GraphQLError } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ctx, driverError, ID_COMPANY, run, SHOP_OWNER_ID } from './shopOwnerResolverHarness.mts'

const captureException = vi.fn()

const companyCreate = vi.fn()
const throwIfShopOwnerDontOwnCompany = vi.fn()
const funCompanyDelete = vi.fn()
const funCompanyUpdate = vi.fn()
const funCompanyUpdatePublished = vi.fn()
const funShopOwnerDel = vi.fn()
const endEverySession = vi.fn()

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
vi.mock('@lib/shopOwner/funShopOwnerDel.mjs', () => ({ funShopOwnerDel }))
vi.mock('@lib/auth/endEverySession.mjs', () => ({ endEverySession }))

const { companyAdd } = await import('../src/graphQLApi/schema/mutations/companyAdd.mts')
const { companyDel } = await import('../src/graphQLApi/schema/mutations/companyDel.mts')
const { companyUpdate } = await import('../src/graphQLApi/schema/mutations/companyUpdate.mts')
const { companyUpdatePublished } = await import('../src/graphQLApi/schema/mutations/companyUpdatePublished.mts')
const { shopOwnerDel } = await import('../src/graphQLApi/schema/mutations/shopOwnerDel.mts')
// Not mocked: what companyAdd/companyUpdate hand `Company.create`/`funCompanyUpdate` is this function's
// own output, and the field-level checks it runs are `validate.test.mts`'s job, not this file's.
const { validateCompany } = await import('../src/lib/validate/validateCompany.mts')

beforeEach(() => {
	vi.clearAllMocks()
	companyCreate.mockResolvedValue({ _id: ID_COMPANY })
	throwIfShopOwnerDontOwnCompany.mockResolvedValue(undefined)
	funCompanyDelete.mockResolvedValue(undefined)
	funCompanyUpdate.mockResolvedValue(undefined)
	funCompanyUpdatePublished.mockResolvedValue(undefined)
	funShopOwnerDel.mockResolvedValue(undefined)
	endEverySession.mockResolvedValue(undefined)
})

// A complete, already-valid company — every field `validateCompany` requires, already trimmed and
// shaped so validation changes nothing observable except adding the GeoJSON `position.type`. The three
// optional storefront fields (`publicName`, `slug`, `description`) and `taxCode`/`uniqueCode` are left
// out on purpose: a company is a legal entity before it is a shop, and the same fixture doubles as the
// unpublished-draft case every describe block below needs.
const company = {
	legalName: 'Test Boutique Ltd',
	vatNumber: '01234567890',
	contactPerson: 'Mark Rivers',
	administrator: 'Mark Rivers',
	certifiedEmail: 'certified@boutique.test',
	address: {
		street: '1 main street',
		postalCode: '02109',
		city: 'Boston',
		province: 'MA',
		position: { coordinates: [9.19, 45.46] }
	},
	registryExtract: 'registryExtract.pdf'
}

describe('companyAdd', () => {
	const args = { company }

	// The owner comes from the session, never from the input. Unlike every other write here there is
	// no ownership guard to run first — the company does not exist yet, so `idShopOwner` is what
	// establishes the ownership rather than what is checked.
	it('stamps the caller as owner and creates the company', async () => {
		await expect(run(companyAdd, args)).resolves.toEqual({ _id: ID_COMPANY })

		const [doc] = companyCreate.mock.calls[0]
		expect(doc).toMatchObject({ idShopOwner: SHOP_OWNER_ID, ...company })
		expect(doc._id).toBeInstanceOf(Types.ObjectId)
		expect(throwIfShopOwnerDontOwnCompany).not.toHaveBeenCalled()
	})

	// Validated before the write: a malformed card must never reach `Company.create` at all, and the
	// 400 `throwErrorWrongUserInput` raises has to come back as itself rather than the generic 500 a
	// raw `$jsonSchema` rejection would have produced.
	it('rejects a malformed company before creating anything', async () => {
		await expect(run(companyAdd, { company: { ...company, vatNumber: '123' } })).rejects.toMatchObject({
			message: 'Bad Request',
			extensions: { http: { status: 400 }, description: 'company.vatNumber: the VAT number is 11 digits' }
		})
		expect(companyCreate).not.toHaveBeenCalled()
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
	const args = { _id: ID_COMPANY, company }

	it('checks ownership then delegates the validated save and answers true', async () => {
		await expect(run(companyUpdate, args)).resolves.toBe(true)

		expect(throwIfShopOwnerDontOwnCompany).toHaveBeenCalledExactlyOnceWith(SHOP_OWNER_ID, ID_COMPANY)
		expect(funCompanyUpdate).toHaveBeenCalledExactlyOnceWith(ID_COMPANY, SHOP_OWNER_ID, validateCompany(company))
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

	// The guard already proved the caller owns this company, so a malformed card is still validated —
	// and refused — ahead of the write, the same as a brand-new one.
	it('rejects a malformed company before saving anything', async () => {
		await expect(run(companyUpdate, { _id: ID_COMPANY, company: { ...company, slug: 'Not-Lowercase' } })).rejects.toMatchObject({
			message: 'Bad Request',
			extensions: { http: { status: 400 }, description: 'company.slug: lowercase letters, digits and single hyphens only' }
		})
		expect(funCompanyUpdate).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		funCompanyUpdate.mockRejectedValueOnce(driverError)

		await expect(run(companyUpdate, args)).rejects.toThrow('Internal Server Error')
	})
})

describe('companyUpdatePublished', () => {
	const args = { _id: ID_COMPANY, published: true }

	// The same ownership guard `companyUpdate` runs, and then one flag: no input object, nothing else
	// written. That separation is the point — an owner saving the card of a shop an admin has just
	// taken down no longer puts it back.
	it('checks ownership then delegates the flag and answers true', async () => {
		await expect(run(companyUpdatePublished, args)).resolves.toBe(true)

		expect(throwIfShopOwnerDontOwnCompany).toHaveBeenCalledExactlyOnceWith(SHOP_OWNER_ID, ID_COMPANY)
		expect(funCompanyUpdatePublished).toHaveBeenCalledExactlyOnceWith(ID_COMPANY, SHOP_OWNER_ID, true)
		expect(funCompanyUpdate).not.toHaveBeenCalled()
	})

	it('passes false through unchanged when the owner takes the shop off the site', async () => {
		await expect(run(companyUpdatePublished, { _id: ID_COMPANY, published: false })).resolves.toBe(true)

		expect(funCompanyUpdatePublished).toHaveBeenCalledExactlyOnceWith(ID_COMPANY, SHOP_OWNER_ID, false)
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
		await expect(run(companyDel, { _id: ID_COMPANY })).resolves.toBe(true)

		expect(throwIfShopOwnerDontOwnCompany).toHaveBeenCalledExactlyOnceWith(SHOP_OWNER_ID, ID_COMPANY)
		expect(funCompanyDelete).toHaveBeenCalledExactlyOnceWith(ID_COMPANY, SHOP_OWNER_ID)
	})

	it('does not delete when the caller does not own the company', async () => {
		throwIfShopOwnerDontOwnCompany.mockRejectedValueOnce(
			new GraphQLError('Forbidden', { extensions: { http: { status: 403 } } })
		)

		await expect(run(companyDel, { _id: ID_COMPANY })).rejects.toMatchObject({ message: 'Forbidden' })
		expect(funCompanyDelete).not.toHaveBeenCalled()
	})

	// A GraphQLError raised downstream of the ownership guard keeps its status instead of being
	// flattened to a 500 — that is the whole reason the catch goes through tryCatchRethrow.
	it('keeps a downstream GraphQL error instead of flattening it', async () => {
		funCompanyDelete.mockRejectedValueOnce(new GraphQLError('Conflict', { extensions: { http: { status: 409 } } }))

		await expect(run(companyDel, { _id: ID_COMPANY })).rejects.toMatchObject({
			message: 'Conflict',
			extensions: { http: { status: 409 } }
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		funCompanyDelete.mockRejectedValueOnce(driverError)

		await expect(run(companyDel, { _id: ID_COMPANY })).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})

describe('shopOwnerDel', () => {
	/*
	 * ⚠️ **The account closed is the one the request authenticated as, and no argument can move it.** Every
	 * shop owner authenticates against the same collection and the platform has no role field, so an `_id`
	 * accepted from the client would turn this into "close any owner's account". The extra argument here is
	 * what a caller would send trying: the schema drops it, and the assertion says the resolver ignores it
	 * even if it did not.
	 */
	it('closes the account named by the session, never one named by the caller', async () => {
		await expect(run(shopOwnerDel, { _id: ID_COMPANY })).resolves.toBe(true)

		expect(funShopOwnerDel).toHaveBeenCalledExactlyOnceWith(SHOP_OWNER_ID)
	})

	/*
	 * ⚠️ **The revoke runs after the write and inside the same try, both deliberately.** Before it, an
	 * account that then failed to close would have logged the owner out of every device for nothing.
	 */
	it('ends every session, after the account is closed', async () => {
		await run(shopOwnerDel, {})

		expect(endEverySession).toHaveBeenCalledExactlyOnceWith(ctx)
		expect(funShopOwnerDel.mock.invocationCallOrder[0]).toBeLessThan(endEverySession.mock.invocationCallOrder[0])
	})

	/*
	 * ⚠️ **A refused close ends no session.** The 410 an already-closed account answers with must not also
	 * log the owner out — the account is still open in that case as far as this call is concerned, and a
	 * failed mutation that signed the caller out everywhere would be a denial of service anyone could aim
	 * at their own account by calling twice.
	 */
	it('keeps the sessions when the close was refused', async () => {
		funShopOwnerDel.mockRejectedValueOnce(
			new GraphQLError('Oops', { extensions: { http: { status: 410 }, description: 'account already closed' } })
		)

		await expect(run(shopOwnerDel, {})).rejects.toMatchObject({
			message: 'Oops',
			extensions: { http: { status: 410 }, description: 'account already closed' }
		})
		expect(endEverySession).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ **A Redis that refused is a 500, not a `true`.** The write has landed at this point, so answering
	 * true is the tempting reading — and it would leave a closed account with every session still live,
	 * which is the outcome the revoke exists to prevent. The owner sees a failure and calls again; the
	 * second call finds the account closed and refuses, and the sessions are ended by the sweep or by the
	 * admin. Reporting success would leave nobody looking.
	 */
	it('fails loudly when the sessions could not be ended', async () => {
		endEverySession.mockRejectedValueOnce(driverError)

		await expect(run(shopOwnerDel, {})).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})

	it('turns a driver failure into a 500', async () => {
		funShopOwnerDel.mockRejectedValueOnce(driverError)

		await expect(run(shopOwnerDel, {})).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})

	// The 401 the other refusal raises is a status the client acts on — it clears its own state and sends
	// the owner to the login page — so it has to arrive as itself rather than as a 500.
	it('keeps a downstream GraphQL error instead of flattening it', async () => {
		funShopOwnerDel.mockRejectedValueOnce(new GraphQLError('Unauthorized', { extensions: { http: { status: 401 } } }))

		await expect(run(shopOwnerDel, {})).rejects.toMatchObject({
			message: 'Unauthorized',
			extensions: { http: { status: 401 } }
		})
		expect(captureException).not.toHaveBeenCalled()
	})
})
