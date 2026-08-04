import { GraphQLItemCategory } from '@ptypes/GraphQLItemCategory.mjs'
import { ItemCategory } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ItemCategory'
import { GraphQLList, GraphQLNonNull } from 'graphql'
import { trusted } from 'mongoose'

/**
 * The whole live category tree, flat.
 *
 * **Read-only on this tier by design.** Categories are platform taxonomy: only
 * `marketplace-dev-admin-authenticated-resource` writes them, and the two-level depth cap is enforced
 * there. A shop owner picks from this list when filing an item and can add nothing to it — which is
 * the point of a shared taxonomy, since a per-owner one would make the public category pages
 * meaningless.
 *
 * No session filter and no argument: the taxonomy is the same for every owner, so there is nothing
 * here that belongs to anybody. Flat rather than nested — `idParent` carries the shape and the client
 * assembles it, which keeps the type free of a recursive field the depth cap already bounds at two.
 *
 * Sorted by `position`, the ordinal the operator sets; `_id` breaks ties so the order is stable
 * between calls rather than left to whatever the storage engine returns.
 */
export const itemCategories = {
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLItemCategory))),
	description: 'Get item categories',
	async resolve() {
		return ItemCategory.find({ deleted: trusted({ $exists: false }) })
			.sort({ position: 1, _id: 1 })
			.lean()
	}
}
