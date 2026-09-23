import { trusted, Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const companyCountDocuments = vi.fn()
const companyUpdateOne = vi.fn()
const companyFindOneAndUpdate = vi.fn()

vi.mock('@sentry/node', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))
// ⚠️ No `deleteOne` on the mock, deliberately. `funCompanyDelete` soft-deletes, so a regression to the
// old removal call has to fail here — with a mock that carried it it would pass every assertion below
// and only surface against a real database.
vi.mock('@axiumine/marketplace-common/models/MongoDB/Company', () => ({
	Company: {
		countDocuments: companyCountDocuments,
		updateOne: companyUpdateOne,
		findOneAndUpdate: companyFindOneAndUpdate
	}
}))

const { funCompanyDelete } = await import('../src/lib/company/funCompanyDelete.mts')
const { funCompanyUpdate } = await import('../src/lib/company/funCompanyUpdate.mts')
const { funCompanyUpdatePublished } = await import('../src/lib/company/funCompanyUpdatePublished.mts')
const { holdCompany } = await import('../src/lib/company/holdCompany.mts')
const { throwIfShopOwnerDontOwnCompany } = await import('../src/lib/company/throwIfShopOwnerDontOwnCompany.mts')

const shopOwnerId = new Types.ObjectId('507f1f77bcf86cd799439011')
const companyId = new Types.ObjectId('507f1f77bcf86cd799439015')

const updateExec = vi.fn()

/**
 * A session double, and the only thing asserted about it is which query was handed it — the same
 * technique `itemLib.test.mts` uses for `holdItemCategory`.
 */
const session = { id: 'the session' } as never
const threaded: unknown[] = []

/** `.session()` is a hop on the chain: it records what it was given and answers the rest of the chain. */
const sessioned = (tail: object) => ({
	session: vi.fn((clientSession: unknown) => {
		threaded.push(clientSession)

		return tail
	})
})

/** countDocuments() returns a Query; every call site here ends it with .lean(). */
function counting(found: number) {
	return { lean: vi.fn().mockResolvedValue(found) }
}

/** findOneAndUpdate() ends `.session().lean()` — no `.exec()`, the chain is awaited as it stands. */
const holding = (doc: unknown) => sessioned({ lean: vi.fn().mockResolvedValue(doc) })

// No `published`: it is outside `ICompanyUpdate`, so a whole-object `$set` of a save cannot carry it and
// `funCompanyUpdatePublished` is the only thing that writes it.
//
// The five optional keys are present here the way `validateCompany` always hands them back — `taxCode`
// and `slug` carrying a value, `uniqueCode`/`publicName`/`description` explicit `undefined` — so this
// fixture exercises `funCompanyUpdate`'s `$set`/`$unset` split on both sides at once, the way its own
// caller always will.
const data = {
	legalName: 'Test Boutique Ltd',
	vatNumber: '01234567890',
	taxCode: '01234567890',
	contactPerson: 'Mark Rivers',
	administrator: 'Mark Rivers',
	uniqueCode: undefined,
	certifiedEmail: 'certified@boutique.test',
	address: { street: '1 main street' },
	registryExtract: 'registryExtract.pdf',
	publicName: undefined,
	slug: 'test-boutique',
	description: undefined
} as never

