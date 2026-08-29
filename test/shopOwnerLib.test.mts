import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateOne = vi.fn()
const findById = vi.fn()
const companyFind = vi.fn()
const companyUpdateMany = vi.fn()
const itemUpdateMany = vi.fn()

/**
 * `vi.hoisted`, unlike the plain consts above, because this file imports `mongoose` itself: the mock
 * factory runs while that import is evaluated, which is before any top-level `const` here has been
 * initialised. The stand-in `withTransaction` runs the work it is handed exactly once — the retry a real
 * one performs on a `WriteConflict` is asserted by the one test that arms it.
 */
const { endSession, session, startSession, withTransaction } = vi.hoisted(() => {
	const endSessionFn = vi.fn()
	const withTransactionFn = vi.fn(async (work: () => Promise<void>) => await work())
	const sessionObj = { withTransaction: withTransactionFn, endSession: endSessionFn }

	return {
		endSession: endSessionFn,
		session: sessionObj,
		startSession: vi.fn(async () => sessionObj),
		withTransaction: withTransactionFn
	}
})

vi.mock('mongoose', async (importOriginal) => {
	const actual = await importOriginal<typeof import('mongoose')>()

	return { ...actual, default: { ...actual.default, startSession } }
})

// ⚠️ No `deleteOne` and no `findOneAndDelete` on any of the three mocks. Closing an account on this
// platform is a stamp, and the cascade withdraws documents rather than removing them, so a regression to
// a hard delete reaches for a method that is not here and fails against these mocks — not against a real
// database, and not after it has destroyed a shop.
vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { updateOne, findById }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Company', () => ({
	Company: { find: companyFind, updateMany: companyUpdateMany }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Item', () => ({
	Item: { updateMany: itemUpdateMany }
}))

