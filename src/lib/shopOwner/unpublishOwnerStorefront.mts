import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { ClientSession, trusted, Types } from 'mongoose'

/**
 * Takes an inactive shop owner's whole storefront off air: every company they hold, and every item filed
 * under one of those companies (ADR-045 and its Amendment).
 *
 * ⚠️ **The Admin tier holds an identical function, and the two must not drift.** Its copy hangs off a
 * suspension and off an operator closure; this one hangs off the owner closing their own account. The
 * platform owner's ruling names both hands at once — *"so disable a shop owner, by shop owner or by
 * admin, unpublish companies and items"* — so a change to the rule is a change to both files, and the
 * honest fix is to move this into `marketplace-common` and delete both. That move is deliberately not
 * made here: the library is published, a consumer's `yarn install` is authoritative, and shipping a
 * symbol no release carries would break every install until it is published.
 *
 * ⚠️ **Nothing here has an inverse, and building one contradicts the ruling.** Restoring a closed account
 * writes to the `shopOwner` document alone; the shops and the catalogue stay dark until the owner
 * republishes them by hand. Remembering what was published before is the option ADR-045 rejected. The
 * owner's remedy is `itemsUpdatePublished` — select-all, one call — not a symmetry here.
 *
 * ⚠️ **Both writes belong in the caller's transaction, which is why `session` is required rather than
 * optional.** A crash between the `shopOwner` stamp and these two leaves a closed owner with a live
 * storefront, the single failure ADR-045 exists to prevent. Passing `null` would type-check and would
 * silently reopen that window.
 *
 * **The item hop cannot be shortened.** `item` carries no `idShopOwner` — ownership is transitive through
 * `idCompany`, exactly as `throwIfShopOwnerDontOwnItem` documents — so the company ids have to be read
 * before the items can be named.
 *
 * **No `deleted` clause on the company read, and no empty-list branch.** A retired company is invisible
 * either way and unpublishing it costs nothing, while a filter that skipped it would leave its items
 * addressable if it were ever restored. An owner with no companies produces `$in: []`, which matches
 * nothing and writes nothing.
 *
 * `{ idShopOwner }` and `{ _id }` carry no `$`-keyed value and need no `trusted()`; the `$in` does, because
 * `sanitizeFilter` is global and would strip it.
 */
export async function unpublishOwnerStorefront(idShopOwner: Types.ObjectId, session: ClientSession) {
	const companies = await Company.find({ idShopOwner: idShopOwner }, '_id').session(session).lean<{ _id: Types.ObjectId }[]>()

	await Company.updateMany({ idShopOwner: idShopOwner }, { $set: { published: false } })
		.session(session)
		.exec()

	await Item.updateMany({ idCompany: trusted({ $in: companies.map((company) => company._id) }) }, { $set: { published: false } })
		.session(session)
		.exec()
}
