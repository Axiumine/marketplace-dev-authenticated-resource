import { GraphQLIndirizzoFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLIndirizzoFrag'
import { GraphQLPositionFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql'

/**
 * The company as the owner fills it in — every field of `GraphQLAzienda` except the two the server sets:
 * `_id`, and `idImprenditore`, which is the session's and never an argument on this tier.
 *
 * Replaces `GraphQLInputPuntoVenditaAzienda`, which was the same fields nested inside `puntoVenditaAdd`
 * and had to be retyped for every shop of the same chain. It gains `cf` and `indirizzo`, which the
 * embedded sub-document never carried.
 */
export const GraphQLInputAzienda = new GraphQLInputObjectType({
	name: 'GraphQLInputAzienda',
	fields: () => ({
		ragionesociale: { type: new GraphQLNonNull(GraphQLString) },
		piva: { type: new GraphQLNonNull(GraphQLString) },
		cf: { type: GraphQLString },
		referente: { type: new GraphQLNonNull(GraphQLString) },
		amministratore: { type: new GraphQLNonNull(GraphQLString) },
		univoco: { type: GraphQLString },
		pec: { type: new GraphQLNonNull(GraphQLString) },
		indirizzo: { type: new GraphQLNonNull(GraphQLInputAziendaIndirizzo) },
		visura: { type: new GraphQLNonNull(GraphQLString) }
	})
})

const GraphQLInputAziendaIndirizzo = new GraphQLInputObjectType({
	name: 'GraphQLInputAziendaIndirizzo',
	fields: () => ({
		...GraphQLIndirizzoFrag,
		position: { type: new GraphQLNonNull(GraphQLInputAziendaPosition) }
	})
})

const GraphQLInputAziendaPosition = new GraphQLInputObjectType({
	name: 'GraphQLInputAziendaPosition',
	fields: () => ({
		...GraphQLPositionFrag
	})
})
