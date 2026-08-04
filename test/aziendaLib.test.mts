import { trusted, Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const aziendaCountDocuments = vi.fn()
const aziendaUpdateOne = vi.fn()

vi.mock('@sentry/node', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))
// ⚠️ No `deleteOne` on the mock, deliberately. `funAziendaDelete` soft-deletes, so a regression to the
// old removal call has to fail here — with a mock that carried it it would pass every assertion below
// and only surface against a real database.
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda', () => ({
	Azienda: {
		countDocuments: aziendaCountDocuments,
		updateOne: aziendaUpdateOne
	}
}))

const { funAziendaDelete } = await import('../src/lib/azienda/funAziendaDelete.mts')
const { funAziendaUpdate } = await import('../src/lib/azienda/funAziendaUpdate.mts')
const { throwIfImprenditoreDontOwnAzienda } = await import('../src/lib/azienda/throwIfImprenditoreDontOwnAzienda.mts')

const imprenditoreId = new Types.ObjectId('507f1f77bcf86cd799439011')
const aziendaId = new Types.ObjectId('507f1f77bcf86cd799439015')

const updateExec = vi.fn()

/** countDocuments() returns a Query; every call site here ends it with .lean(). */
function counting(found: number) {
	return { lean: vi.fn().mockResolvedValue(found) }
}

const dati = {
	ragionesociale: 'Pizzeria Test S.r.l.',
	piva: '01234567890',
	referente: 'Mario Rossi',
	amministratore: 'Mario Rossi',
	pec: 'pizzeria@pec.it',
	indirizzo: { via: 'via Roma 1' },
	visura: 'visura.pdf'
} as never

beforeEach(() => {
	aziendaCountDocuments.mockReset().mockReturnValue(counting(1))
	aziendaUpdateOne.mockReset().mockReturnValue({ exec: updateExec })
	updateExec.mockReset().mockResolvedValue({ matchedCount: 1 })
})

describe('throwIfImprenditoreDontOwnAzienda', () => {
	// All three clauses, asserted field by field and then as an exact key set: a missing one is silent
	// here — the guard still passes, the mutation still runs — and only shows up as an owner editing or
	// retiring a company that is somebody else's.
	it('passes when the pair matches a live document', async () => {
		await expect(throwIfImprenditoreDontOwnAzienda(imprenditoreId, aziendaId)).resolves.toBeUndefined()

		// trusted(), not a bare object: `sanitizeFilter` is on globally, so an untagged `$exists`
		// would be read as a literal value and the query would fail casting it.
		const [filtro] = aziendaCountDocuments.mock.calls[0]
		expect(aziendaCountDocuments).toHaveBeenCalledOnce()
		expect(filtro._id).toBe(aziendaId)
		expect(filtro.idImprenditore).toBe(imprenditoreId)
		expect(filtro.deleted).toEqual(trusted({ $exists: false }))
		expect(Object.keys(filtro).sort()).toEqual(['_id', 'deleted', 'idImprenditore'])
	})

	// Both halves of the ownership filter matter. Matching on `_id` alone would let any owner name any
	// company on the platform, which is the entire reason this guard exists — and the `deleted` clause
	// is what stops a second call retiring the same company twice.
	it('answers 403 when the azienda is not the imprenditore’s, or no longer live', async () => {
		aziendaCountDocuments.mockReturnValueOnce(counting(0))

		await expect(throwIfImprenditoreDontOwnAzienda(imprenditoreId, aziendaId)).rejects.toThrow('Forbidden')
	})
})

describe('funAziendaUpdate', () => {
	// `idImprenditore` is in the filter and not in the update: a company cannot change hands by saving
	// its card, and a filter on `_id` alone would let one owner overwrite another's row.
	it('saves the whole card, scoped to its owner', async () => {
		await expect(funAziendaUpdate(aziendaId, imprenditoreId, dati)).resolves.toBeUndefined()

		expect(aziendaUpdateOne).toHaveBeenCalledExactlyOnceWith({ _id: aziendaId, idImprenditore: imprenditoreId }, { $set: dati })
	})

	// `matchedCount`, not `modifiedCount`: saving a card unchanged matches one document and modifies
	// none, and that is a successful save — reading the wrong counter would 500 on every no-op.
	it('accepts a save that changed nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		await expect(funAziendaUpdate(aziendaId, imprenditoreId, dati)).resolves.toBeUndefined()
	})

	it('raises a 500 when the filter matched nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funAziendaUpdate(aziendaId, imprenditoreId, dati)).rejects.toThrow('Internal Server Error')
	})
})

describe('funAziendaDelete', () => {
	// No referential check any more: `puntoVendita` was the only collection that could point at an
	// `azienda`, and it was removed from the platform on 2026-08-04 along with the `countDocuments`
	// guard that used to read it here. Retiring a company is now a straight stamp.
	it('stamps deleted on the company, scoped to its owner, and touches nothing else', async () => {
		await expect(funAziendaDelete(aziendaId, imprenditoreId)).resolves.toBeUndefined()

		// The write is an update, not a removal, and carries no `deleted` clause of its own on the read
		// side. `Date.now()` is a number; mongoose casts it to the Date path, which is why the assertion
		// is on the type and not on an instance of Date.
		const [filtro, update] = aziendaUpdateOne.mock.calls[0]
		expect(aziendaUpdateOne).toHaveBeenCalledOnce()
		expect(filtro).toEqual({ _id: aziendaId, idImprenditore: imprenditoreId })
		expect(Object.keys(update)).toEqual(['$set'])
		expect(Object.keys(update.$set)).toEqual(['deleted'])
		expect(typeof update.$set.deleted).toBe('number')
	})

	// `matchedCount`, not `modifiedCount`: the ownership guard already ran, so a filter matching
	// nothing means the row went away between the two queries, and that is the 500. Stamping a company
	// that already carries `deleted` matches one document and modifies none — still a success.
	it('raises a 500 when the filter matched nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funAziendaDelete(aziendaId, imprenditoreId)).rejects.toThrow('Internal Server Error')
	})
})

afterEach(() => vi.clearAllMocks())
