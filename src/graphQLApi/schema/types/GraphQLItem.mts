import { GraphQLItemFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLItemFrag'
import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * One thing a shop sells, as its owner sees it.
 *
 * `GraphQLItemFrag` carries the three fields every tier renders; `published` is added here because
 * this is a tier that can see a draft. The public tier will spread the same fragment and leave the
 * flag out, since an item it can return is published by definition.
 *
 * `idCompany` is exposed even though every read path here already filters by a company the session's
 * owner holds — the same argument `GraphQLCompany.idShopOwner` makes: the frontend keys its cache on
 * it, and a field the server refuses to say is a field the client infers from the query it happened
 * to run.
 *
 * `deleted` is not exposed at all. A retired item is filtered out of every read on this tier, so the
 * only value the field could ever carry over the wire is `null`.
 *
 * `image` is added here and **not** to `GraphQLItemFrag`, which is the shared one: putting it there
 * would publish the field on the admin tier and the public tier at once, neither of which has a
 * screen for it yet. This tier is where the picture is uploaded, so it is the tier that has to be able
 * to read back what the upload produced.
 *
 * It is nullable, unlike everything else the owner writes, because an item may have no picture — and
 * that null is precisely what the field is for. It is a **file name**, not a URL: the client builds
 * `<static>/item/<idCompany>/<image>`, and both segments it needs are on this same type.
 */
export const GraphQLItem = new GraphQLObjectType({
	name: 'GraphQLItem',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idCompany: { type: new GraphQLNonNull(GraphQLID) },
		idCategory: { type: new GraphQLNonNull(GraphQLID) },
		...GraphQLItemFrag,
		published: { type: new GraphQLNonNull(GraphQLBoolean) },
		// Nullable, and a file name rather than a URL — see the header.
		image: { type: GraphQLString }
	})
})
