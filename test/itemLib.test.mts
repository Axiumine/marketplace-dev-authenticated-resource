import { IFileUpload } from '@axiumine/koa-utils/koa/IFileUpload'
import { trusted, Types } from 'mongoose'
import { Readable } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const companyFind = vi.fn()
const itemUpdateOne = vi.fn()
const itemUpdateMany = vi.fn()
const itemCountDocuments = vi.fn()
const itemCategoryCountDocuments = vi.fn()
const itemCategoryFindOneAndUpdate = vi.fn()
const uploadTempImage = vi.fn()

vi.mock('@sentry/node', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))
// ⚠️ No `deleteOne` on the Item mock, for the reason `companyLib.test.mts` leaves it off Company:
// `funItemDelete` soft-deletes, and a regression to a hard removal has to fail here rather than
// against a real database three services away.
vi.mock('@axiumine/marketplace-common/models/MongoDB/Company', () => ({ Company: { find: companyFind } }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Item', () => ({
	Item: { updateOne: itemUpdateOne, updateMany: itemUpdateMany, countDocuments: itemCountDocuments }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/ItemCategory', () => ({
	ItemCategory: { countDocuments: itemCategoryCountDocuments, findOneAndUpdate: itemCategoryFindOneAndUpdate }
}))
// Stubbed rather than run: the real one writes the upload to disk, hands it to ClamAV and re-encodes it
// through sharp. What `storeItemImage` adds on top is the naming, and that is what is under test here.
vi.mock('@axiumine/koa-utils/files/uploadTempImage', () => ({ uploadTempImage }))

const { shopOwnerCompanyIds } = await import('../src/lib/company/shopOwnerCompanyIds.mts')
const { funItemDelete } = await import('../src/lib/item/funItemDelete.mts')
const { funItemUpdate } = await import('../src/lib/item/funItemUpdate.mts')
const { funItemUpdatePublished } = await import('../src/lib/item/funItemUpdatePublished.mts')
const { funItemsUpdatePublished } = await import('../src/lib/item/funItemsUpdatePublished.mts')
const { holdItemCategory } = await import('../src/lib/item/holdItemCategory.mts')
const { throwIfItemCategoryMissing } = await import('../src/lib/item/throwIfItemCategoryMissing.mts')
const { throwIfShopOwnerDontOwnItem } = await import('../src/lib/item/throwIfShopOwnerDontOwnItem.mts')
const { throwIfShopOwnerDontOwnAllItems } = await import('../src/lib/item/throwIfShopOwnerDontOwnAllItems.mts')
const { storeItemImage } = await import('../src/lib/item/storeItemImage.mts')

const shopOwnerId = new Types.ObjectId('507f1f77bcf86cd799439011')
const idCompany = new Types.ObjectId('507f1f77bcf86cd799439015')
const idOtherCompany = new Types.ObjectId('507f1f77bcf86cd799439016')
const itemId = new Types.ObjectId('507f1f77bcf86cd799439020')
const otherItemId = new Types.ObjectId('507f1f77bcf86cd799439021')
const idCategory = new Types.ObjectId('507f1f77bcf86cd799439030')

const updateExec = vi.fn()
const updateManyExec = vi.fn()

/**
 * A session double, and the only thing asserted about it is which queries were handed it.
 *
 * ⚠️ **A query that does not join the session runs outside the transaction**, against its own snapshot,
 * and nothing about the result says so — the call succeeds, the numbers look right, and the guarantee is
 * gone. `threaded` records every `.session()` argument in call order so a dropped hop fails a test
 * instead of quietly widening a window.
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

/** Company.find() ends `.session().lean().exec()`; countDocuments() ends `.lean()`. */
const finding = (docs: unknown[]) => sessioned({ lean: () => ({ exec: vi.fn().mockResolvedValue(docs) }) })
const counting = (found: number) => ({ lean: vi.fn().mockResolvedValue(found) })
/** findOneAndUpdate() ends `.session().lean()` — no `.exec()`, the chain is awaited as it stands. */
const holding = (doc: unknown) => sessioned({ lean: vi.fn().mockResolvedValue(doc) })

/**
 * updateOne() is chained two ways in this repo: `funItemUpdate` joins the session first, the publish and
 * the withdrawal go straight to `.exec()`. Both tails answer the same `updateExec`.
 */
const updating = () => ({ ...sessioned({ exec: updateExec }), exec: updateExec })

/** updateMany() is chained one way only — the bulk publish never joins a session, so `.exec()` is the whole tail. */
const updatingMany = () => ({ exec: updateManyExec })

