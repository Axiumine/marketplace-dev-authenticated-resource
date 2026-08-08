import { GraphQLItemFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLItemFrag'
import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType } from 'graphql'

/**
 * One thing a shop sells, as its owner sees it.
 *
 * `GraphQLItemFrag` carries the three fields every tier renders; `published` is added here because
 * this is a tier that can see a draft. The public tier will spread the same fragment and leave the
 * flag out, since a row it can return is published by definition.
 *
 * `idCompany` is exposed even though every read path here already filters by a company the session's
 * owner holds — the same argument `GraphQLCompany.idShopOwner` makes: the frontend keys its cache on
 * it, and a field the server refuses to say is a field the client infers from the query it happened
 * to run.
 *
 * `deleted` is not exposed at all. A retired item is filtered out of every read on this tier, so the
 * only value the field could ever carry over the wire is `null`.
 */
export const GraphQLItem = new GraphQLObjectType({
	name: 'GraphQLItem',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idCompany: { type: new GraphQLNonNull(GraphQLID) },
		idCategory: { type: new GraphQLNonNull(GraphQLID) },
		...GraphQLItemFrag,
		published: { type: new GraphQLNonNull(GraphQLBoolean) }
	})
})
