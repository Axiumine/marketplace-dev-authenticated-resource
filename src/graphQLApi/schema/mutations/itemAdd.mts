import { moveFileStaticDomain } from '@axiumine/koa-utils/files/moveFileStaticDomain'
import { OnlyIdType } from '@axiumine/koa-utils/graphQL/schema/types/OnlyIdType'
import { IFileUpload } from '@axiumine/koa-utils/koa/IFileUpload'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { IItemSchema } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IItemSchema'
import { GraphQLInputItem } from '@GraphQLInput/GraphQLInputItem.mjs'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { throwIfShopOwnerDontOwnCompany } from '@lib/company/throwIfShopOwnerDontOwnCompany.mjs'
import { IItemUpdate } from '@lib/item/funItemUpdate.mjs'
import { storeItemImage } from '@lib/item/storeItemImage.mjs'
import { throwIfItemCategoryMissing } from '@lib/item/throwIfItemCategoryMissing.mjs'
import { GraphQLError, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

/**
 * The card, plus the one member of `GraphQLInputItem` that is not part of it.
 *
 * `image` is absent from `IItemUpdate` deliberately — that type is what a *save* may write, and an
 * `Upload` is a stream, not a value a document can hold. This is the only place the two meet.
 */
interface IArgs {
	item: IItemUpdate & { image?: Promise<IFileUpload> }
}

/**
 * Adds an item to one of the signed-in owner's shops.
 *
 * Two guards, in this order, and both are load-bearing. `throwIfShopOwnerDontOwnCompany` refuses an
 * `idCompany` the session does not hold — without it, an owner could stock any shop on the platform,
 * because `idCompany` is a client-supplied id rather than something the session determines (an owner
 * may hold several companies, so it cannot be). `throwIfItemCategoryMissing` refuses a category that
 * does not exist, which the database will not do for us.
 *
 * Ownership first, existence second: a caller who does not own the shop learns nothing about which
 * category ids are real.
 *
 * Answers the new `_id`, like `companyAdd` and unlike the operator tier's `Boolean` — the owner's
 * flow continues with the item that was just created, and the id is what the next step needs.
 *
 * ## The picture
 *
 * `item.image` is an optional `Upload`, so adding an item and giving it a picture are one call rather
 * than two. Handling it takes two steps that **straddle the insert**, and the order is the whole of
 * the design:
 *
 * 1. `storeItemImage` validates, scans and re-encodes the upload into the temp directory, and names
 *    the result after the `_id` this resolver has already minted.
 * 2. `Item.create` writes the document, carrying that file name.
 * 3. `moveFileStaticDomain` publishes the file into `STATIC_FOLDER/item/<idCompany>/`.
 *
 * ⚠️ **Nothing reaches the static domain before the document exists.** A slug already taken in this
 * shop is the ordinary failure here — `idCompany_slug_unique` — and it fails at step 2, leaving the
 * upload in the temp directory where the operating system reclaims it and where no URL points. Moving
 * first would leave a publicly served file belonging to an item that was never created, which nothing
 * afterwards can find, attribute or clean up.
 *
 * ⚠️ **The residual case is the mirror of it, and it is not repaired here.** A move that fails after a
 * successful insert leaves an item naming a file that is not there: the client is answered with a 500,
 * Sentry has the cause, and the item exists all the same — so a retry collides with its own slug and
 * comes back 409. Nothing compensates for it, deliberately: a rollback would be a second write that can
 * fail in turn, and the state it would clean up is one an operator can see and fix. It is written down
 * here rather than left to be discovered.
 *
 * All three steps are inside the one try. Each is awaited, and each has to be: an unawaited promise
 * escapes the block entirely, so the ordinary failure of this mutation — a slug already taken in the
 * shop — would surface as an unhandled rejection instead of the 409 `tryCatchRethrow` makes of it. A
 * failed upload takes the same road and becomes a 500 with the cause in Sentry, which is the reason the
 * upload is inside the block rather than above it.
 */
export const itemAdd = {
	type: new GraphQLNonNull(OnlyIdType),
	description: 'add item',
	args: {
		item: { type: new GraphQLNonNull(GraphQLInputItem) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		await throwIfShopOwnerDontOwnCompany(ctx.state.user._id, args.item.idCompany)
		await throwIfItemCategoryMissing(args.item.idCategory)

		// `image` is pulled out of the object rather than spread with the rest: what arrives under that
		// key is a promise of a stream, and the document takes a file name.
		const { image, ...card } = args.item
		const _id = new Types.ObjectId()

		try {
			// Before the insert, and after both guards: an upload is expensive — it writes a file, scans it
			// with ClamAV and re-encodes it — and a caller who does not own the shop must not get any of
			// that out of a request that was going to be refused.
			const stored = image ? await storeItemImage(image, _id) : null

			// `published: false` is stamped here rather than taken from the input: publishing is
			// `itemUpdatePublished`, a second call the owner makes on purpose. A new item is a draft.
			//
			// `image` is `undefined` when there is no upload, which mongoose drops — the document is written
			// without the path, which is what the validator's optional `image` means.
			const newItem: IItemSchema = {
				_id,
				...card,
				published: false,
				image: stored?.fileName
			}

			const created = await Item.create(newItem)

			// Only now, with the document on disk, does the picture become publicly reachable. The two
			// path segments are fixed by the server: `item` is a literal, and `idCompany` is an id
			// `throwIfShopOwnerDontOwnCompany` has just matched against a real company of this session —
			// a malformed one never gets this far, and `moveFileStaticDomain` re-checks both for
			// traversal regardless.
			if (stored) {
				// ⚠️ `destBaseName`, never `fileName`: the move appends the temp file's own extension to
				// whatever it is handed, so the second would land as `<_id>.webp.webp`. See
				// `IStoredItemImage`.
				await moveFileStaticDomain(stored.tempFile, 'item', String(card.idCompany), stored.destBaseName)
			}

			return created
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
