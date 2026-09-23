import { IItemUpdate } from '@lib/item/funItemUpdate.mjs'
import { requiredSlug, requiredText } from '@lib/validate/fields.mjs'

/*
 * From marketplace-db-setup/lib/schemas/item.js. `slug` is longer than `name` on purpose, and both
 * bounds are the collection's own — mirroring the admin tier's `validateItemCategory.mts`, which carries
 * the same relationship for the sibling taxonomy collection.
 */
const MAX_NAME = 150
const MAX_DESCRIPTION = 2000
const MAX_SLUG = 160

/**
 * An item, every field `companyAdd`/`itemUpdate` may write, normalised and ready to be written whole.
 *
 * `idCompany` and `idCategory` are passed through untouched. Whether either one names a document that
 * exists, is live and belongs to this owner cannot be answered here — that takes a database read — so it
 * stays the resolver's job: `throwIfShopOwnerDontOwnCompany`, `throwIfItemCategoryMissing` and
 * `holdItemCategory`/`holdCompany`. What this guarantees is the *shape* of the three text fields, the
 * same split `validateItemCategory` draws between what a validator can check on its own and what only a
 * read can.
 *
 * No optional fields here, unlike `validateCompany`: every member of `IItemUpdate` is `required` on the
 * collection and non-null on `GraphQLInputItem`, so there is nothing for the caller to clear and no
 * `$unset` half to build.
 */
export const validateItem = (item: IItemUpdate): IItemUpdate => ({
	idCompany: item.idCompany,
	idCategory: item.idCategory,
	name: requiredText(item.name, 'item.name', MAX_NAME),
	description: requiredText(item.description, 'item.description', MAX_DESCRIPTION),
	slug: requiredSlug(item.slug, 'item.slug', MAX_SLUG)
})
