import { GraphQLIndirizzoBaseFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLIndirizzoBaseFrag'
import { GraphQLPositionFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * The company behind one or more punti vendita, its own collection since 20260803000000.
 *
 * `idImprenditore` is exposed even though every read path on this tier already filters by the session's
 * owner: the frontend keys its cache on it, and a field the server refuses to say is a field the client
 * has to infer from the query it happened to run.
 *
 * `cf` and `univoco` are the only nullable ones — the collection stores them when given and leaves them
 * out otherwise, which is not the same as storing an empty string.
 */
export const GraphQLAzienda = new GraphQLObjectType({
	name: 'GraphQLAzienda',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idImprenditore: { type: new GraphQLNonNull(GraphQLID) },
		ragionesociale: { type: new GraphQLNonNull(GraphQLString) },
		piva: { type: new GraphQLNonNull(GraphQLString) },
		cf: { type: GraphQLString },
		referente: { type: new GraphQLNonNull(GraphQLString) },
		amministratore: { type: new GraphQLNonNull(GraphQLString) },
		univoco: { type: GraphQLString },
		pec: { type: new GraphQLNonNull(GraphQLString) },
		indirizzo: { type: new GraphQLNonNull(GraphQLAziendaIndirizzo) },
		visura: { type: new GraphQLNonNull(GraphQLString) }
	})
})

const GraphQLAziendaIndirizzo = new GraphQLObjectType({
	name: 'GraphQLAziendaIndirizzo',
	fields: () => ({
		...GraphQLIndirizzoBaseFrag,
		position: { type: new GraphQLNonNull(GraphQLAziendaPosition) }
	})
})

const GraphQLAziendaPosition = new GraphQLObjectType({
	name: 'GraphQLAziendaPosition',
	fields: () => ({
		...GraphQLPositionFrag
	})
})
