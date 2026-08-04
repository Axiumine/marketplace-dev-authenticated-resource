import { GraphQLObjectType } from 'graphql'

import { companyItems } from './queries/companyItems.mjs'
import { itemCategories } from './queries/itemCategories.mjs'
import { shopOwnerCompanies } from './queries/shopOwnerCompanies.mjs'

const QueriesApi = new GraphQLObjectType({
	name: 'QueriesApi',
	fields: {
		companyItems,
		itemCategories,
		shopOwnerCompanies
	}
})

export default QueriesApi
