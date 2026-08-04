import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Azienda } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda'
import { Types } from 'mongoose'

/**
 * Retires a company. A soft delete: the row stays and gains the instant it was retired.
 * `Date.now()` is a number and the schema path is a `Date` — mongoose casts it.
 *
 * ⚠️ The partita IVA stays registered. `piva_unique` and `pec_unique` are plain global indexes with no
 * `partialFilterExpression` excluding the retired, so the owner cannot re-register the same company
 * after deleting it — the same trade `imprenditore.login.email_unique` already makes.
 *
 * No `deleted` clause on the write itself, deliberately: the filter lives on the read paths and on
 * `throwIfImprenditoreDontOwnAzienda`, which already refuses a retired company before this runs.
 *
 * Used to refuse while a live `puntoVendita` still pointed at the company — that collection was
 * removed from the platform on 2026-08-04, along with the `countDocuments` guard that read it. There
 * is nothing left on the platform that can reference an `azienda`, so retiring one no longer has a
 * referential check to make.
 */
export async function funAziendaDelete(aziendaId: Types.ObjectId, imprenditoreId: Types.ObjectId) {
	const ret = await Azienda.updateOne(
		{ _id: aziendaId, idImprenditore: imprenditoreId },
		{ $set: { deleted: Date.now() } }
	).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
