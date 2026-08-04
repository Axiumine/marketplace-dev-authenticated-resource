import { GraphQLObjectType } from 'graphql'

import { aziendeImprenditore } from './queries/aziendeImprenditore.mjs'

const QueriesApi = new GraphQLObjectType({
	name: 'QueriesApi',
	fields: {
		aziendeImprenditore
	}
})

export default QueriesApi
