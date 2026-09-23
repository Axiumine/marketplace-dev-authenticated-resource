import { ICompanyUpdate } from '@lib/company/funCompanyUpdate.mjs'
import {
	optionalSlug,
	optionalText,
	optionalTextExactLength,
	optionalTextWithFormat,
	requiredEmail,
	requiredText,
	SHAPE_UNIQUE_CODE,
	SHAPE_VAT_NUMBER,
	textWithFormat
} from '@lib/validate/fields.mjs'
import { IAddressInput, validateAddress } from '@lib/validate/validateAddress.mjs'

/*
 * From marketplace-db-setup/lib/schemas/company.js — the bounds mirror the admin tier's own
 * `validateCompany.mts`, which reads from the same migration.
 */
const MAX_LEGAL_NAME = 100
const MAX_CONTACT_PERSON = 50
const MAX_ADMINISTRATOR = 50
const MAX_REGISTRY_EXTRACT = 1000
const TAX_CODE_LENGTH = 11
const MAX_PUBLIC_NAME = 100
const MAX_SLUG = 120
const MAX_DESCRIPTION = 2000

/**
 * What the `GraphQLInputCompany` argument carries: `ICompanyUpdate` (the card `funCompanyUpdate` writes,
 * and also every field `companyAdd` accepts) with its address narrowed to what the client actually sends
 * — no `position.type`, see `validateAddress`.
 */
export type ICompanyInput = Omit<ICompanyUpdate, 'address'> & { address: IAddressInput }

/**
 * A company, every field of it, normalised and ready to be written whole.
 *
 * ⚠️ **Every key of `ICompanyUpdate` is present on the object this returns, including the optional
 * ones — set to `undefined` rather than left off when the owner cleared them.** That is deliberate and
 * different from a validator that only has to satisfy a whole-object `$set`: `funCompanyUpdate` reads
 * `Object.entries` of what this returns to decide `$set` from `$unset`, and a key genuinely absent here
 * would be neither — silently leaving a stale value in the document, which is the bug this layer exists
 * to close. `taxCode`, `uniqueCode`, `publicName`, `slug` and `description` are the five fields this
 * applies to; the rest are required and never `undefined`.
 *
 * The path prefix is `company.` throughout because the fields arrive inside one input object, which is
 * the argument the owner's form maps onto.
 *
 * ⚠️ `published` is not part of `ICompanyUpdate` and is not read here — publishing is
 * `companyUpdatePublished`, and the rule that a published shop needs a `slug` and a `publicName` lives in
 * the collection's `$expr`, not here: restating it would add a second copy that can drift from the one
 * that cannot be bypassed.
 */
export const validateCompany = (company: ICompanyInput): ICompanyUpdate => ({
	legalName: requiredText(company.legalName, 'company.legalName', MAX_LEGAL_NAME),
	vatNumber: textWithFormat(company.vatNumber, 'company.vatNumber', SHAPE_VAT_NUMBER, 'the VAT number is 11 digits'),
	taxCode: optionalTextExactLength(company.taxCode, 'company.taxCode', TAX_CODE_LENGTH),
	contactPerson: requiredText(company.contactPerson, 'company.contactPerson', MAX_CONTACT_PERSON),
	administrator: requiredText(company.administrator, 'company.administrator', MAX_ADMINISTRATOR),
	uniqueCode: optionalTextWithFormat(
		company.uniqueCode,
		'company.uniqueCode',
		SHAPE_UNIQUE_CODE,
		'the unique code is 7 alphanumeric characters'
	),
	certifiedEmail: requiredEmail(company.certifiedEmail, 'company.certifiedEmail'),
	address: validateAddress(company.address, 'company.address'),
	registryExtract: requiredText(company.registryExtract, 'company.registryExtract', MAX_REGISTRY_EXTRACT),
	// `publicName` is the one field B42 pins a `minLength: 1` on at the database — blank already comes
	// back `undefined` from `optionalText`, the same as every other optional field, so an owner clearing
	// it (or a caller that only ever sent whitespace) is an `$unset` rather than a write the future
	// migration would reject.
	publicName: optionalText(company.publicName, 'company.publicName', MAX_PUBLIC_NAME),
	slug: optionalSlug(company.slug, 'company.slug', MAX_SLUG),
	description: optionalText(company.description, 'company.description', MAX_DESCRIPTION)
})