/**
 * All three writes go through the same `updateOne` filter — `_id` plus the owner's live companies, and
 * nothing else — so the assertion is shared rather than restated. Returns the update half, which is
 * the only part that differs between a save, a publish and a withdrawal.
 */
function expectOwnerScopedWrite() {
	const [filter, update] = itemUpdateOne.mock.calls[0]
	expect(itemUpdateOne).toHaveBeenCalledOnce()
	expect(filter._id).toBe(itemId)
	expect(filter.idCompany).toEqual(trusted({ $in: [idCompany, idOtherCompany] }))
	expect(Object.keys(filter).sort()).toEqual(['_id', 'idCompany'])

	return update
}

/**
 * The bulk write's filter — the id set the caller named, plus the owner's live companies, and nothing
 * else. Same shape as the singular's, with the `_id` clause widened to a trusted `$in`, and asserted
 * the same way: on the exact key set, because a dropped `idCompany` clause makes the write succeed
 * against every shop on the platform instead of failing anything.
 */
function expectOwnerScopedBulkWrite(itemIds: Types.ObjectId[]) {
	const [filter, update] = itemUpdateMany.mock.calls[0]
	expect(itemUpdateMany).toHaveBeenCalledOnce()
	expect(filter._id).toEqual(trusted({ $in: itemIds }))
	expect(filter.idCompany).toEqual(trusted({ $in: [idCompany, idOtherCompany] }))
	expect(Object.keys(filter).sort()).toEqual(['_id', 'idCompany'])

	return update
}

// No `published`: it is outside `IItemUpdate`, so a whole-object `$set` of a save cannot carry the flag
// and `funItemUpdatePublished` is the only thing that writes it.
const data = {
	idCompany,
	idCategory,
	name: 'Sneaker',
	description: 'Baked this morning',
	slug: 'sneaker'
} as never

beforeEach(() => {
	companyFind.mockReset().mockReturnValue(finding([{ _id: idCompany }, { _id: idOtherCompany }]))
	itemUpdateOne.mockReset().mockReturnValue(updating())
	itemUpdateMany.mockReset().mockReturnValue(updatingMany())
	updateExec.mockReset().mockResolvedValue({ matchedCount: 1 })
	updateManyExec.mockReset().mockResolvedValue({ matchedCount: 2 })
	itemCountDocuments.mockReset().mockReturnValue(counting(1))
	itemCategoryCountDocuments.mockReset().mockReturnValue(counting(1))
	itemCategoryFindOneAndUpdate.mockReset().mockReturnValue(holding({ _id: idCategory }))
	uploadTempImage.mockReset()
	threaded.length = 0
})

