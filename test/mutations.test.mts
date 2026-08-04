import { GraphQLError } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextImprenditoreAuthenticatedResource } from '../src/lib/auth/IContextImprenditoreAuthenticatedResource.mts'

const captureException = vi.fn()

const aziendaCreate = vi.fn()
const throwIfImprenditoreDontOwnAzienda = vi.fn()
const funAziendaDelete = vi.fn()
const funAziendaUpdate = vi.fn()

// tryCatchRethrow is deliberately NOT mocked: turning a driver error into the right GraphQL status
// is the behaviour under test here. Only Sentry is stubbed, so its `else` branch stays silent.
vi.mock('@sentry/node', () => ({ captureException, captureMessage: vi.fn() }))
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda', () => ({
	Azienda: { create: aziendaCreate }
}))
vi.mock('@lib/azienda/throwIfImprenditoreDontOwnAzienda.mjs', () => ({ throwIfImprenditoreDontOwnAzienda }))
vi.mock('@lib/azienda/funAziendaDelete.mjs', () => ({ funAziendaDelete }))
vi.mock('@lib/azienda/funAziendaUpdate.mjs', () => ({ funAziendaUpdate }))

const { aziendaAdd } = await import('../src/graphQLApi/schema/mutations/aziendaAdd.mts')
const { aziendaDel } = await import('../src/graphQLApi/schema/mutations/aziendaDel.mts')
const { aziendaUpdate } = await import('../src/graphQLApi/schema/mutations/aziendaUpdate.mts')

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
const idAzienda = new Types.ObjectId('507f1f77bcf86cd799439015')

const ctx = { state: { user: { _id: userId } } } as unknown as IContextImprenditoreAuthenticatedResource

/** Anything not a Mongo duplicate-key / [Validator] error ends up a 500 through tryCatchRethrow. */
const driverError = new Error('connection reset')

type Resolver = { resolve: (...a: never[]) => unknown }

function run(mutation: Resolver, args: unknown) {
	return mutation.resolve(null as never, args as never, ctx as never)
}

beforeEach(() => {
	vi.clearAllMocks()
	aziendaCreate.mockResolvedValue({ _id: idAzienda })
	throwIfImprenditoreDontOwnAzienda.mockResolvedValue(undefined)
	funAziendaDelete.mockResolvedValue(undefined)
	funAziendaUpdate.mockResolvedValue(undefined)
})

describe('aziendaAdd', () => {
	const args = { azienda: { ragionesociale: 'Pizzeria Test S.r.l.', piva: '01234567890' } }

	// The owner comes from the session, never from the input. Unlike every other write here there is
	// no ownership guard to run first — the company does not exist yet, so `idImprenditore` is what
	// establishes the ownership rather than what is checked.
	it('stamps the caller as owner and creates the azienda', async () => {
		await expect(run(aziendaAdd, args)).resolves.toEqual({ _id: idAzienda })

		const [doc] = aziendaCreate.mock.calls[0]
		expect(doc).toMatchObject({ idImprenditore: userId, ...args.azienda })
		expect(doc._id).toBeInstanceOf(Types.ObjectId)
		expect(throwIfImprenditoreDontOwnAzienda).not.toHaveBeenCalled()
	})

	// `piva_unique` is global, so a partita IVA already used by another owner's company fails here —
	// and has to reach this one as a 409, not as the 500 every other write failure becomes. The code
	// sits under `errorResponse` because that is where `throwIfMongoErr` reads it, not at the top level.
	it('turns a duplicate partita IVA into a 409', async () => {
		aziendaCreate.mockRejectedValueOnce(
			Object.assign(new Error('E11000 duplicate key error collection: azienda index: piva_unique'), {
				errorResponse: { code: 11000 }
			})
		)

		await expect(run(aziendaAdd, args)).rejects.toMatchObject({
			message: 'Conflict',
			extensions: { http: { status: 409 } }
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		aziendaCreate.mockRejectedValueOnce(driverError)

		await expect(run(aziendaAdd, args)).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})

describe('aziendaUpdate', () => {
	const args = { _id: idAzienda, azienda: { ragionesociale: 'Pizzeria Test S.r.l.', piva: '01234567890' } }

	it('checks ownership then delegates the save and answers true', async () => {
		await expect(run(aziendaUpdate, args)).resolves.toBe(true)

		expect(throwIfImprenditoreDontOwnAzienda).toHaveBeenCalledExactlyOnceWith(userId, idAzienda)
		expect(funAziendaUpdate).toHaveBeenCalledExactlyOnceWith(idAzienda, userId, args.azienda)
	})

	// The guard runs *before* the write, so a company belonging to someone else is never touched —
	// its 403 has to come back out untouched too, not flattened into a 500 by the catch.
	it('does not write when the caller does not own the azienda', async () => {
		throwIfImprenditoreDontOwnAzienda.mockRejectedValueOnce(
			new GraphQLError('Forbidden', { extensions: { http: { status: 403 } } })
		)

		await expect(run(aziendaUpdate, args)).rejects.toMatchObject({
			message: 'Forbidden',
			extensions: { http: { status: 403 } }
		})
		expect(funAziendaUpdate).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		funAziendaUpdate.mockRejectedValueOnce(driverError)

		await expect(run(aziendaUpdate, args)).rejects.toThrow('Internal Server Error')
	})
})

describe('aziendaDel', () => {
	it('checks ownership then delegates the delete and answers true', async () => {
		await expect(run(aziendaDel, { _id: idAzienda })).resolves.toBe(true)

		expect(throwIfImprenditoreDontOwnAzienda).toHaveBeenCalledExactlyOnceWith(userId, idAzienda)
		expect(funAziendaDelete).toHaveBeenCalledExactlyOnceWith(idAzienda, userId)
	})

	it('does not delete when the caller does not own the azienda', async () => {
		throwIfImprenditoreDontOwnAzienda.mockRejectedValueOnce(
			new GraphQLError('Forbidden', { extensions: { http: { status: 403 } } })
		)

		await expect(run(aziendaDel, { _id: idAzienda })).rejects.toMatchObject({ message: 'Forbidden' })
		expect(funAziendaDelete).not.toHaveBeenCalled()
	})

	// A GraphQLError raised downstream of the ownership guard keeps its status instead of being
	// flattened to a 500 — that is the whole reason the catch goes through tryCatchRethrow.
	it('keeps a downstream GraphQL error instead of flattening it', async () => {
		funAziendaDelete.mockRejectedValueOnce(new GraphQLError('Conflict', { extensions: { http: { status: 409 } } }))

		await expect(run(aziendaDel, { _id: idAzienda })).rejects.toMatchObject({
			message: 'Conflict',
			extensions: { http: { status: 409 } }
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		funAziendaDelete.mockRejectedValueOnce(driverError)

		await expect(run(aziendaDel, { _id: idAzienda })).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})
