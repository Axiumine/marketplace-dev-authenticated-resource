import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextShopOwnerAuthenticatedResource } from '../src/lib/auth/IContextShopOwnerAuthenticatedResource.mts'

const companyFind = vi.fn()
const itemFind = vi.fn()
const itemCategoryFind = vi.fn()
const throwIfShopOwnerDontOwnCompany = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/Company', () => ({
	Company: { find: companyFind }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Item', () => ({ Item: { find: itemFind } }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/ItemCategory', () => ({
	ItemCategory: { find: itemCategoryFind }
}))
vi.mock('@lib/company/throwIfShopOwnerDontOwnCompany.mjs', () => ({ throwIfShopOwnerDontOwnCompany }))

const { shopOwnerCompanies } = await import('../src/graphQLApi/schema/queries/shopOwnerCompanies.mts')
const { companyItems } = await import('../src/graphQLApi/schema/queries/companyItems.mts')
const { itemCategories } = await import('../src/graphQLApi/schema/queries/itemCategories.mts')

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
const idCompany = new Types.ObjectId('507f1f77bcf86cd799439015')

const ctx = { state: { user: { _id: userId } } } as unknown as IContextShopOwnerAuthenticatedResource

/** Query builders end in `.lean()`, all of these with a `.select()` in between. */
function chain(result: unknown) {
	const lean = vi.fn().mockResolvedValue(result)
	return { select: vi.fn().mockReturnValue({ lean }), lean }
}

beforeEach(() => {
	companyFind.mockReset()
	itemFind.mockReset()
	itemCategoryFind.mockReset()
	throwIfShopOwnerDontOwnCompany.mockReset().mockResolvedValue(undefined)
})

describe('shopOwnerCompanies', () => {
	// Owner and liveness, the only filter this tier's sole surviving query needs — the owner half is the
	// ownership check itself since `idShopOwner` comes from the session.
	//
	// The `deleted` clause draws two things at once, the companies list and the `<select>` the shop
	// form offers, so a retired company left in would be pickable and then refused by
	// `throwIfShopOwnerDontOwnCompany` with a 403 the owner cannot act on.
	it('lists the caller‑owned live companies, whole', async () => {
		const docs = [{ _id: idCompany }]
		const builder = chain(docs)
		companyFind.mockReturnValueOnce(builder)

		await expect(shopOwnerCompanies.resolve(null, {}, ctx)).resolves.toBe(docs)

		expect(companyFind).toHaveBeenCalledExactlyOnceWith({
			idShopOwner: userId,
			deleted: trusted({ $exists: false })
		})
		expect(builder.select).not.toHaveBeenCalled()
	})
})

describe('companyItems', () => {
	const idItem = new Types.ObjectId('507f1f77bcf86cd799439020')

	// ⚠️ `idCompany` is an argument, not something the session determines — an owner may hold several
	// shops and this is a per-shop screen — so without the guard this query is a read of any shop's
	// catalogue, drafts included, by anyone holding any ShopOwner token.
	it('checks ownership of the shop before listing its live items', async () => {
		const docs = [{ _id: idItem }]
		const lean = vi.fn().mockResolvedValue(docs)
		itemFind.mockReturnValueOnce({ lean })

		await expect(companyItems.resolve(null, { idCompany }, ctx)).resolves.toBe(docs)

		expect(throwIfShopOwnerDontOwnCompany).toHaveBeenCalledExactlyOnceWith(userId, idCompany)
		// Both drafts and published items: this is the owner's own management list and `published` is
		// what the listing renders. Only the public tier filters on it — an exact key set is what keeps a
		// `published: true` from being "tidied" in here, which would hide every draft from its author.
		const [filter] = itemFind.mock.calls[0]
		expect(filter.idCompany).toBe(idCompany)
		expect(filter.deleted).toEqual(trusted({ $exists: false }))
		expect(Object.keys(filter).sort()).toEqual(['deleted', 'idCompany'])
	})

	it('does not read when the caller does not own the shop', async () => {
		throwIfShopOwnerDontOwnCompany.mockRejectedValueOnce(new Error('Forbidden'))

		await expect(companyItems.resolve(null, { idCompany }, ctx)).rejects.toThrow('Forbidden')
		expect(itemFind).not.toHaveBeenCalled()
	})
})

describe('itemCategories', () => {
	// No session filter and no argument, on purpose: the taxonomy is platform-wide, written only by the
	// operator tier, and there is nothing in it that belongs to anybody. The sort is part of the
	// contract rather than a nicety — `_id` breaks ties on equal `position`, so the order is stable
	// between calls instead of whatever the storage engine hands back.
	it('lists the whole live tree, flat, ordered by position then _id', async () => {
		const docs = [{ _id: new Types.ObjectId('507f1f77bcf86cd799439030') }]
		const lean = vi.fn().mockResolvedValue(docs)
		const sort = vi.fn().mockReturnValue({ lean })
		itemCategoryFind.mockReturnValueOnce({ sort })

		await expect(itemCategories.resolve()).resolves.toBe(docs)

		expect(itemCategoryFind).toHaveBeenCalledExactlyOnceWith({ deleted: trusted({ $exists: false }) })
		expect(sort).toHaveBeenCalledExactlyOnceWith({ position: 1, _id: 1 })
	})
})
