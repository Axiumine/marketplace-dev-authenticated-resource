import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextImprenditoreAuthenticatedResource } from '../src/lib/auth/IContextImprenditoreAuthenticatedResource.mts'

const aziendaFind = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda', () => ({
	Azienda: { find: aziendaFind }
}))

const { aziendeImprenditore } = await import('../src/graphQLApi/schema/queries/aziendeImprenditore.mts')

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
const idAzienda = new Types.ObjectId('507f1f77bcf86cd799439015')

const ctx = { state: { user: { _id: userId } } } as unknown as IContextImprenditoreAuthenticatedResource

/** Query builders end in `.lean()`, all of these with a `.select()` in between. */
function chain(result: unknown) {
	const lean = vi.fn().mockResolvedValue(result)
	return { select: vi.fn().mockReturnValue({ lean }), lean }
}

beforeEach(() => {
	aziendaFind.mockReset()
})

describe('aziendeImprenditore', () => {
	// Owner and liveness, the only filter this tier's sole surviving query needs — the owner half is the
	// ownership check itself since `idImprenditore` comes from the session.
	//
	// The `deleted` clause draws two things at once, the companies list and the `<select>` the shop
	// form offers, so a retired company left in would be pickable and then refused by
	// `throwIfImprenditoreDontOwnAzienda` with a 403 the owner cannot act on.
	it('lists the caller‑owned live aziende, whole', async () => {
		const docs = [{ _id: idAzienda }]
		const builder = chain(docs)
		aziendaFind.mockReturnValueOnce(builder)

		await expect(aziendeImprenditore.resolve(null, {}, ctx)).resolves.toBe(docs)

		expect(aziendaFind).toHaveBeenCalledExactlyOnceWith({
			idImprenditore: userId,
			deleted: trusted({ $exists: false })
		})
		expect(builder.select).not.toHaveBeenCalled()
	})
})