const { funShopOwnerDel } = await import('../src/lib/shopOwner/funShopOwnerDel.mts')
const { unpublishOwnerStorefront } = await import('../src/lib/shopOwner/unpublishOwnerStorefront.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

/** Two shops under the owner, so the item hop has a real `$in` rather than a degenerate one. */
const shopIds = [new Types.ObjectId('507f1f77bcf86cd7994390a1'), new Types.ObjectId('507f1f77bcf86cd7994390a2')]

/**
 * A session double, and what is asserted about it is which queries were handed it.
 *
 * ⚠️ **A query that does not join the session runs outside the transaction**, against its own snapshot,
 * and nothing in the result says so — the call succeeds and the atomicity ADR-045 asks for is gone.
 * `threaded` records every `.session()` argument in call order, so a dropped hop fails a test instead of
 * quietly leaving a closed owner with a live storefront.
 */
const threaded: unknown[] = []

/** `.session()` is a hop on the chain: it records what it was given and answers the rest of the chain. */
const sessioned = (tail: object) => ({
	session: vi.fn((clientSession: unknown) => {
		threaded.push(clientSession)

		return tail
	})
})

/** The session the transactional path opens, as the cascade receives it — the mock is not a `ClientSession`. */
const inSession = session as never

/** `ShopOwner.updateOne()` runs `.session()` before `.exec()`, so the chain is mocked two levels deep. */
function mockStamp(matchedCount: number) {
	updateOne.mockReturnValueOnce(sessioned({ exec: vi.fn().mockResolvedValue({ matchedCount, modifiedCount: 0 }) }))
}

/** The failure path's re-read: `findById().select().session().lean()`, answering the document or `null`. */
function mockReRead(doc: unknown) {
	findById.mockReturnValueOnce({ select: vi.fn(() => sessioned({ lean: vi.fn().mockResolvedValue(doc) })) })
}

/** The storefront cascade's three queries, armed with the companies the owner holds. */
function mockCascade(...ids: Types.ObjectId[]) {
	companyFind.mockReturnValueOnce(sessioned({ lean: vi.fn().mockResolvedValue(ids.map((idCompany) => ({ _id: idCompany }))) }))
	companyUpdateMany.mockReturnValueOnce(sessioned({ exec: vi.fn().mockResolvedValue({ matchedCount: ids.length }) }))
	itemUpdateMany.mockReturnValueOnce(sessioned({ exec: vi.fn().mockResolvedValue({ matchedCount: 0 }) }))
}

/** Every cascade query ran, once each, against the ids handed to `mockCascade`. */
function expectCascade(ids: Types.ObjectId[]) {
	expect(companyFind).toHaveBeenCalledExactlyOnceWith({ idShopOwner: _id }, '_id')
	expect(companyUpdateMany).toHaveBeenCalledExactlyOnceWith({ idShopOwner: _id }, { $set: { published: false } })
	expect(itemUpdateMany).toHaveBeenCalledExactlyOnceWith({ idCompany: trusted({ $in: ids }) }, { $set: { published: false } })
}

/** Nothing was withdrawn — the shape every refusal has to keep. */
function expectNoCascade() {
	expect(companyFind).not.toHaveBeenCalled()
	expect(companyUpdateMany).not.toHaveBeenCalled()
	expect(itemUpdateMany).not.toHaveBeenCalled()
}

/** The two arguments of the stamp, as it was actually made. */
function stampArgs() {
	const [filter, update] = updateOne.mock.calls[0]

	return { filter, update }
}

beforeEach(() => {
	vi.clearAllMocks()
	updateOne.mockReset()
	findById.mockReset()
	companyFind.mockReset()
	companyUpdateMany.mockReset()
	itemUpdateMany.mockReset()
	withTransaction.mockImplementation(async (work: () => Promise<void>) => await work())
	threaded.length = 0
})

describe('unpublishOwnerStorefront', () => {
	it('withdraws every company the owner holds and every item filed under one', async () => {
		mockCascade(...shopIds)

		await expect(unpublishOwnerStorefront(_id, inSession)).resolves.toBeUndefined()

		expectCascade(shopIds)
	})

	/*
	 * ⚠️ **The `$in` carries mongoose's trusted marker, and the assertion compares it.** `sanitizeFilter` is
	 * global in this service: an untrusted `$in` is stripped on the way to the driver, which turns the item
	 * hop into a filter that matches nothing — every item stays published under a shop that has just gone
	 * dark, and nothing fails. `toEqual` compares symbol-keyed properties, so a dropped `trusted()` fails here.
	 */
	it('marks the item filter as trusted', async () => {
		mockCascade(...shopIds)

		await unpublishOwnerStorefront(_id, inSession)

		const [filter] = itemUpdateMany.mock.calls[0]

		expect(filter.idCompany).toEqual(trusted({ $in: shopIds }))
	})

	/*
	 * ⚠️ Every query joins the caller's transaction, this one included. The cascade is the half of the close
	 * that ADR-045 makes atomic with the stamp: a company read or an item write outside the transaction sees
	 * — and leaves behind — a state the stamp is still free to roll back.
	 */
	it('runs all three queries inside the transaction it was handed', async () => {
		mockCascade(...shopIds)

		await unpublishOwnerStorefront(_id, inSession)

		expect(threaded).toEqual([inSession, inSession, inSession])
	})

	/*
	 * An owner with no companies is a real account — one that registered and never opened a shop. The company
	 * ids collapse to `$in: []`, which matches nothing and writes nothing, and both `updateMany` calls are
	 * still made: a `length > 0` short-circuit would be an extra branch buying nothing the driver does not
	 * already do.
	 */
	it('asks for an empty set when the owner holds no company', async () => {
		mockCascade()

		await expect(unpublishOwnerStorefront(_id, inSession)).resolves.toBeUndefined()

		expectCascade([])
	})
})

describe('funShopOwnerDel', () => {
	// A soft close: the document stays and `deleted` takes an instant. `trusted()` on the `$exists` is not
	// optional — `sanitizeFilter` is global here and strips a bare one, which would turn the filter into a
	// match on `deleted` literally equal to an object and stamp nothing at all.
	it('stamps deleted on an account that is not already closed', async () => {
		mockStamp(1)
		mockCascade(...shopIds)

		await expect(funShopOwnerDel(_id)).resolves.toBeUndefined()

		const { filter, update } = stampArgs()

		expect(filter).toEqual({ _id, deleted: trusted({ $exists: false }) })
		expect(update.$set.deleted).toBeInstanceOf(Date)
	})

	/*
	 * ⚠️ **One operator, and no `$unset` beside it.** The Admin tier's closure drops the approval flag here;
	 * this tier may not touch that field at all — BC-03 bans it, because a ShopOwner-tier service able to
	 * write it is one able to approve its own account. The assertion is on the whole update rather than on
	 * the flag by name, so that the eslint rule and this test cannot disagree about what is forbidden.
	 */
	it('writes one operator and nothing beside it', async () => {
		mockStamp(1)
		mockCascade()

		await funShopOwnerDel(_id)

		expect(Object.keys(stampArgs().update)).toEqual(['$set'])
	})

	/*
	 * ⚠️ **No `deletedBy`, and its absence is the record** (ADR-044). That field holds an `admin._id`, so a
	 * `deleted` stamp standing without one is what says the account holder closed it themselves. The whole
	 * `$set` is compared by key rather than only the missing field: an actor arriving later under any other
	 * name fails here too.
	 */
	it('records no actor, which is what tells a self-closure from an operator’s', async () => {
		mockStamp(1)
		mockCascade()

		await funShopOwnerDel(_id)

		expect(Object.keys(stampArgs().update.$set)).toEqual(['deleted'])
	})

	/*
	 * ⚠️ **`disabled` is untouched in either direction, and that is the ruling rather than an omission.**
	 * Setting it would hand the owner's own way back to an operator, since only the Admin tier lifts a
	 * suspension; clearing it would let anyone launder a standing suspension by closing and coming back.
	 * One assertion covers both directions: the test above pins the update to a lone `$set`, so a `$unset`
	 * clearing the flag cannot arrive without failing there.
	 */
	it('neither raises nor clears the suspension flag', async () => {
		mockStamp(1)
		mockCascade()

		await funShopOwnerDel(_id)

		expect(stampArgs().update.$set).not.toHaveProperty('disabled')
	})

	// ADR-045: the storefront goes dark with the account, in the same transaction as the stamp.
	it('withdraws every company and every item the owner holds', async () => {
		mockStamp(1)
		mockCascade(...shopIds)

		await funShopOwnerDel(_id)

		expectCascade(shopIds)
	})

	/*
	 * ⚠️ **One session, one transaction, and every query inside it.** A crash between the stamp and the
	 * cascade is the single failure ADR-045 exists to prevent: a closed owner whose shop is still on the
	 * public site. The four recorded hops are the stamp plus the cascade's three.
	 */
	it('runs the stamp and the cascade in one transaction', async () => {
		mockStamp(1)
		mockCascade(...shopIds)

		await funShopOwnerDel(_id)

		expect(startSession).toHaveBeenCalledOnce()
		expect(withTransaction).toHaveBeenCalledOnce()
		expect(threaded).toEqual([inSession, inSession, inSession, inSession])
	})

	/*
	 * ⚠️ **A second close is refused rather than allowed to reset the retention clock.** `deleted` is what
	 * the hourly sweep measures from (ADR-041) and what ADR-046 turns into the thirty-day undo window, so a
	 * second stamp over the same document would push the scrub thirty days further out and postpone the
	 * erasure the first one promised. 410 rather than 401: the account is gone, and the session that named
	 * it was real — the caller is not being told their credentials are no good.
	 */
	it('refuses an account already closed with a 410, and withdraws nothing', async () => {
		mockStamp(0)
		mockReRead({ _id })

		await expect(funShopOwnerDel(_id)).rejects.toMatchObject({
			message: 'Oops',
			extensions: { http: { status: 410 }, description: 'account already closed' }
		})

		expectNoCascade()
	})

	/*
	 * The other reason the filter can miss: no such document at all. The session outlived the account it
	 * authenticated as — a scrubbed one, or one removed out of band — and the honest answer is that the
	 * session is no good, which is the same answer the User tier's self-closure gives.
	 */
	it('answers 401 when no document carries that id', async () => {
		mockStamp(0)
		mockReRead(null)

		await expect(funShopOwnerDel(_id)).rejects.toMatchObject({
			message: 'Unauthorized',
			extensions: { http: { status: 401 } }
		})

		expectNoCascade()
	})

	// The re-read is what separates the two refusals, so it has to run in the transaction as well: read
	// outside it, it could answer from a snapshot the stamp has already moved past.
	it('re-reads the account inside the transaction to tell the two refusals apart', async () => {
		mockStamp(0)
		mockReRead({ _id })

		await expect(funShopOwnerDel(_id)).rejects.toThrow()

		expect(findById).toHaveBeenCalledExactlyOnceWith(_id)
		expect(threaded).toEqual([inSession, inSession])
	})

	it('closes the session after a successful close', async () => {
		mockStamp(1)
		mockCascade(...shopIds)

		await funShopOwnerDel(_id)

		expect(endSession).toHaveBeenCalledOnce()
	})

	// `finally`, not a trailing call: a refusal thrown out of the transaction must not leak the session it
	// opened, and a server that leaks one per refused call runs out of them.
	it('closes the session even when the write refused', async () => {
		mockStamp(0)
		mockReRead(null)

		await expect(funShopOwnerDel(_id)).rejects.toThrow()

		expect(endSession).toHaveBeenCalledOnce()
	})

	/*
	 * ⚠️ **`withTransaction` re-runs its callback after a `WriteConflict`, so everything inside it can happen
	 * twice.** Nothing here is minted per attempt and nothing accumulates: the filter still demands an
	 * unstamped document, and the aborted attempt committed nothing, so the retry finds the account exactly
	 * as the first attempt did and closes it once. The `deleted` instant is simply the retry's.
	 */
	it('closes the account once when the transaction is retried', async () => {
		withTransaction.mockImplementationOnce(async (work: () => Promise<void>) => {
			mockStamp(1)
			mockCascade(...shopIds)
			await work()

			mockStamp(1)
			mockCascade(...shopIds)
			await work()
		})

		await expect(funShopOwnerDel(_id)).resolves.toBeUndefined()

		expect(updateOne.mock.calls.map(([filter]) => filter)).toEqual([
			{ _id, deleted: trusted({ $exists: false }) },
			{ _id, deleted: trusted({ $exists: false }) }
		])
		expect(endSession).toHaveBeenCalledOnce()
	})
})
