import { uploadTempImage } from '@axiumine/koa-utils/files/uploadTempImage'
import { IFileUpload } from '@axiumine/koa-utils/koa/IFileUpload'
import { Types } from 'mongoose'

/** A picture that has passed validation and is waiting in the temp directory to be filed. */
export interface IStoredItemImage {
	/** Where `uploadTempImage` left the re-encoded file — a temp path, not the final one. */
	tempFile: string
	/** The name the file will carry under `STATIC_FOLDER/item/<idCompany>/`, and the value stored on the item. */
	fileName: string
	/**
	 * The same name **without its extension**, and the only thing `moveFileStaticDomain` may be handed.
	 *
	 * ⚠️ It re-appends one. `moveTempFile`, underneath it, computes `path.extname(sourceFilePath)` from
	 * the temp file and joins `${destFilename}${ext}` — so passing `fileName` there lands the picture on
	 * disk as `<_id>.webp.webp`, while the document says `<_id>.webp` and every card renders a 404. The
	 * two names exist separately for that reason, and neither call site gets to build the other's.
	 */
	destBaseName: string
}

/**
 * Runs the upload half of adding a picture to an item: validate, scan, re-encode, and name the result.
 *
 * `uploadTempImage` (koa-utils, `files/`) does the dangerous part — extension and MIME check, ClamAV
 * scan, then a re-encode to webp, which is the step that matters most: the file that reaches the
 * static domain is one this process produced from decoded pixels, not one the client uploaded, so a
 * payload smuggled inside a valid image does not survive the round trip. It leaves the result in the
 * temp directory and answers where.
 *
 * ⚠️ **The file is named after the item's `_id`, not after what the client called it.** An uploader
 * controls its own filename, and that name would end up as a path segment on disk and inside a URL
 * three frontends build; `_id` is minted by the server, is unique by construction, cannot collide with
 * another item's picture and cannot contain a separator. The extension comes from `uploadTempImage`'s
 * own answer rather than from the upload, for the same reason.
 *
 * This returns rather than moves: the move is `moveFileStaticDomain`, and it belongs on the far side
 * of the insert. See `itemAdd` for why the two straddle it.
 *
 * ⚠️ **Both names are built here, and the difference between them is not cosmetic** — see
 * `destBaseName`. The extension comes from `uploadTempImage`'s answer rather than from the upload, so
 * the document's name and the file's name are two derivations of one value instead of two guesses.
 */
export async function storeItemImage(image: Promise<IFileUpload>, itemId: Types.ObjectId): Promise<IStoredItemImage> {
	const { tempFile, ext } = await uploadTempImage(image)
	const destBaseName = itemId.toHexString()

	return { tempFile, fileName: `${destBaseName}.${ext}`, destBaseName }
}
