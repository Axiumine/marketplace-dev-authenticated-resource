import { GraphQLObjectType } from 'graphql'

import { aziendaAdd } from './mutations/aziendaAdd.mjs'
import { aziendaDel } from './mutations/aziendaDel.mjs'
import { aziendaUpdate } from './mutations/aziendaUpdate.mjs'

const MutationsApi = new GraphQLObjectType({
	name: 'MutationsApi',
	fields: {
		aziendaAdd,
		aziendaDel,
		aziendaUpdate
	}
})

export default MutationsApi
