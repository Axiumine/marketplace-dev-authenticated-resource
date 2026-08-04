import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextShopOwnerAuthenticatedResource } from '../src/lib/auth/IContextShopOwnerAuthenticatedResource.mts'

const companyFind = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Company', () => ({
	Company: { find: companyFind }
}))

const { shopOwnerCompanies } = await import('../src/graphQLApi/schema/queries/shopOwnerCompanies.mts')

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
