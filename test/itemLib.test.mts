import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const companyFind = vi.fn()
const itemUpdateOne = vi.fn()
const itemCountDocuments = vi.fn()
const itemCategoryCountDocuments = vi.fn()

vi.mock('@sentry/node', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))
// ⚠️ No `deleteOne` on the Item mock, for the reason `companyLib.test.mts` leaves it off Company:
// `funItemDelete` soft-deletes, and a regression to a hard removal has to fail here rather than
// against a real database three services away.
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Company', () => ({ Company: { find: companyFind } }))
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Item', () => ({
	Item: { updateOne: itemUpdateOne, countDocuments: itemCountDocuments }
}))
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/ItemCategory', () => ({
	ItemCategory: { countDocuments: itemCategoryCountDocuments }
}))

const { shopOwnerCompanyIds } = await import('../src/lib/company/shopOwnerCompanyIds.mts')
const { funItemDelete } = await import('../src/lib/item/funItemDelete.mts')
const { funItemUpdate } = await import('../src/lib/item/funItemUpdate.mts')
const { throwIfItemCategoryMissing } = await import('../src/lib/item/throwIfItemCategoryMissing.mts')
const { throwIfShopOwnerDontOwnItem } = await import('../src/lib/item/throwIfShopOwnerDontOwnItem.mts')

const shopOwnerId = new Types.ObjectId('507f1f77bcf86cd799439011')
const idCompany = new Types.ObjectId('507f1f77bcf86cd799439015')
const idOtherCompany = new Types.ObjectId('507f1f77bcf86cd799439016')
const itemId = new Types.ObjectId('507f1f77bcf86cd799439020')
const idCategory = new Types.ObjectId('507f1f77bcf86cd799439030')

const updateExec = vi.fn()

/** Company.find() ends `.lean().exec()`; countDocuments() ends `.lean()`. */
const finding = (docs: unknown[]) => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(docs) }) })
const counting = (found: number) => ({ lean: vi.fn().mockResolvedValue(found) })

/**
 * Both writes go through the same `updateOne` filter — `_id` plus the owner's live companies, and
 * nothing else — so the assertion is shared rather than restated. Returns the update half, which is
 * the only part that differs between a save and a withdrawal.
 */
function expectOwnerScopedWrite() {
	const [filter, update] = itemUpdateOne.mock.calls[0]
	expect(itemUpdateOne).toHaveBeenCalledOnce()
	expect(filter._id).toBe(itemId)
	expect(filter.idCompany).toEqual(trusted({ $in: [idCompany, idOtherCompany] }))
	expect(Object.keys(filter).sort()).toEqual(['_id', 'idCompany'])

	return update
}

const data = {
	idCompany,
	idCategory,
	name: 'Focaccia',
	description: 'Baked this morning',
	slug: 'focaccia',
	published: true
} as never

beforeEach(() => {
	companyFind.mockReset().mockReturnValue(finding([{ _id: idCompany }, { _id: idOtherCompany }]))
	itemUpdateOne.mockReset().mockReturnValue({ exec: updateExec })
	updateExec.mockReset().mockResolvedValue({ matchedCount: 1 })
	itemCountDocuments.mockReset().mockReturnValue(counting(1))
	itemCategoryCountDocuments.mockReset().mockReturnValue(counting(1))
})

describe('shopOwnerCompanyIds', () => {
	// The projection is half the point: this runs on every item read and every item write on the tier,
	// and pulling whole company documents to throw all but `_id` away would put the legal card, the
	// address and the description on the wire four times per request.
	it('returns the ids of the owner’s live companies, projected to _id', async () => {
		await expect(shopOwnerCompanyIds(shopOwnerId)).resolves.toEqual([idCompany, idOtherCompany])

		const [filter, projection] = companyFind.mock.calls[0]
		expect(companyFind).toHaveBeenCalledOnce()
		expect(filter.idShopOwner).toBe(shopOwnerId)
		// trusted(), not a bare object: `sanitizeFilter` is on globally, so an untagged `$exists` would
		// be read as a literal value and the query would fail casting it against the `deleted` path.
		expect(filter.deleted).toEqual(trusted({ $exists: false }))
		expect(Object.keys(filter).sort()).toEqual(['deleted', 'idShopOwner'])
		expect(projection).toEqual({ _id: 1 })
	})

	// An owner with no company is not an error — it is the refusal every caller wants, because `$in: []`
	// matches no item. Throwing here instead would turn "you have no shops yet" into a 500 on a screen
	// a brand-new owner sees first.
	it('answers an empty array for an owner with no live company', async () => {
		companyFind.mockReturnValueOnce(finding([]))

		await expect(shopOwnerCompanyIds(shopOwnerId)).resolves.toEqual([])
	})
})

