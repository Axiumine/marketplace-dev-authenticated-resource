import { GraphQLBoolean, GraphQLID, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql'

/**
 * An item as its owner fills it in — every field of `GraphQLItem` except `_id`, which the server
 * mints.
 *
 * `idCompany` **is** here, unlike `GraphQLInputCompany`'s missing `idShopOwner`: an owner may hold
 * several companies, so the shop an item belongs to is a choice the client makes rather than
 * something the session determines. It is checked against the session on every write —
 * `throwIfShopOwnerDontOwnCompany` — because an id the client sends is an id the client can guess.
 *
 * `idCategory` names a document of the platform-wide taxonomy, which only an operator may write. The
 * owner picks from it and cannot extend it, which is the point: two shops selling the same kind of
 * thing have to land in the same category or the customer-facing filter means nothing.
 *
 * Every field is non-null, matching the collection validator's `required` list — the collection was
 * created empty, so nothing is stranded by demanding them. `funItemUpdate` `$set`s the whole object,
 * so an optional field here would be a field that can never be cleared.
 */
export const GraphQLInputItem = new GraphQLInputObjectType({
	name: 'GraphQLInputItem',
	fields: () => ({
		idCompany: { type: new GraphQLNonNull(GraphQLID) },
		idCategory: { type: new GraphQLNonNull(GraphQLID) },
		name: { type: new GraphQLNonNull(GraphQLString) },
		description: { type: new GraphQLNonNull(GraphQLString) },
		// Unique within the company, not globally: the route is `/shop/:slug/item/:itemSlug`, so the
		// shop segment already disambiguates and one shop's catalogue never constrains another's.
		slug: { type: new GraphQLNonNull(GraphQLString) },
		// Composes with the company's own flag — an item is publicly visible only if both are true —
		// so publishing an item in a draft shop is legal and simply shows nobody anything.
		published: { type: new GraphQLNonNull(GraphQLBoolean) }
	})
})
