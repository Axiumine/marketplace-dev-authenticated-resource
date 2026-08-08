import { trusted, Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const companyCountDocuments = vi.fn()
const companyUpdateOne = vi.fn()

vi.mock('@sentry/node', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))
// ⚠️ No `deleteOne` on the mock, deliberately. `funCompanyDelete` soft-deletes, so a regression to the
// old removal call has to fail here — with a mock that carried it it would pass every assertion below
// and only surface against a real database.
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Company', () => ({
	Company: {
		countDocuments: companyCountDocuments,
		updateOne: companyUpdateOne
	}
}))

const { funCompanyDelete } = await import('../src/lib/company/funCompanyDelete.mts')
const { funCompanyUpdate } = await import('../src/lib/company/funCompanyUpdate.mts')
const { throwIfShopOwnerDontOwnCompany } = await import('../src/lib/company/throwIfShopOwnerDontOwnCompany.mts')

const shopOwnerId = new Types.ObjectId('507f1f77bcf86cd799439011')
const companyId = new Types.ObjectId('507f1f77bcf86cd799439015')

const updateExec = vi.fn()

/** countDocuments() returns a Query; every call site here ends it with .lean(). */
function counting(found: number) {
	return { lean: vi.fn().mockResolvedValue(found) }
}

const data = {
	legalName: 'Test Boutique Ltd',
	vatNumber: '01234567890',
	contactPerson: 'Mark Rivers',
	administrator: 'Mark Rivers',
	certifiedEmail: 'certified@boutique.test',
	address: { street: '1 main street' },
	registryExtract: 'registryExtract.pdf'
} as never

beforeEach(() => {
	companyCountDocuments.mockReset().mockReturnValue(counting(1))
	companyUpdateOne.mockReset().mockReturnValue({ exec: updateExec })
	updateExec.mockReset().mockResolvedValue({ matchedCount: 1 })
})

describe('throwIfShopOwnerDontOwnCompany', () => {
	// All three clauses, asserted field by field and then as an exact key set: a missing one is silent
	// here — the guard still passes, the mutation still runs — and only shows up as an owner editing or
	// retiring a company that is somebody else's.
	it('passes when the pair matches a live document', async () => {
		await expect(throwIfShopOwnerDontOwnCompany(shopOwnerId, companyId)).resolves.toBeUndefined()

		// trusted(), not a bare object: `sanitizeFilter` is on globally, so an untagged `$exists`
		// would be read as a literal value and the query would fail casting it.
		const [filter] = companyCountDocuments.mock.calls[0]
		expect(companyCountDocuments).toHaveBeenCalledOnce()
		expect(filter._id).toBe(companyId)
		expect(filter.idShopOwner).toBe(shopOwnerId)
		expect(filter.deleted).toEqual(trusted({ $exists: false }))
		expect(Object.keys(filter).sort()).toEqual(['_id', 'deleted', 'idShopOwner'])
	})

	// Both halves of the ownership filter matter. Matching on `_id` alone would let any owner name any
	// company on the platform, which is the entire reason this guard exists — and the `deleted` clause
	// is what stops a second call retiring the same company twice.
	it('answers 403 when the company is not the shopOwner’s, or no longer live', async () => {
		companyCountDocuments.mockReturnValueOnce(counting(0))

		await expect(throwIfShopOwnerDontOwnCompany(shopOwnerId, companyId)).rejects.toThrow('Forbidden')
	})
})

describe('funCompanyUpdate', () => {
	// `idShopOwner` is in the filter and not in the update: a company cannot change hands by saving
	// its card, and a filter on `_id` alone would let one owner overwrite another's row.
	it('saves the whole card, scoped to its owner', async () => {
		await expect(funCompanyUpdate(companyId, shopOwnerId, data)).resolves.toBeUndefined()

		expect(companyUpdateOne).toHaveBeenCalledExactlyOnceWith({ _id: companyId, idShopOwner: shopOwnerId }, { $set: data })
	})

	// `matchedCount`, not `modifiedCount`: saving a card unchanged matches one document and modifies
	// none, and that is a successful save — reading the wrong counter would 500 on every no-op.
	it('accepts a save that changed nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		await expect(funCompanyUpdate(companyId, shopOwnerId, data)).resolves.toBeUndefined()
	})

	it('raises a 500 when the filter matched nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funCompanyUpdate(companyId, shopOwnerId, data)).rejects.toThrow('Internal Server Error')
	})
})

describe('funCompanyDelete', () => {
	// No referential check any more: the old shop collection was the only thing that could point at an
	// `company`, and it was removed from the platform on 2026-08-04 along with the `countDocuments`
	// guard that used to read it here. Retiring a company is now a straight stamp.
	it('stamps deleted on the company, scoped to its owner, and touches nothing else', async () => {
		await expect(funCompanyDelete(companyId, shopOwnerId)).resolves.toBeUndefined()

		// The write is an update, not a removal, and carries no `deleted` clause of its own on the read
		// side. `Date.now()` is a number; mongoose casts it to the Date path, which is why the assertion
		// is on the type and not on an instance of Date.
		const [filter, update] = companyUpdateOne.mock.calls[0]
		expect(companyUpdateOne).toHaveBeenCalledOnce()
		expect(filter).toEqual({ _id: companyId, idShopOwner: shopOwnerId })
		expect(Object.keys(update)).toEqual(['$set'])
		expect(Object.keys(update.$set)).toEqual(['deleted'])
		expect(typeof update.$set.deleted).toBe('number')
	})

	// `matchedCount`, not `modifiedCount`: the ownership guard already ran, so a filter matching
	// nothing means the row went away between the two queries, and that is the 500. Stamping a company
	// that already carries `deleted` matches one document and modifies none — still a success.
	it('raises a 500 when the filter matched nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funCompanyDelete(companyId, shopOwnerId)).rejects.toThrow('Internal Server Error')
	})
})

afterEach(() => vi.clearAllMocks())