describe('throwIfShopOwnerDontOwnItem', () => {
	// ⚠️ Two hops, and the second is the whole guard: `item` carries no `idShopOwner`, so a check that
	// read the item alone would accept any item on the platform whose id the client guessed. The
	// assertion on the exact key set is what would catch a clause quietly dropped in a refactor —
	// nothing else fails when one goes missing, the guard simply starts passing.
	it('passes when the item hangs off one of the owner’s live companies', async () => {
		await expect(throwIfShopOwnerDontOwnItem(shopOwnerId, itemId)).resolves.toBeUndefined()

		const [filter] = itemCountDocuments.mock.calls[0]
		expect(companyFind).toHaveBeenCalledOnce()
		expect(itemCountDocuments).toHaveBeenCalledOnce()
		expect(filter._id).toBe(itemId)
		expect(filter.deleted).toEqual(trusted({ $exists: false }))
		expect(filter.idCompany).toEqual(trusted({ $in: [idCompany, idOtherCompany] }))
		expect(Object.keys(filter).sort()).toEqual(['_id', 'deleted', 'idCompany'])
	})

	// 403 rather than 404, and the same answer for both failures: an item belonging to another owner and
	// an item that has been withdrawn are indistinguishable from outside, which is what stops the guard
	// being used to probe which item ids exist.
	it('answers 403 when the item is not the owner’s, or already withdrawn', async () => {
		itemCountDocuments.mockReturnValueOnce(counting(0))

		await expect(throwIfShopOwnerDontOwnItem(shopOwnerId, itemId)).rejects.toThrow('Forbidden')
	})

	it('answers 403 for an owner who holds no company at all', async () => {
		companyFind.mockReturnValueOnce(finding([]))
		itemCountDocuments.mockReturnValueOnce(counting(0))

		await expect(throwIfShopOwnerDontOwnItem(shopOwnerId, itemId)).rejects.toThrow('Forbidden')
		expect(itemCountDocuments.mock.calls[0][0].idCompany).toEqual(trusted({ $in: [] }))
	})
})

describe('throwIfItemCategoryMissing', () => {
	// MongoDB has no foreign keys, so `item.idCategory` can name a category that never existed. This is
	// the only thing standing between a typo in a client and an item no listing can reach.
	it('passes when the category exists and is live', async () => {
		await expect(throwIfItemCategoryMissing(idCategory)).resolves.toBeUndefined()

		const [filter] = itemCategoryCountDocuments.mock.calls[0]
		expect(itemCategoryCountDocuments).toHaveBeenCalledOnce()
		expect(filter._id).toBe(idCategory)
		expect(filter.deleted).toEqual(trusted({ $exists: false }))
		expect(Object.keys(filter).sort()).toEqual(['_id', 'deleted'])
	})

	// 404, not 403, and that asymmetry with the ownership guards is deliberate: the taxonomy is
	// platform-wide public data, so a missing category is a stale client rather than a caller reaching
	// for something that is not theirs. A retired one counts as missing — filing an item under it would
	// produce an item every read path drops.
	//
	// The status is asserted rather than the message because `throwNotFoundError` answers the generic
	// 'Oops' every koa-utils 404 carries — the status is the only part a client can act on.
	it('answers 404 when the category is absent or retired', async () => {
		itemCategoryCountDocuments.mockReturnValueOnce(counting(0))

		await expect(throwIfItemCategoryMissing(idCategory)).rejects.toMatchObject({
			message: 'Oops',
			extensions: { http: { status: 404 } }
		})
	})
})

describe('funItemUpdate', () => {
	// ⚠️ The `idCompany` clause reads the STORED row, not the update — defence in depth behind
	// `throwIfShopOwnerDontOwnItem`, refusing the write a second time if the item moved out from under
	// the session in between. The destination in `data` is the resolver's to check: a filter cannot
	// check a value it is about to write.
	it('saves the whole item, scoped to the companies its owner holds', async () => {
		await expect(funItemUpdate(itemId, shopOwnerId, data)).resolves.toBeUndefined()

		expect(expectOwnerScopedWrite()).toEqual({ $set: data })
	})

	// `matchedCount`, not `modifiedCount`: saving an item unchanged matches one document and modifies
	// none, and that is a successful save — reading the other counter would 500 on every no-op.
	it('accepts a save that changed nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		await expect(funItemUpdate(itemId, shopOwnerId, data)).resolves.toBeUndefined()
	})

	it('raises a 500 when the filter matched nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funItemUpdate(itemId, shopOwnerId, data)).rejects.toThrow('Internal Server Error')
	})
})

describe('funItemDelete', () => {
	// A stamp, not a removal: the `{ idCompany, slug }` index stays occupied on purpose, so a link that
	// used to be an item cannot silently become a different item when the shop reuses the name.
	it('stamps deleted on the item, scoped to the companies its owner holds', async () => {
		await expect(funItemDelete(itemId, shopOwnerId)).resolves.toBeUndefined()

		// No `deleted` clause on the write itself — that filter lives on the read paths and on
		// `throwIfShopOwnerDontOwnItem`, which has already refused a withdrawn item before this runs.
		const update = expectOwnerScopedWrite()
		expect(Object.keys(update)).toEqual(['$set'])
		expect(Object.keys(update.$set)).toEqual(['deleted'])
		// `Date.now()` is a number and the schema path is a Date; mongoose casts it, which is why the
		// assertion is on the type rather than on an instance of Date.
		expect(typeof update.$set.deleted).toBe('number')
	})

	it('raises a 500 when the filter matched nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funItemDelete(itemId, shopOwnerId)).rejects.toThrow('Internal Server Error')
	})
})
