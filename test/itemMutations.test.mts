import { GraphQLError } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextShopOwnerAuthenticatedResource } from '../src/lib/auth/IContextShopOwnerAuthenticatedResource.mts'

const captureException = vi.fn()

const itemCreate = vi.fn()
const throwIfShopOwnerDontOwnCompany = vi.fn()
const throwIfShopOwnerDontOwnItem = vi.fn()
const throwIfItemCategoryMissing = vi.fn()
const funItemUpdate = vi.fn()
const funItemUpdatePublished = vi.fn()
const funItemDelete = vi.fn()
const storeItemImage = vi.fn()
const moveFileStaticDomain = vi.fn()

// tryCatchRethrow is deliberately NOT mocked, as in `mutations.test.mts`: turning a driver error into
// the right GraphQL status is the behaviour under test. Only Sentry is stubbed.
vi.mock('@sentry/node', () => ({ captureException, captureMessage: vi.fn() }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Item', () => ({ Item: { create: itemCreate } }))
vi.mock('@lib/company/throwIfShopOwnerDontOwnCompany.mjs', () => ({ throwIfShopOwnerDontOwnCompany }))
vi.mock('@lib/item/throwIfShopOwnerDontOwnItem.mjs', () => ({ throwIfShopOwnerDontOwnItem }))
vi.mock('@lib/item/throwIfItemCategoryMissing.mjs', () => ({ throwIfItemCategoryMissing }))
vi.mock('@lib/item/funItemUpdate.mjs', () => ({ funItemUpdate }))
vi.mock('@lib/item/funItemUpdatePublished.mjs', () => ({ funItemUpdatePublished }))
vi.mock('@lib/item/funItemDelete.mjs', () => ({ funItemDelete }))
// The upload half is stubbed at its own two seams rather than exercised: `storeItemImage` reaches
// ClamAV and sharp, and `moveFileStaticDomain` writes into STATIC_FOLDER. What this file is testing is
// the *order* the three steps run in and what each is handed — see `itemAdd`'s header.
vi.mock('@lib/item/storeItemImage.mjs', () => ({ storeItemImage }))
vi.mock('@axiumine/koa-utils/files/moveFileStaticDomain', () => ({ moveFileStaticDomain }))

const { itemAdd } = await import('../src/graphQLApi/schema/mutations/itemAdd.mts')
const { itemUpdate } = await import('../src/graphQLApi/schema/mutations/itemUpdate.mts')
const { itemUpdatePublished } = await import('../src/graphQLApi/schema/mutations/itemUpdatePublished.mts')
const { itemDel } = await import('../src/graphQLApi/schema/mutations/itemDel.mts')

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
const idCompany = new Types.ObjectId('507f1f77bcf86cd799439015')
const idCategory = new Types.ObjectId('507f1f77bcf86cd799439030')
const itemId = new Types.ObjectId('507f1f77bcf86cd799439020')

const ctx = { state: { user: { _id: userId } } } as unknown as IContextShopOwnerAuthenticatedResource

// No `published`: it left `GraphQLInputItem` when publishing became its own mutation, so a client that
// still sent it would be rejected by GraphQL before any of this ran.
const item = {
	idCompany,
	idCategory,
	name: 'Sneaker',
	description: 'Baked this morning',
	slug: 'sneaker'
}

// What `graphql-upload` hands a resolver: a promise, never the stream itself. Its contents are never
// read here — `storeItemImage` is mocked — so an opaque marker is enough, and it is what the assertion
// that the resolver forwards the upload untouched is made against.
const upload = Promise.resolve({ filename: 'shoe.jpg' })

// What the mocked `storeItemImage` answers. The two names differ by the extension on purpose: the
// document stores `fileName`, and `moveFileStaticDomain` is handed `destBaseName`, because the move
// re-appends the temp file's own extension to whatever it is given.
const stored = {
	tempFile: '/tmp/upload/2a1d.webp',
	fileName: '507f1f77bcf86cd799439020.webp',
	destBaseName: '507f1f77bcf86cd799439020'
}

/** Anything not a Mongo duplicate-key / [Validator] error ends up a 500 through tryCatchRethrow. */
const driverError = new Error('connection reset')

// The shapes the two mocked guards really raise: `throwForbiddenError` names the status, while every
// koa-utils 404 carries the generic 'Oops' and puts the meaning in the status alone.
const forbidden = () => new GraphQLError('Forbidden', { extensions: { http: { status: 403 } } })
const notFound = () => new GraphQLError('Oops', { extensions: { http: { status: 404 } } })

type Resolver = { resolve: (...a: never[]) => unknown }

function run(mutation: Resolver, args: unknown) {
	return mutation.resolve(null as never, args as never, ctx as never)
}

beforeEach(() => {
	vi.clearAllMocks()
	itemCreate.mockResolvedValue({ _id: itemId })
	throwIfShopOwnerDontOwnCompany.mockResolvedValue(undefined)
	throwIfShopOwnerDontOwnItem.mockResolvedValue(undefined)
	throwIfItemCategoryMissing.mockResolvedValue(undefined)
	funItemUpdate.mockResolvedValue(undefined)
	funItemUpdatePublished.mockResolvedValue(undefined)
	funItemDelete.mockResolvedValue(undefined)
	storeItemImage.mockResolvedValue(stored)
	moveFileStaticDomain.mockResolvedValue(undefined)
})

describe('itemAdd', () => {
	// `idCompany` is client-supplied — it has to be, an owner may hold several shops — so the ownership
	// guard is the only thing between this mutation and stocking a stranger's shop.
	it('checks the shop then the category, and creates the item with a fresh _id', async () => {
		await expect(run(itemAdd, { item })).resolves.toEqual({ _id: itemId })

		expect(throwIfShopOwnerDontOwnCompany).toHaveBeenCalledExactlyOnceWith(userId, idCompany)
		expect(throwIfItemCategoryMissing).toHaveBeenCalledExactlyOnceWith(idCategory)

		const [doc] = itemCreate.mock.calls[0]
		expect(doc).toMatchObject(item)
		expect(doc._id).toBeInstanceOf(Types.ObjectId)
	})

	// The client cannot send the flag, so the resolver has to write one — `published` is `required` on
	// the collection and the insert fails without it. `false` and not `true`: a new item is a draft until
	// its owner publishes it on purpose, which is the whole point of the split.
	it('stamps the new item as an unpublished draft', async () => {
		await run(itemAdd, { item })

		const [doc] = itemCreate.mock.calls[0]
		expect(doc.published).toBe(false)
	})

	// The common case, and the one that has to stay cheap: an item with no picture must not reach the
	// upload machinery at all, and must be written without the path rather than with an empty one — the
	// validator's `image` is optional, and a null there is not the same document as a missing key.
	it('touches neither the temp directory nor the static domain when no picture was sent', async () => {
		await run(itemAdd, { item })

		expect(storeItemImage).not.toHaveBeenCalled()
		expect(moveFileStaticDomain).not.toHaveBeenCalled()

		const [doc] = itemCreate.mock.calls[0]
		expect(doc.image).toBeUndefined()
	})

	// The three steps of `itemAdd`'s header, in the one order that leaves nothing orphaned: store the
	// upload in the temp directory, write the document, and only then make the file publicly reachable.
	// The upload is forwarded as it arrived — a promise, which is what graphql-upload hands a resolver —
	// together with the `_id` the resolver has just minted, so the picture is named after the item
	// rather than after whatever the client called its file.
	it('stores the picture, writes the item, then publishes the file under the shop', async () => {
		await expect(run(itemAdd, { item: { ...item, image: upload } })).resolves.toEqual({ _id: itemId })

		const [doc] = itemCreate.mock.calls[0]
		expect(storeItemImage).toHaveBeenCalledExactlyOnceWith(upload, doc._id)

		// The document carries the file name and nothing else about the picture: not a path, not a URL,
		// and not the `Upload` it came from — that key is pulled out of the object before mongoose sees it.
		expect(doc.image).toBe(stored.fileName)

		// ⚠️ `destBaseName`, not `fileName`: `moveTempFile` under this call appends the temp file's own
		// extension to what it is handed, so passing the name with `.webp` already on it would land the
		// picture as `<_id>.webp.webp` while the document says `<_id>.webp`.
		expect(moveFileStaticDomain).toHaveBeenCalledExactlyOnceWith(
			stored.tempFile,
			'item',
			idCompany.toHexString(),
			stored.destBaseName
		)

		expect(itemCreate.mock.invocationCallOrder[0]).toBeGreaterThan(storeItemImage.mock.invocationCallOrder[0])
		expect(moveFileStaticDomain.mock.invocationCallOrder[0]).toBeGreaterThan(itemCreate.mock.invocationCallOrder[0])
	})

	// Nothing publicly served may belong to an item that was never created. The slug collision is the
	// ordinary way this insert fails, so it is the case worth pinning: the re-encoded file stays in the
	// temp directory, where the operating system reclaims it and where no URL points.
	it('leaves the picture in the temp directory when the insert fails', async () => {
		itemCreate.mockRejectedValueOnce(
			Object.assign(new Error('E11000 duplicate key error collection: item index: idCompany_slug_unique'), {
				errorResponse: { code: 11000 }
			})
		)

		await expect(run(itemAdd, { item: { ...item, image: upload } })).rejects.toMatchObject({
			extensions: { http: { status: 409 } }
		})
		expect(moveFileStaticDomain).not.toHaveBeenCalled()
	})

	// The upload is inside the same try as the two writes, and this is what says so: a file that fails
	// validation, the virus scan or the re-encode has to come back as the 500 tryCatchRethrow makes,
	// with the cause in Sentry — not as a raw rejection Apollo renders on its own terms.
	it('turns a rejected upload into a 500, without writing the item', async () => {
		const uploadFailure = new Error('Error storing image')
		storeItemImage.mockRejectedValueOnce(uploadFailure)

		await expect(run(itemAdd, { item: { ...item, image: upload } })).rejects.toThrow('Internal Server Error')
		expect(itemCreate).not.toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledExactlyOnceWith(uploadFailure)
	})

	// The residual case `itemAdd`'s header writes down and does not repair: the item exists, and the
	// client is told the call failed. Asserted so that the behaviour is a decision on record rather than
	// something a reader has to infer from where the try block happens to end.
	it('reports a 500 when the file cannot be published, and does not undo the item', async () => {
		const moveFailure = new Error('EXDEV: cross-device link not permitted')
		moveFileStaticDomain.mockRejectedValueOnce(moveFailure)

		await expect(run(itemAdd, { item: { ...item, image: upload } })).rejects.toThrow('Internal Server Error')
		expect(itemCreate).toHaveBeenCalledOnce()
		expect(captureException).toHaveBeenCalledExactlyOnceWith(moveFailure)
	})

	// Ownership first, existence second, and the order is the assertion: a caller who does not own the
	// shop must learn nothing about which category ids are real. The upload is behind both guards for a
	// second reason — it writes a file, scans it and re-encodes it, so a refused request that still ran
	// it would hand a stranger the expensive half of the mutation.
	it('does not reach the category check, the upload or the write, for a shop that is not the caller’s', async () => {
		throwIfShopOwnerDontOwnCompany.mockRejectedValueOnce(forbidden())

		await expect(run(itemAdd, { item: { ...item, image: upload } })).rejects.toMatchObject({ message: 'Forbidden' })
		expect(throwIfItemCategoryMissing).not.toHaveBeenCalled()
		expect(storeItemImage).not.toHaveBeenCalled()
		expect(itemCreate).not.toHaveBeenCalled()
	})

	it('does not write when the category does not exist', async () => {
		throwIfItemCategoryMissing.mockRejectedValueOnce(notFound())

		await expect(run(itemAdd, { item })).rejects.toMatchObject({ extensions: { http: { status: 404 } } })
		expect(itemCreate).not.toHaveBeenCalled()
	})

	// `{ idCompany, slug }` is unique, so a slug already used in this shop fails here — and has to reach
	// the client as a 409 rather than the 500 every other write failure becomes. It is also the case the
	// `return await` in the resolver exists for: without the await the rejection escapes the try and
	// surfaces as an unhandled rejection instead.
	it('turns a slug already taken in the same shop into a 409', async () => {
		itemCreate.mockRejectedValueOnce(
			Object.assign(new Error('E11000 duplicate key error collection: item index: idCompany_slug_unique'), {
				errorResponse: { code: 11000 }
			})
		)

		await expect(run(itemAdd, { item })).rejects.toMatchObject({
			message: 'Conflict',
			extensions: { http: { status: 409 } }
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		itemCreate.mockRejectedValueOnce(driverError)

		await expect(run(itemAdd, { item })).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})

describe('itemUpdate', () => {
	const args = { _id: itemId, item }

	// ⚠️ Three guards, because a save is also potentially a transfer: `idCompany` is part of the input,
	// so the source and the destination are two different companies and both have to belong to the
	// session. Dropping either half leaves a real hole — the item guard alone lets an owner push their
	// item into a stranger's shop, the company guard alone lets them pull a stranger's item into theirs.
	it('checks the item, then the destination shop, then the category, and delegates the save', async () => {
		await expect(run(itemUpdate, args)).resolves.toBe(true)

		expect(throwIfShopOwnerDontOwnItem).toHaveBeenCalledExactlyOnceWith(userId, itemId)
		expect(throwIfShopOwnerDontOwnCompany).toHaveBeenCalledExactlyOnceWith(userId, idCompany)
		expect(throwIfItemCategoryMissing).toHaveBeenCalledExactlyOnceWith(idCategory)
		expect(funItemUpdate).toHaveBeenCalledExactlyOnceWith(itemId, userId, item)
	})

	it('does not write, or check the destination, when the item is not the caller’s', async () => {
		throwIfShopOwnerDontOwnItem.mockRejectedValueOnce(forbidden())

		await expect(run(itemUpdate, args)).rejects.toMatchObject({ message: 'Forbidden' })
		expect(throwIfShopOwnerDontOwnCompany).not.toHaveBeenCalled()
		expect(funItemUpdate).not.toHaveBeenCalled()
	})

	// The transfer half: the caller owns the item and names a shop that is not theirs.
	it('does not write when the destination shop is not the caller’s', async () => {
		throwIfShopOwnerDontOwnCompany.mockRejectedValueOnce(forbidden())

		await expect(run(itemUpdate, args)).rejects.toMatchObject({ message: 'Forbidden' })
		expect(throwIfItemCategoryMissing).not.toHaveBeenCalled()
		expect(funItemUpdate).not.toHaveBeenCalled()
	})

	it('does not write when the category does not exist', async () => {
		throwIfItemCategoryMissing.mockRejectedValueOnce(notFound())

		await expect(run(itemUpdate, args)).rejects.toMatchObject({ extensions: { http: { status: 404 } } })
		expect(funItemUpdate).not.toHaveBeenCalled()
	})

	// A GraphQLError raised downstream of the guards keeps its status instead of being flattened to a
	// 500 — that is the whole reason the catch goes through tryCatchRethrow.
	it('keeps a downstream GraphQL error instead of flattening it', async () => {
		funItemUpdate.mockRejectedValueOnce(new GraphQLError('Conflict', { extensions: { http: { status: 409 } } }))

		await expect(run(itemUpdate, args)).rejects.toMatchObject({
			message: 'Conflict',
			extensions: { http: { status: 409 } }
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		funItemUpdate.mockRejectedValueOnce(driverError)

		await expect(run(itemUpdate, args)).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})

describe('itemUpdatePublished', () => {
	// One guard, not three: nothing moves, so the only question is whether the item is the session's.
	// The company and category guards must stay out of it — reaching for them here would make publishing
	// fail on a category an operator retired, which has nothing to do with what the owner asked.
	it('checks ownership alone, then delegates the flag', async () => {
		await expect(run(itemUpdatePublished, { _id: itemId, published: true })).resolves.toBe(true)

		expect(throwIfShopOwnerDontOwnItem).toHaveBeenCalledExactlyOnceWith(userId, itemId)
		expect(throwIfShopOwnerDontOwnCompany).not.toHaveBeenCalled()
		expect(throwIfItemCategoryMissing).not.toHaveBeenCalled()
		expect(funItemUpdatePublished).toHaveBeenCalledExactlyOnceWith(itemId, userId, true)
	})

	// Both directions through the same resolver: withdrawing is the same call with the flag the other
	// way round, and nothing in between rewrites it.
	it('passes false through unchanged when the owner withdraws the item', async () => {
		await expect(run(itemUpdatePublished, { _id: itemId, published: false })).resolves.toBe(true)

		expect(funItemUpdatePublished).toHaveBeenCalledExactlyOnceWith(itemId, userId, false)
	})

	it('does not write when the item is not the caller’s', async () => {
		throwIfShopOwnerDontOwnItem.mockRejectedValueOnce(forbidden())

		await expect(run(itemUpdatePublished, { _id: itemId, published: true })).rejects.toMatchObject({ message: 'Forbidden' })
		expect(funItemUpdatePublished).not.toHaveBeenCalled()
	})

	// The `$expr`-style refusals live on `company`, not here, but a downstream GraphQLError still has to
	// keep its status rather than be flattened — same reason `itemUpdate` asserts it.
	it('keeps a downstream GraphQL error instead of flattening it', async () => {
		funItemUpdatePublished.mockRejectedValueOnce(new GraphQLError('Conflict', { extensions: { http: { status: 409 } } }))

		await expect(run(itemUpdatePublished, { _id: itemId, published: true })).rejects.toMatchObject({
			message: 'Conflict',
			extensions: { http: { status: 409 } }
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		funItemUpdatePublished.mockRejectedValueOnce(driverError)

		await expect(run(itemUpdatePublished, { _id: itemId, published: true })).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})

describe('itemDel', () => {
	it('checks ownership then delegates the withdrawal and answers true', async () => {
		await expect(run(itemDel, { _id: itemId })).resolves.toBe(true)

		expect(throwIfShopOwnerDontOwnItem).toHaveBeenCalledExactlyOnceWith(userId, itemId)
		expect(funItemDelete).toHaveBeenCalledExactlyOnceWith(itemId, userId)
	})

	// The guard filters `deleted`, so a second call on the same item answers 403 rather than repeating
	// the stamp — which is the only way an already-withdrawn item can be named at all, since it is gone
	// from `companyItems`.
	it('does not withdraw when the item is not the caller’s, or already withdrawn', async () => {
		throwIfShopOwnerDontOwnItem.mockRejectedValueOnce(forbidden())

		await expect(run(itemDel, { _id: itemId })).rejects.toMatchObject({ message: 'Forbidden' })
		expect(funItemDelete).not.toHaveBeenCalled()
	})

	it('turns a driver failure into a 500', async () => {
		funItemDelete.mockRejectedValueOnce(driverError)

		await expect(run(itemDel, { _id: itemId })).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})
