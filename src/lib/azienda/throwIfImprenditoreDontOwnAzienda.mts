import { throwForbiddenError } from '@axiumine/koa-utils/graphQL/throw/throwForbiddenError'
import { Azienda } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda'
import { trusted, Types } from 'mongoose'

/**
 * The company an owner names has to be one of theirs, and still live.
 *
 * `_id` is an id the client sends on `aziendaUpdate` and `aziendaDel`, so without this check any owner
 * could edit or retire any company on the platform by guessing an ObjectId.
 *
 * The `deleted` clause is what stops a retired company being acted on twice: it is gone from
 * `aziendeImprenditore`, so the only way to name one is an id the client kept from before, and a second
 * `aziendaDel` on it answers 403 rather than repeating the stamp. trusted(): `sanitizeFilter` is on
 * globally, so a bare `{ $exists: false }` would be read as a literal value and the query would fail
 * casting it against the `deleted` path.
 */
export async function throwIfImprenditoreDontOwnAzienda(imprenditoreId: Types.ObjectId, aziendaId: Types.ObjectId) {
	const found = await Azienda.countDocuments({
		_id: aziendaId,
		idImprenditore: imprenditoreId,
		deleted: trusted({ $exists: false })
	}).lean()

	if (found === 0) {
		throw throwForbiddenError()
	}
}
