import { throwGoneError } from '@axiumine/koa-utils/graphQL/throw/throwGoneError'
import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { unpublishOwnerStorefront } from '@lib/shopOwner/unpublishOwnerStorefront.mjs'
import mongoose, { trusted, Types } from 'mongoose'

/**
 * Closes the signed-in shop owner's own account, and takes their storefront off air with it.
 *
 * **A stamp, never a removal**, like every close on this platform. The document stays and gains a
 * `deleted` instant; `checkUserAuthorizationDisDel` already refuses a stamped account at the login gate,
 * so this one write is what shuts the account, and the mutation ends the live sessions on top of it.
 *
 * ⚠️ **No `deletedBy`, and the absence is the record** (ADR-044). That field holds an `admin._id`, so a
 * `deleted` stamp standing without one is what says the account holder closed it themselves. Writing the
 * owner's own id there would make a self-closure indistinguishable from an operator's — and a second
 * field naming which collection the actor came from would be a `role` field arriving by the back door,
 * which ADR-002 refuses.
 *
 * ⚠️ **`disabled` is not written here, in either direction, and that is the ruling rather than an
 * omission.** Suspension is the operator's instrument: *"if admin suspend an account, admin must remove
 * the suspension for allow the shopowner to log in again"*. A self-closure that also suspended would
 * hand the owner's own way back to an operator, and a self-closure that *cleared* a standing suspension
 * would let anyone launder one by closing and re-registering. An owner suspended before they closed comes
 * back suspended.
 *
 * ⚠️ **The storefront cascade shares this transaction** (ADR-045). A crash between the stamp and the
 * `published: false` writes leaves a closed owner with a live shop, which is the one failure that decision
 * exists to prevent. Nothing puts either back: an owner who returns through the registration undo keeps
 * their `_id` and therefore still owns every company and item, all of them dark and all of them theirs to
 * republish.
 *
 * ⚠️ **The filter refuses an account that is already closed, and that is a retention rule rather than
 * tidiness.** `deleted` starts the thirty-day clock ADR-041 measures and ADR-046 makes an undo window, so
 * a second stamp over the same document would push the scrub thirty days further out and postpone the
 * erasure the first one promised. `trusted()` is not optional: `sanitizeFilter` is global and strips a
 * bare `$exists`.
 *
 * The two refusals differ, and the difference is the whole reason the failure path reads the document. A
 * missing account is 401 — the session outlived what it authenticated as, and the caller learns their
 * session is no good and nothing more, the same answer the User tier's self-closure gives. An account
 * already stamped is 410, which is precisely *not* "your session is no good": the account is gone and the
 * session that named it was real. In practice the 410 is nearly unreachable, since the first call revoked
 * every session; it exists for the window where the write landed and the revoke did not.
 *
 * ⚠️ **The approval flag is left exactly as it is, and on this tier it could not be otherwise.** The Admin
 * tier's closure drops it so a closed account cannot sit in the approval queue; here the field is banned
 * outright by BC-03 — a ShopOwner-tier service able to write it is a service able to approve its own
 * account, which is why the eslint rule refuses the identifier anywhere in this repo. Nothing is lost by
 * obeying it: `shopOwnersActiveTblDb` already filters `deleted: { $exists: false }`, so a closed account is
 * out of the operator's queue whatever the flag says, and an owner who returns through the registration
 * undo comes back in the state they left — approved if they were approved, waiting if they were waiting.
 *
 * `new Date()`, not `Date.now()`: the retention sweep compares `deleted` against a cutoff and the model's
 * path is a `Date`. A number would be cast on the way out and read back as one either way — this stops the
 * two spellings existing.
 */
export async function funShopOwnerDel(_id: Types.ObjectId) {
	const session = await mongoose.startSession()

	try {
		await session.withTransaction(async () => {
			const ret = await ShopOwner.updateOne(
				{ _id: _id, deleted: trusted({ $exists: false }) },
				{ $set: { deleted: new Date() } }
			)
				.session(session)
				.exec()

			if (ret.matchedCount !== 1) {
				const owner = await ShopOwner.findById(_id).select('_id').session(session).lean()

				if (owner === null) throwUnauthorizedError()

				throwGoneError('account already closed')
			}

			await unpublishOwnerStorefront(_id, session)
		})
	} finally {
		await session.endSession()
	}
}
