import { GraphQLObjectType } from 'graphql'

import { companyAdd } from './mutations/companyAdd.mjs'
import { companyDel } from './mutations/companyDel.mjs'
import { companyUpdate } from './mutations/companyUpdate.mjs'
import { itemAdd } from './mutations/itemAdd.mjs'
import { itemDel } from './mutations/itemDel.mjs'
import { itemUpdate } from './mutations/itemUpdate.mjs'

const MutationsApi = new GraphQLObjectType({
	name: 'MutationsApi',
	fields: {
		companyAdd,
		companyDel,
		companyUpdate,
		itemAdd,
		itemDel,
		itemUpdate
	}
})

export default MutationsApi