beforeEach(() => {
	companyCountDocuments.mockReset().mockReturnValue(counting(1))
	companyUpdateOne.mockReset().mockReturnValue({ exec: updateExec })
	companyFindOneAndUpdate.mockReset().mockReturnValue(holding({ _id: companyId }))
	updateExec.mockReset().mockResolvedValue({ matchedCount: 1 })
	threaded.length = 0
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

describe('holdCompany', () => {
	// ⚠️ **A read would not have closed the race, which is why this is a write.** `funCompanyDelete` stamps
	// `deleted` with no live-reference guard of its own — nothing on the platform was thought to reference a
	// company any more, until `itemUpdate` started using this to re-point an item at one. An insert that
	// only *read* the company here would commit alongside that stamp, because MongoDB transactions are
	// snapshot-isolated rather than serialisable and both sides would see a consistent snapshot. `$inc`
	// makes this transaction a writer of the very document the delete writes, so the server aborts one of
	// them with a `WriteConflict` and `withTransaction` retries it.
	//
	// The assertion is on the exact update, not on the call alone: a mutant that dropped the `$inc` for an
	// empty update would still find the document and still pass a check that only looked at the filter.
	it('takes the company as a write, so a concurrent delete collides with it', async () => {
		await expect(holdCompany(companyId, session)).resolves.toBeUndefined()

		const [filter, update, options] = companyFindOneAndUpdate.mock.calls[0]
		expect(companyFindOneAndUpdate).toHaveBeenCalledOnce()
		expect(filter._id).toBe(companyId)
		// A retired company is invisible to every read path, so re-pointing an item at one would produce
		// an item no listing can reach — the same clause the cheap pre-flight carries.
		expect(filter.deleted).toEqual(trusted({ $exists: false }))
		expect(Object.keys(filter).sort()).toEqual(['_id', 'deleted'])
		// `__v` because nothing reads it: mongoose maintains it for `save()` on documents with arrays,
		// this collection is never written that way, and the validator already declares it an int.
		expect(update).toEqual({ $inc: { __v: 1 } })
		// The answer needed is whether the document is there; the rest of the company's card is none of
		// this write's business, and pulling it would put the whole legal record on the wire per item write.
		expect(options).toEqual({ projection: { _id: 1 } })
	})

	// ⚠️ Held *inside* the caller's transaction or held for nothing: a hop taken against the default
	// session writes the company in a transaction of its own, which commits immediately and collides with
	// no one.
	it('takes it inside the caller’s transaction', async () => {
		await holdCompany(companyId, session)

		expect(threaded).toEqual([session])
	})

	// 404 rather than 403: `throwIfShopOwnerDontOwnCompany` has already answered 403 for a destination
	// that was never the caller's, so a miss here means the company the pre-flight found went away in the
	// meantime — a race, not a permission the caller lacked. A retired company is missing too — `deleted`
	// is in the filter — which is also how the loser of the race answers after its retry.
	it('answers 404 when the company is absent or retired', async () => {
		companyFindOneAndUpdate.mockReturnValueOnce(holding(null))

		await expect(holdCompany(companyId, session)).rejects.toMatchObject({
			message: 'Oops',
			extensions: { http: { status: 404 } }
		})
	})
})

describe('funCompanyUpdate', () => {
	// `idShopOwner` is in the filter and not in the update: a company cannot change hands by saving
	// its card, and a filter on `_id` alone would let one owner overwrite another's company.
	//
	// ⚠️ **The split is the assertion that matters.** `data` carries three keys the owner cleared
	// (`uniqueCode`, `publicName`, `description`, all `undefined`) beside the six they set — a mutant
	// that folded this back into a single `$set: data` would still save the six correctly and only be
	// caught here, on the three that must instead become `$unset`.
	it('splits the card into $set and $unset, scoped to its owner', async () => {
		await expect(funCompanyUpdate(companyId, shopOwnerId, data)).resolves.toBeUndefined()

		expect(companyUpdateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id: companyId, idShopOwner: shopOwnerId },
			{
				$set: {
					legalName: 'Test Boutique Ltd',
					vatNumber: '01234567890',
					taxCode: '01234567890',
					contactPerson: 'Mark Rivers',
					administrator: 'Mark Rivers',
					certifiedEmail: 'certified@boutique.test',
					address: { street: '1 main street' },
					registryExtract: 'registryExtract.pdf',
					slug: 'test-boutique'
				},
				$unset: { uniqueCode: 1, publicName: 1, description: 1 }
			}
		)
	})

	// The mirror of the case above: nothing cleared, so `$unset` is the empty object the driver accepts
	// and does nothing with — asserted on its own, since the mixed fixture above could pass with an
	// `$unset` that silently dropped a key rather than one that is genuinely empty.
	it('sends an empty $unset when nothing on the card was cleared', async () => {
		const whole = {
			...(data as object),
			uniqueCode: 'ABC1234',
			publicName: 'Test Boutique',
			description: 'Since 1975.'
		} as never

		await funCompanyUpdate(companyId, shopOwnerId, whole)

		const [, update] = companyUpdateOne.mock.calls[0]
		expect(update.$unset).toEqual({})
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

describe('funCompanyUpdatePublished', () => {
	// The same owner-scoped filter as the save, and one field in the update. The exact `$set` is the
	// assertion that matters: widening this back into a save is exactly the regression the split exists
	// to prevent.
	it('writes the flag alone, scoped to its owner', async () => {
		await expect(funCompanyUpdatePublished(companyId, shopOwnerId, true)).resolves.toBeUndefined()

		expect(companyUpdateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id: companyId, idShopOwner: shopOwnerId },
			{ $set: { published: true } }
		)
	})

	it('takes the shop off the site with the same call and the flag the other way round', async () => {
		await expect(funCompanyUpdatePublished(companyId, shopOwnerId, false)).resolves.toBeUndefined()

		expect(companyUpdateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id: companyId, idShopOwner: shopOwnerId },
			{ $set: { published: false } }
		)
	})

	// `matchedCount`, not `modifiedCount`: publishing a shop that is already published matches one
	// document and modifies none, and that is the state the owner asked for.
	it('accepts a publish that changed nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		await expect(funCompanyUpdatePublished(companyId, shopOwnerId, true)).resolves.toBeUndefined()
	})

	// The ownership guard has already answered 403 for anything not the session's, so nothing matching
	// here means the company went away in between — a 500, not a client error. The `$expr` refusal of a
	// shop with no `slug` is a different failure entirely: it rejects the write rather than matching
	// nothing, and reaches the client through the resolver's `tryCatchRethrow`.
	it('raises a 500 when the filter matched nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funCompanyUpdatePublished(companyId, shopOwnerId, true)).rejects.toThrow('Internal Server Error')
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
	// nothing means the company went away between the two queries, and that is the 500. Stamping a company
	// that already carries `deleted` matches one document and modifies none — still a success.
	it('raises a 500 when the filter matched nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funCompanyDelete(companyId, shopOwnerId)).rejects.toThrow('Internal Server Error')
	})
})

afterEach(() => vi.clearAllMocks())
