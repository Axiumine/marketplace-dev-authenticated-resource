import { GraphQLObjectType } from 'graphql'

import { companyAdd } from './mutations/companyAdd.mjs'
import { companyDel } from './mutations/companyDel.mjs'
import { companyUpdate } from './mutations/companyUpdate.mjs'
import { companyUpdatePublished } from './mutations/companyUpdatePublished.mjs'
import { itemAdd } from './mutations/itemAdd.mjs'
import { itemDel } from './mutations/itemDel.mjs'
import { itemsUpdatePublished } from './mutations/itemsUpdatePublished.mjs'
import { itemUpdate } from './mutations/itemUpdate.mjs'
import { itemUpdatePublished } from './mutations/itemUpdatePublished.mjs'
import { shopOwnerDel } from './mutations/shopOwnerDel.mjs'

const MutationsApi = new GraphQLObjectType({
	name: 'MutationsApi',
	fields: {
		companyAdd,
		companyDel,
		companyUpdate,
		companyUpdatePublished,
		itemAdd,
		itemDel,
		itemUpdate,
		itemUpdatePublished,
		itemsUpdatePublished,
		shopOwnerDel
	}
})

export default MutationsApi
