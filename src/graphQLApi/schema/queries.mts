import { GraphQLObjectType } from 'graphql'

import { shopOwnerCompanies } from './queries/shopOwnerCompanies.mjs'

const QueriesApi = new GraphQLObjectType({
	name: 'QueriesApi',
	fields: {
		shopOwnerCompanies
	}
})

export default QueriesApi
