import { GraphQLAddressFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLAddressFrag'
import { GraphQLPositionFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql'

/**
 * The company as the owner fills it in — every field of `GraphQLCompany` except the two the server sets:
 * `_id`, and `idShopOwner`, which is the session's and never an argument on this tier.
 *
 * Replaces `GraphQLInputPuntoVenditaCompany`, which was the same fields nested inside `puntoVenditaAdd`
 * and had to be retyped for every shop of the same chain. It gains `taxCode` and `address`, which the
 * embedded sub-document never carried.
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
		registryExtract: { type: new GraphQLNonNull(GraphQLString) }
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
