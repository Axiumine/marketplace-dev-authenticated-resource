import { GraphQLID, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql'
import GraphQLUpload from 'graphql-upload/GraphQLUpload.mjs'

/**
 * An item as its owner fills it in — every field of `GraphQLItem` except `_id`, which the server
 * mints, and `published`, which is not part of the card.
 *
 * `idCompany` **is** here, unlike `GraphQLInputCompany`'s missing `idShopOwner`: an owner may hold
 * several companies, so the shop an item belongs to is a choice the client makes rather than
 * something the session determines. It is checked against the session on every write —
 * `throwIfShopOwnerDontOwnCompany` — because an id the client sends is an id the client can guess.
 *
 * `idCategory` names a document of the platform-wide taxonomy, which only an admin may write. The
 * owner picks from it and cannot extend it, which is the point: two shops selling the same kind of
 * thing have to land in the same category or the customer-facing filter means nothing.
 *
 * Every field is non-null, matching the collection validator's `required` list — the collection was
 * created empty, so nothing is stranded by demanding them. `funItemUpdate` `$set`s the whole object,
 * so an optional field here would be a field that can never be cleared.
 *
 * ⚠️ **`image` is the one nullable field, and the only one that is not a value.** It is an `Upload` —
 * the file itself, arriving as a multipart part that `graphqlUploadKoa` (mounted in `index.mts`)
 * turns into a promise of a stream. It is nullable because an item may be created without a picture,
 * and because the field cannot be *echoed back*: an `Upload` is write-only by construction, so a
 * client editing an item has no way to resend the file it did not change.
 *
 * ⚠️ **This input is shared with `itemUpdate`, which must never write it.** Only `itemAdd` consumes
 * the upload; a save that carried one would hand `funItemUpdate` a promise to `$set` into a `string`
 * path. `funItemUpdate` strips the key at the write for that reason — the type system cannot, because
 * what arrives over the wire is not what the type says.
 *
 * ⚠️ **`published` is deliberately absent.** Publishing is its own operation on both tiers —
 * `itemUpdatePublished` here and on 4024 — and not a side effect of saving the card. It used to be a
 * `Boolean!` in this input, which meant every save wrote the flag: an owner who reopened a stale form
 * republished an item an admin had just taken down, without ever asking to. `itemAdd` stamps
 * `false`, and the item stays a draft until someone publishes it on purpose.
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
		// The picture, as bytes. Nullable — see the header — and consumed by `itemAdd` alone.
		image: { type: GraphQLUpload }
	})
})