describe('storeItemImage', () => {
	// storeItemImage forwards this untouched to uploadTempImage, mocked above, so the stream is never
	// actually read here — only the shape has to satisfy IFileUpload.
	const fakeUpload = (filename: string): IFileUpload => ({
		createReadStream: () => Readable.from([]),
		filename,
		mimetype: 'image/jpeg',
		encoding: '7bit'
	})

	// What graphql-upload hands a resolver — a promise, not the stream — forwarded untouched.
	const upload = Promise.resolve(fakeUpload('shoe.JPG'))

	// ⚠️ Two names out of one id, and the difference between them is load-bearing: the document stores
	// `fileName`, while `moveFileStaticDomain` takes `destBaseName`, because the move re-appends the temp
	// file's own extension to whatever it is handed. Handing it `fileName` writes `<_id>.webp.webp` to
	// disk while the item says `<_id>.webp`, and every card renders a 404.
	//
	// The name comes from the `_id` and never from `shoe.JPG`: an uploader controls its own filename, and
	// that name would land as a path segment on disk and inside a URL three frontends build.
	it('names the picture after the item, in both the forms its two callers need', async () => {
		uploadTempImage.mockResolvedValue({ tempFile: '/tmp/upload/2a1d.webp', ext: 'webp' })

		await expect(storeItemImage(upload, itemId)).resolves.toEqual({
			tempFile: '/tmp/upload/2a1d.webp',
			fileName: `${itemId.toHexString()}.webp`,
			destBaseName: itemId.toHexString()
		})
		expect(uploadTempImage).toHaveBeenCalledExactlyOnceWith(upload)
	})

	// The extension is whatever the re-encode says it produced, not a literal here and not the uploaded
	// file's. koa-utils answers `webp` today; the day it answers anything else, the document has to say
	// the same thing the file on disk does.
	it('takes the extension from the re-encode rather than assuming one', async () => {
		uploadTempImage.mockResolvedValue({ tempFile: '/tmp/upload/2a1d.avif', ext: 'avif' })

		await expect(storeItemImage(upload, itemId)).resolves.toMatchObject({
			fileName: `${itemId.toHexString()}.avif`
		})
	})
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

	// ⚠️ The session is optional and defaults to `null`, which mongoose reads as "no session" — so the
	// hop is unconditional and the four callers outside a transaction need no branch. `funItemUpdate` is
	// the one that passes a session, and its filter has to be built from the same snapshot as the write
	// it scopes, or the two read different states of the owner's companies.
	it('runs outside any transaction unless it is handed a session', async () => {
		await shopOwnerCompanyIds(shopOwnerId)

		expect(threaded).toEqual([null])
	})

	it('joins the caller’s transaction when it is handed one', async () => {
		await shopOwnerCompanyIds(shopOwnerId, session)

		expect(threaded).toEqual([session])
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

describe('throwIfShopOwnerDontOwnAllItems', () => {
	const itemIds = [itemId, otherItemId]

	// The same two hops as the singular, over a set: `shopOwnerCompanyIds` first, then one count scoped
	// to it. The exact key set is asserted for the same reason — a dropped clause does not fail anything,
	// it just makes the guard start passing.
	it('passes when every id in the list hangs off one of the owner’s live companies', async () => {
		itemCountDocuments.mockReturnValueOnce(counting(2))

		await expect(throwIfShopOwnerDontOwnAllItems(shopOwnerId, itemIds)).resolves.toBeUndefined()

		const [filter] = itemCountDocuments.mock.calls[0]
		expect(companyFind).toHaveBeenCalledOnce()
		expect(itemCountDocuments).toHaveBeenCalledOnce()
		expect(filter._id).toEqual(trusted({ $in: itemIds }))
		expect(filter.deleted).toEqual(trusted({ $exists: false }))
		expect(filter.idCompany).toEqual(trusted({ $in: [idCompany, idOtherCompany] }))
		expect(Object.keys(filter).sort()).toEqual(['_id', 'deleted', 'idCompany'])
	})

	// ⚠️ The case the whole guard exists for, and the one a `found === 0` check would let through: a list
	// that is mostly the owner's own with one stranger's id folded into it. All or nothing — anything
	// else applies the write to part of the list and tells the caller, one call at a time, which ids are
	// real.
	it('answers 403 when one id in the list is not the owner’s', async () => {
		itemCountDocuments.mockReturnValueOnce(counting(1))

		await expect(throwIfShopOwnerDontOwnAllItems(shopOwnerId, itemIds)).rejects.toThrow('Forbidden')
	})

	it('answers 403 when none of them are', async () => {
		itemCountDocuments.mockReturnValueOnce(counting(0))

		await expect(throwIfShopOwnerDontOwnAllItems(shopOwnerId, itemIds)).rejects.toThrow('Forbidden')
	})

	it('answers 403 for an owner who holds no company at all', async () => {
		companyFind.mockReturnValueOnce(finding([]))
		itemCountDocuments.mockReturnValueOnce(counting(0))

		await expect(throwIfShopOwnerDontOwnAllItems(shopOwnerId, itemIds)).rejects.toThrow('Forbidden')
		expect(itemCountDocuments.mock.calls[0][0].idCompany).toEqual(trusted({ $in: [] }))
	})

	// ⚠️ On record rather than by accident: an empty list counts zero documents against zero entries and
	// passes. Refusing it is `itemsUpdatePublished`'s job, where the answer can be the 400 an empty
	// selection deserves — a 403 here would tell an owner they do not own items they never named.
	it('has nothing to refuse about an empty list', async () => {
		itemCountDocuments.mockReturnValueOnce(counting(0))

		await expect(throwIfShopOwnerDontOwnAllItems(shopOwnerId, [])).resolves.toBeUndefined()
	})
})

describe('throwIfItemCategoryMissing', () => {
	// Nothing enforces the reference, so `item.idCategory` can name a category that never existed.
	// This is the only thing standing between a typo in a client and an item no listing can reach.
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

describe('holdItemCategory', () => {
	// ⚠️ **A read would not have closed the race, which is why this is a write.** `funItemCategoryDelete`
	// on 4024 counts the items filed under a category and stamps `deleted` when it finds none; an insert
	// here that only *read* the category commits alongside that stamp, because MongoDB transactions are
	// snapshot-isolated rather than serialisable and both sides saw a consistent snapshot. `$inc` makes
	// this transaction a writer of the document the delete writes, so the server aborts one of them with a
	// `WriteConflict` and `withTransaction` retries it.
	//
	// The assertion is on the exact update, not on the call alone: a mutant that dropped the `$inc` for an
	// empty update would still find the document and still pass a check that only looked at the filter.
	it('takes the category as a write, so a concurrent delete collides with it', async () => {
		await expect(holdItemCategory(idCategory, session)).resolves.toBeUndefined()

		const [filter, update, options] = itemCategoryFindOneAndUpdate.mock.calls[0]
		expect(itemCategoryFindOneAndUpdate).toHaveBeenCalledOnce()
		expect(filter._id).toBe(idCategory)
		// A retired category is invisible to every read path, so filing an item under one would produce an
		// item no listing can reach — the same clause the cheap pre-flight carries.
		expect(filter.deleted).toEqual(trusted({ $exists: false }))
		expect(Object.keys(filter).sort()).toEqual(['_id', 'deleted'])
		// `__v` because nothing reads it: mongoose maintains it for `save()` on documents with arrays,
		// this collection is never written that way, and the validator already declares it an int.
		expect(update).toEqual({ $inc: { __v: 1 } })
		// The answer needed is whether the document is there; the category's own fields are none of this
		// service's business, and pulling them would put the whole taxonomy row on the wire per item write.
		expect(options).toEqual({ projection: { _id: 1 } })
	})

	// ⚠️ Held *inside* the caller's transaction or held for nothing: a hop taken against the default
	// session writes the category in a transaction of its own, which commits immediately and collides with
	// no one.
	it('takes it inside the caller’s transaction', async () => {
		await holdItemCategory(idCategory, session)

		expect(threaded).toEqual([session])
	})

	// 404 rather than 403, for the reason the pre-flight gives: the taxonomy is platform-wide public data,
	// so a missing category is a stale client or a typo. A retired one is missing — `deleted` is in the
	// filter — which is also how the loser of the race answers after its retry.
	it('answers 404 when the category is absent or retired', async () => {
		itemCategoryFindOneAndUpdate.mockReturnValueOnce(holding(null))

		await expect(holdItemCategory(idCategory, session)).rejects.toMatchObject({
			message: 'Oops',
			extensions: { http: { status: 404 } }
		})
	})
})

describe('funItemUpdate', () => {
	// ⚠️ The `idCompany` clause reads the STORED item, not the update — defence in depth behind
	// `throwIfShopOwnerDontOwnItem`, refusing the write a second time if the item moved out from under
	// the session in between. The destination in `data` is the resolver's to check: a filter cannot
	// check a value it is about to write.
	// The `$set` is asserted whole, which is also what pins `published` out of it: a save writes the
	// card and leaves the publish flag exactly where the owner or an admin last put it.
	it('saves the whole item, scoped to the companies its owner holds', async () => {
		await expect(funItemUpdate(itemId, shopOwnerId, data, session)).resolves.toBeUndefined()

		expect(expectOwnerScopedWrite()).toEqual({ $set: data })
	})

	// ⚠️ Both queries join the session, not just the write. The filter is built from
	// `shopOwnerCompanyIds`, so a company read taken outside the transaction would scope the update by a
	// different snapshot than the one the update commits in.
	it('runs the company read and the write in the caller’s transaction', async () => {
		await funItemUpdate(itemId, shopOwnerId, data, session)

		expect(threaded).toEqual([session, session])
	})

	// `matchedCount`, not `modifiedCount`: saving an item unchanged matches one document and modifies
	// none, and that is a successful save — reading the other counter would 500 on every no-op.
	it('accepts a save that changed nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		await expect(funItemUpdate(itemId, shopOwnerId, data, session)).resolves.toBeUndefined()
	})

	it('raises a 500 when the filter matched nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funItemUpdate(itemId, shopOwnerId, data, session)).rejects.toThrow('Internal Server Error')
	})

	// ⚠️ The type says this cannot happen and the wire says otherwise. `GraphQLInputItem` declares
	// `image: Upload` so `itemAdd` can take a picture in the same call, and GraphQL hands the very same
	// input to `itemUpdate` — so a save is free to arrive carrying a promise of a stream. A whole-object
	// `$set` would then write it into a path the validator declares a string, and the save fails on the
	// one mutation a client can reach it from. The key is dropped at the write rather than in the
	// resolver because there is exactly one `$set` here and a second caller cannot bypass it.
	//
	// The assertion is on the whole update object, not on `image` alone: a `toBeUndefined` on the key
	// would also pass if the strip had quietly taken the rest of the card with it.
	it('never writes an image, whatever the client sent under that key', async () => {
		const withUpload = { ...(data as object), image: Promise.resolve({ filename: 'shoe.jpg' }) } as never

		await expect(funItemUpdate(itemId, shopOwnerId, withUpload, session)).resolves.toBeUndefined()

		expect(expectOwnerScopedWrite()).toEqual({ $set: data })
	})

	// The copy is the guard: stripping the key off the caller's own object would mutate the resolver's
	// `args`, which is a side effect on a value the caller still holds.
	it('leaves the object it was given untouched', async () => {
		const image = Promise.resolve({ filename: 'shoe.jpg' })
		const withUpload = { ...(data as object), image } as never

		await funItemUpdate(itemId, shopOwnerId, withUpload, session)

		expect((withUpload as { image?: unknown }).image).toBe(image)
	})
})

describe('funItemUpdatePublished', () => {
	// One field and nothing else — that is the whole difference from `funItemUpdate`, and the assertion
	// on the exact key set of `$set` is what enforces it. A regression that widened this into a save
	// would bring back the window the split closed.
	it('writes the flag alone, scoped to the companies its owner holds', async () => {
		await expect(funItemUpdatePublished(itemId, shopOwnerId, true)).resolves.toBeUndefined()

		expect(expectOwnerScopedWrite()).toEqual({ $set: { published: true } })
	})

	it('withdraws with the same call and the flag the other way round', async () => {
		await expect(funItemUpdatePublished(itemId, shopOwnerId, false)).resolves.toBeUndefined()

		expect(expectOwnerScopedWrite()).toEqual({ $set: { published: false } })
	})

	// `matchedCount`, not `modifiedCount`: publishing something already published matches one document
	// and modifies none, and that is the state the owner asked for.
	it('accepts a publish that changed nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		await expect(funItemUpdatePublished(itemId, shopOwnerId, true)).resolves.toBeUndefined()
	})

	// Unlike the admin tier's 404, this is a 500: `throwIfShopOwnerDontOwnItem` has already answered
	// 403 for anything the session does not hold, so a filter that matches nothing here means the item
	// moved between the guard and the write — not a client error.
	it('raises a 500 when the filter matched nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funItemUpdatePublished(itemId, shopOwnerId, true)).rejects.toThrow('Internal Server Error')
	})
})

describe('funItemsUpdatePublished', () => {
	const itemIds = [itemId, otherItemId]

	// One `updateMany`, one `$set`, one field — the bulk shape of the singular, and the exact key set of
	// `$set` is what keeps it that way. A widened update here would write every selected card at once.
	it('writes the flag alone across the list, scoped to the companies its owner holds', async () => {
		await expect(funItemsUpdatePublished(itemIds, shopOwnerId, true)).resolves.toBeUndefined()

		expect(expectOwnerScopedBulkWrite(itemIds)).toEqual({ $set: { published: true } })
	})

	it('withdraws the whole list with the same call and the flag the other way round', async () => {
		await expect(funItemsUpdatePublished(itemIds, shopOwnerId, false)).resolves.toBeUndefined()

		expect(expectOwnerScopedBulkWrite(itemIds)).toEqual({ $set: { published: false } })
	})

	// `matchedCount`, not `modifiedCount`: a select-all over a shop where half the cards already carry
	// the flag matches every one of them and modifies some, and that is the state the owner asked for.
	it('accepts a bulk publish where nothing needed changing', async () => {
		updateManyExec.mockResolvedValueOnce({ matchedCount: 2, modifiedCount: 0 })

		await expect(funItemsUpdatePublished(itemIds, shopOwnerId, true)).resolves.toBeUndefined()
	})

	// ⚠️ Compared against the length of the list, not against zero. `throwIfShopOwnerDontOwnAllItems` has
	// just proved all of them are the session's, so a write that reached fewer means the set moved
	// underneath — and a partial application the owner was told nothing about is the one outcome this
	// mutation must never have.
	it('raises a 500 when the write reached fewer items than were named', async () => {
		updateManyExec.mockResolvedValueOnce({ matchedCount: 1 })

		await expect(funItemsUpdatePublished(itemIds, shopOwnerId, true)).rejects.toThrow('Internal Server Error')
	})

	it('raises a 500 when the write reached nothing at all', async () => {
		updateManyExec.mockResolvedValueOnce({ matchedCount: 0 })

		await expect(funItemsUpdatePublished(itemIds, shopOwnerId, true)).rejects.toThrow('Internal Server Error')
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
