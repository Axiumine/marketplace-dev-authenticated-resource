import { GraphQLItemCategoryFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLItemCategoryFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType } from 'graphql'

/**
 * A category as the shop owner sees it, which is read-only — the writes live on the operator tier.
 *
 * `idParent` is nullable and that nullability *is* the tree: absent means a top-level category,
 * present means a subcategory of the one it names. Depth is capped at two, so a client can assemble
 * the whole shape from one flat list without recursing.
 */
export const GraphQLItemCategory = new GraphQLObjectType({
	name: 'GraphQLItemCategory',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idParent: { type: GraphQLID },
		...GraphQLItemCategoryFrag
	})
})
