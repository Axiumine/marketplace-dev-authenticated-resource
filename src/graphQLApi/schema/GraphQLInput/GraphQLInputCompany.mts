import { GraphQLAddressFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLAddressFrag'
import { GraphQLPositionFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql'

/**
 * The company as the owner fills it in — every field of `GraphQLCompany` except the two the server sets:
 * `_id`, and `idShopOwner`, which is the session's and never an argument on this tier.
 *
 * Replaces the company fields that used to be nested inside the old shop-add mutation, before `company`
 * had its own collection, and had to be retyped for every shop of the same chain. It gains `taxCode`
 * and `address`, which the embedded sub-document never carried.
 *
 * ⚠️ **`published` is deliberately absent**, for the reason `GraphQLInputItem` drops it: publishing a
 * shop is its own operation — `companyUpdatePublished`, on this tier and on 4024 — and not something a
 * save of the card decides. `companyAdd` stamps `false`, which is also what the `published: true`
 * requires `slug` and `publicName` clause of the validator wants from a shop that has just been typed
 * in.
 */
export const GraphQLInputCompany = new GraphQLInputObjectType({
	name: 'GraphQLInputCompany',
	fields: () => ({
		legalName: { type: new GraphQLNonNull(GraphQLString) },
		vatNumber: { type: new GraphQLNonNull(GraphQLString) },
		taxCode: { type: GraphQLString },
		contactPerson: { type: new GraphQLNonNull(GraphQLString) },
		administrator: { type: new GraphQLNonNull(GraphQLString) },
		uniqueCode: { type: GraphQLString },
		certifiedEmail: { type: new GraphQLNonNull(GraphQLString) },
		address: { type: new GraphQLNonNull(GraphQLInputCompanyAddress) },
		registryExtract: { type: new GraphQLNonNull(GraphQLString) },
		// The shop half. Mirrors `GraphQLCompany` field for field, because `funCompanyUpdate` `$set`s
		// the whole object — a field missing from this input is a field the owner can never clear.
		publicName: { type: GraphQLString },
		slug: { type: GraphQLString },
		description: { type: GraphQLString }
	})
})

const GraphQLInputCompanyAddress = new GraphQLInputObjectType({
	name: 'GraphQLInputCompanyAddress',
	fields: () => ({
		...GraphQLAddressFrag,
		position: { type: new GraphQLNonNull(GraphQLInputCompanyPosition) }
	})
})

const GraphQLInputCompanyPosition = new GraphQLInputObjectType({
	name: 'GraphQLInputCompanyPosition',
	fields: () => ({
		...GraphQLPositionFrag
	})
})
