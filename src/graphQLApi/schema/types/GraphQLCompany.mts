import { GraphQLBaseAddressFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLBaseAddressFrag'
import { GraphQLPositionFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * The company behind one or more punti vendita, its own collection since 20260803000000.
 *
 * `idShopOwner` is exposed even though every read path on this tier already filters by the session's
 * owner: the frontend keys its cache on it, and a field the server refuses to say is a field the client
 * has to infer from the query it happened to run.
 *
 * `taxCode` and `uniqueCode` are the only nullable ones — the collection stores them when given and leaves them
 * out otherwise, which is not the same as storing an empty string.
 */
export const GraphQLCompany = new GraphQLObjectType({
	name: 'GraphQLCompany',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idShopOwner: { type: new GraphQLNonNull(GraphQLID) },
		legalName: { type: new GraphQLNonNull(GraphQLString) },
		vatNumber: { type: new GraphQLNonNull(GraphQLString) },
		taxCode: { type: GraphQLString },
		contactPerson: { type: new GraphQLNonNull(GraphQLString) },
		administrator: { type: new GraphQLNonNull(GraphQLString) },
		uniqueCode: { type: GraphQLString },
		certifiedEmail: { type: new GraphQLNonNull(GraphQLString) },
		address: { type: new GraphQLNonNull(GraphQLCompanyAddress) },
		registryExtract: { type: new GraphQLNonNull(GraphQLString) }
	})
})

const GraphQLCompanyAddress = new GraphQLObjectType({
	name: 'GraphQLCompanyAddress',
	fields: () => ({
		...GraphQLBaseAddressFrag,
		position: { type: new GraphQLNonNull(GraphQLCompanyPosition) }
	})
})

const GraphQLCompanyPosition = new GraphQLObjectType({
	name: 'GraphQLCompanyPosition',
	fields: () => ({
		...GraphQLPositionFrag
	})
})
