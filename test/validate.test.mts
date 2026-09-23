import { Types } from 'mongoose'
import { describe, expect, it } from 'vitest'

import { reason } from './errors.mts'

const {
	coordinate,
	requiredEmail,
	MIN_SLUG,
	SHAPE_POSTAL_CODE,
	SHAPE_EMAIL,
	SHAPE_VAT_NUMBER,
	SHAPE_PROVINCE,
	SHAPE_UNIQUE_CODE,
	SHAPE_SLUG,
	MAX_EMAIL,
	textWithFormat,
	requiredText,
	optionalText,
	optionalTextWithFormat,
	optionalTextExactLength,
	requiredSlug,
	optionalSlug
} = await import('../src/lib/validate/fields.mts')

const { validateAddress } = await import('../src/lib/validate/validateAddress.mts')

const { validateCompany } = await import('../src/lib/validate/validateCompany.mts')

const { validateItem } = await import('../src/lib/validate/validateItem.mts')

/** An address of exactly `MAX_EMAIL` characters: 244 of local part, plus the six of `@ex.it`. */
const emailAtLimit = `${'a'.repeat(MAX_EMAIL - 6)}@ex.it`

describe('requiredText', () => {
	it('trims before measuring, so trailing spaces are neither content nor overflow', () => {
		expect(requiredText('  Sneaker  ', 'item.name', 10)).toBe('Sneaker')
	})

	it.each([
		['an empty string', '', 'item.name: field required'],
		['a box holding only spaces', '     ', 'item.name: field required'],
		['one character over the cap', 'abcdefghijk', 'item.name: max 10 characters'],
		['a long value whose trailing spaces do not save it', '  abcdefghijk  ', 'item.name: max 10 characters']
	])('refuses %s', (_desc, value, expected) => {
		expect(reason(() => requiredText(value, 'item.name', 10))).toBe(expected)
	})

	// The cap is inclusive: `maxLength: 10` in the collection accepts ten characters, so the validator
	// that guards it has to accept them too, or it rejects values the database would have taken.
	it('accepts a value of exactly the maximum length', () => {
		expect(requiredText('abcdefghij', 'item.name', 10)).toBe('abcdefghij')
	})
})

describe('optionalTextExactLength', () => {
	it('trims and returns a value of exactly the required length', () => {
		expect(optionalTextExactLength('  12345678901  ', 'company.taxCode', 11)).toBe('12345678901')
	})

	// Same absence rule as every other optional field: a cleared box has to come back `undefined`, not
	// present as an empty string that fails the collection's `minLength: 11`.
	it.each([[null], [undefined], [''], ['    ']])('reads %p as not given', (value) => {
		expect(optionalTextExactLength(value, 'company.taxCode', 11)).toBeUndefined()
	})

	// One character on either side, because a `!==` written as `<` or `>` passes half the cases.
	it.each([
		['one character short', '1234567890'],
		['one character over', '123456789012']
	])('refuses %s', (_desc, value) => {
		expect(reason(() => optionalTextExactLength(value, 'company.taxCode', 11))).toBe('company.taxCode: exactly 11 characters')
	})

	// No alphabet: the collection constrains `minLength`/`maxLength` and nothing else, and a pattern
	// invented here would reject a value the database takes. A newline counts as a character for the
	// same reason — which is why this is its own helper rather than `optionalTextWithFormat` with a
	// `/^.{11}$/`, since `.` does not match one.
	it.each([['ABCDEFGHIJK'], ['12345\n67890']])('accepts %p, since only the length is pinned', (value) => {
		expect(optionalTextExactLength(value, 'company.taxCode', 11)).toHaveLength(11)
	})
})

describe('optionalText', () => {
	// All three spellings of "not given" have to collapse to `undefined`: it is what lets the caller
	// build an `$unset` from a field the owner cleared, and `null`/`''` both reach a `bsonType: 'string'`
	// property and fail the whole write.
	it.each([[null], [undefined], [''], ['    ']])('reads %p as not given', (value) => {
		expect(optionalText(value, 'company.publicName', 12)).toBeUndefined()
	})

	it('trims a value that was given', () => {
		expect(optionalText('  Mark Boutique  ', 'company.publicName', 20)).toBe('Mark Boutique')
	})

	it('accepts a value of exactly the maximum length', () => {
		expect(optionalText('123456789012', 'company.publicName', 12)).toBe('123456789012')
	})

	it('refuses one character over the cap', () => {
		expect(reason(() => optionalText('1234567890123', 'company.publicName', 12))).toBe('company.publicName: max 12 characters')
	})
})

describe('textWithFormat', () => {
	it('trims and returns a value that matches', () => {
		expect(textWithFormat('  02109  ', 'company.address.postalCode', SHAPE_POSTAL_CODE, 'the postal code is 5 digits')).toBe(
			'02109'
		)
	})

	// No separate empty test in the source: every pattern is anchored and matches at least one
	// character, so a blank field gets the shape message rather than "field required".
	it('refuses a blank value with the shape message, not an obligatory one', () => {
		expect(
			reason(() => textWithFormat('   ', 'company.address.postalCode', SHAPE_POSTAL_CODE, 'the postal code is 5 digits'))
		).toBe('company.address.postalCode: the postal code is 5 digits')
	})
})

describe('optionalTextWithFormat', () => {
	it.each([[null], [undefined], ['   ']])('reads %p as not given, without running the pattern', (value) => {
		expect(optionalTextWithFormat(value, 'company.uniqueCode', SHAPE_UNIQUE_CODE, 'seven characters')).toBeUndefined()
	})

	it('trims and returns a value that matches', () => {
		expect(optionalTextWithFormat(' ABC1234 ', 'company.uniqueCode', SHAPE_UNIQUE_CODE, 'seven characters')).toBe('ABC1234')
	})

	it('refuses a value that was given and does not match', () => {
		expect(reason(() => optionalTextWithFormat('ABC12', 'company.uniqueCode', SHAPE_UNIQUE_CODE, 'seven characters'))).toBe(
			'company.uniqueCode: seven characters'
		)
	})
})

describe('requiredSlug', () => {
	it('trims and returns a valid slug', () => {
		expect(requiredSlug('  sneaker-shoe  ', 'item.slug', 20)).toBe('sneaker-shoe')
	})

	// Not lowercased for the caller — a value that differs from what was typed is refused rather than
	// silently rewritten, because the slug is the permanent address of a public page.
	it.each([
		['an uppercase slug', 'Sneaker', 'item.slug: lowercase letters, digits and single hyphens only'],
		['a doubled hyphen', 'sneaker--shoe', 'item.slug: lowercase letters, digits and single hyphens only'],
		['a leading hyphen', '-sneaker', 'item.slug: lowercase letters, digits and single hyphens only'],
		['a one-character slug', 'a', 'item.slug: min 2 characters'],
		['an empty slug', '', 'item.slug: field required']
	])('refuses %s', (_desc, value, expected) => {
		expect(reason(() => requiredSlug(value, 'item.slug', 20))).toBe(expected)
	})

	// The floor is inclusive: two characters is a real slug, and a `<=` written where a `<` belongs
	// would reject it while every longer one kept working.
	it('accepts a slug of exactly the minimum length', () => {
		expect(requiredSlug('ab', 'item.slug', 20)).toBe('ab')
		expect(MIN_SLUG).toBe(2)
	})

	it('refuses a slug over the cap', () => {
		expect(reason(() => requiredSlug('a'.repeat(21), 'item.slug', 20))).toBe('item.slug: max 20 characters')
	})
})

describe('optionalSlug', () => {
	it.each([[null], [undefined], ['   ']])('reads %p as not given', (value) => {
		expect(optionalSlug(value, 'company.slug', 20)).toBeUndefined()
	})

	it('trims and validates a value that was given', () => {
		expect(optionalSlug('  mark-boutique  ', 'company.slug', 20)).toBe('mark-boutique')
	})

	it('still refuses a malformed value once it is given', () => {
		expect(reason(() => optionalSlug('Mark Boutique', 'company.slug', 20))).toBe(
			'company.slug: lowercase letters, digits and single hyphens only'
		)
	})
})

/*
 * The patterns, one table each — a value that is right, a value that is the wrong length on each side,
 * a value with the wrong character class, and a value with something glued to the front and one with
 * something glued to the back. Those last two are what an unanchored pattern would let through.
 */
describe('the field patterns', () => {
	it.each([
		['02109', true],
		['00100', true],
		['2010', false],
		['201000', false],
		['2010a', false],
		['abcde', false],
		['', false],
		['x20100', false],
		['20100x', false],
		[' 20100', false]
	])('SHAPE_POSTAL_CODE accepts %p: %s', (value, expected) => {
		expect(SHAPE_POSTAL_CODE.test(value)).toBe(expected)
	})

	it.each([
		['MA', true],
		['ma', true],
		['Mi', true],
		['M', false],
		['MIL', false],
		['M1', false],
		['12', false],
		['', false],
		['xMI', false],
		['MIx', false],
		['M I', false]
	])('SHAPE_PROVINCE accepts %p: %s', (value, expected) => {
		expect(SHAPE_PROVINCE.test(value)).toBe(expected)
	})

	it.each([
		['12345678901', true],
		['00000000000', true],
		['1234567890', false],
		['123456789012', false],
		['1234567890a', false],
		['', false],
		['x12345678901', false],
		['12345678901x', false]
	])('SHAPE_VAT_NUMBER accepts %p: %s', (value, expected) => {
		expect(SHAPE_VAT_NUMBER.test(value)).toBe(expected)
	})

	it.each([
		['ABC1234', true],
		['abc1234', true],
		['0000000', true],
		['ABC123', false],
		['ABC12345', false],
		['ABC-123', false],
		['ABC 123', false],
		['', false],
		['xABC1234', false],
		['ABC1234x', false]
	])('SHAPE_UNIQUE_CODE accepts %p: %s', (value, expected) => {
		expect(SHAPE_UNIQUE_CODE.test(value)).toBe(expected)
	})

	it.each([
		['sneaker-shoe', true],
		['ab', true],
		['sneaker', true],
		['Sneaker', false],
		['sneaker--shoe', false],
		['-sneaker', false],
		['sneaker-', false],
		['sneaker.shoe', false],
		['sneaker/shoe', false],
		['', false],
		[' sneaker', false]
	])('SHAPE_SLUG accepts %p: %s', (value, expected) => {
		expect(SHAPE_SLUG.test(value)).toBe(expected)
	})

	// Deliberately loose — one `@`, a dot after it, no whitespace. The rows below are the rubbish it is
	// meant to stop, not an attempt at RFC 5322.
	it.each([
		['mark@marketplace.test', true],
		['m.rivers+tag@sub.marketplace.co.uk', true],
		['a@b.c', true],
		['mark@marketplace', false],
		['markmarketplace.test', false],
		['@marketplace.test', false],
		['mark@.test', false],
		['mark@marketplace.', false],
		['mark@@marketplace.test', false],
		['ma rio@marketplace.test', false],
		['mark@marketplace.test ', false],
		[' mark@marketplace.test', false],
		['', false]
	])('SHAPE_EMAIL accepts %p: %s', (value, expected) => {
		expect(SHAPE_EMAIL.test(value)).toBe(expected)
	})
})

describe('requiredEmail', () => {
	it('trims and returns a well-formed address', () => {
		expect(requiredEmail('  certified@boutique.test ', 'company.certifiedEmail')).toBe('certified@boutique.test')
	})

	// The cap is the collection's 250, not koa-utils' platform-wide 255: validating against the wrong
	// one would pass a 253-character address into a driver rejection with no readable message.
	it('accepts an address of exactly 250 characters', () => {
		expect(requiredEmail(emailAtLimit, 'company.certifiedEmail')).toBe(emailAtLimit)
		expect(MAX_EMAIL).toBe(250)
	})

	it.each([
		['a blank box', '   ', 'company.certifiedEmail: field required'],
		['one character over the cap', `x${emailAtLimit}`, 'company.certifiedEmail: max 250 characters'],
		['a malformed address', 'mark@marketplace', 'company.certifiedEmail: invalid email address']
	])('refuses %s', (_desc, value, expected) => {
		expect(reason(() => requiredEmail(value, 'company.certifiedEmail'))).toBe(expected)
	})
})

describe('coordinate', () => {
	it('returns the pair untouched when it is well formed', () => {
		expect(coordinate([9.19, 45.46], 'company.address.position.coordinates')).toEqual([9.19, 45.46])
	})

	it.each([
		[[9.19], 'company.address.position.coordinates: exactly 2 coordinates are required [longitude, latitude]'],
		[[9.19, 45.46, 0], 'company.address.position.coordinates: exactly 2 coordinates are required [longitude, latitude]'],
		[[181, 45.46], 'company.address.position.coordinates: longitude outside -180..180'],
		[[-181, 45.46], 'company.address.position.coordinates: longitude outside -180..180'],
		[[9.19, 91], 'company.address.position.coordinates: latitude outside -90..90'],
		[[9.19, -91], 'company.address.position.coordinates: latitude outside -90..90'],
		[[NaN, 45.46], 'company.address.position.coordinates: longitude outside -180..180'],
		[[9.19, NaN], 'company.address.position.coordinates: latitude outside -90..90']
	])('refuses %p', (coordinates, expected) => {
		expect(reason(() => coordinate(coordinates, 'company.address.position.coordinates'))).toBe(expected)
	})

	// The bounds are inclusive: ±180/±90 are real points (the antimeridian and the poles), not overflow.
	it('accepts the boundary values themselves', () => {
		expect(coordinate([180, 90], 'p')).toEqual([180, 90])
		expect(coordinate([-180, -90], 'p')).toEqual([-180, -90])
	})
})

describe('validateAddress', () => {
	const valid = {
		street: ' 9 Harbour Road ',
		postalCode: ' 02109 ',
		city: ' Boston ',
		province: 'ma',
		position: { coordinates: [9.19, 45.46] }
	}

	// `type` is written, never read off the argument: there is one legal value, so accepting it from the
	// client would only create a way to get it wrong.
	it('stamps the GeoJSON type itself and upper-cases the province', () => {
		expect(validateAddress(valid, 'company.address')).toEqual({
			street: '9 Harbour Road',
			postalCode: '02109',
			city: 'Boston',
			province: 'MA',
			position: { type: 'Point', coordinates: [9.19, 45.46] }
		})
	})

	it('names the path it was given', () => {
		expect(reason(() => validateAddress({ ...valid, postalCode: 'ABCDE' }, 'company.address'))).toBe(
			'company.address.postalCode: the postal code is 5 digits'
		)
	})

	// ⚠️ 100 here, not the shopOwner tier's 250 — same field name, same GraphQL fragment, different bound
	// per collection.
	it('caps the street address at 100', () => {
		expect(validateAddress({ ...valid, street: 'a'.repeat(100) }, 'company.address').street).toHaveLength(100)
		expect(reason(() => validateAddress({ ...valid, street: 'a'.repeat(101) }, 'company.address'))).toBe(
			'company.address.street: max 100 characters'
		)
	})

	it.each([
		['street', { street: '  ' }, 'company.address.street: field required'],
		['postalCode', { postalCode: 'ABCDE' }, 'company.address.postalCode: the postal code is 5 digits'],
		['city', { city: '' }, 'company.address.city: field required'],
		['city over the cap', { city: 'a'.repeat(101) }, 'company.address.city: max 100 characters'],
		['province', { province: '1' }, 'company.address.province: the province is the 2-letter code'],
		[
			'position',
			{ position: { coordinates: [9.19] } },
			'company.address.position.coordinates: exactly 2 coordinates are required [longitude, latitude]'
		],
		['latitude', { position: { coordinates: [9.19, 120] } }, 'company.address.position.coordinates: latitude outside -90..90']
	])('refuses a bad %s', (_desc, patch, expected) => {
		expect(reason(() => validateAddress({ ...valid, ...patch }, 'company.address'))).toBe(expected)
	})
})

describe('validateCompany', () => {
	const address = {
		street: ' 9 Harbour Road ',
		postalCode: ' 02109 ',
		city: ' Boston ',
		province: 'ma',
		position: { coordinates: [9.19, 45.46] }
	}

	const validate = {
		legalName: ' Marks Boutique ',
		vatNumber: ' 12345678901 ',
		taxCode: ' 12345678901 ',
		contactPerson: ' Mark Rivers ',
		administrator: ' Mark Rivers ',
		uniqueCode: ' ABC1234 ',
		certifiedEmail: ' certified@boutique.test ',
		address,
		registryExtract: ' registryExtract-2026 '
	} as never

	it('returns a trimmed copy, with the seat normalised like any other address', () => {
		expect(validateCompany(validate)).toEqual({
			legalName: 'Marks Boutique',
			vatNumber: '12345678901',
			taxCode: '12345678901',
			contactPerson: 'Mark Rivers',
			administrator: 'Mark Rivers',
			uniqueCode: 'ABC1234',
			certifiedEmail: 'certified@boutique.test',
			address: {
				street: '9 Harbour Road',
				postalCode: '02109',
				city: 'Boston',
				province: 'MA',
				position: { type: 'Point', coordinates: [9.19, 45.46] }
			},
			registryExtract: 'registryExtract-2026',
			publicName: undefined,
			slug: undefined,
			description: undefined
		})
	})

	// ⚠️ **Every key is present, even the five optional ones, and that is the point.** `funCompanyUpdate`
	// reads `Object.entries` of what this returns to build `$unset` from whatever key comes back
	// `undefined` — a key genuinely absent, the way the admin tier's own validator answers a blank field,
	// would be neither `$set` nor `$unset` and would leave a stale value in the document. All five here,
	// every one blank a different way, still land as explicit `undefined` members of the object.
	it.each([
		['taxCode', { taxCode: '  ' }, 'taxCode'],
		['uniqueCode', { uniqueCode: '   ' }, 'uniqueCode'],
		['taxCode sent null', { taxCode: null }, 'taxCode'],
		['publicName', { publicName: '' }, 'publicName'],
		['slug', { slug: null }, 'slug'],
		['description', { description: '   ' }, 'description']
	])('answers %s as an explicit undefined key rather than an absent one', (_desc, patch, key) => {
		const result = validateCompany({ ...(validate as object), ...patch } as never)

		expect(key in result).toBe(true)
		expect((result as Record<string, unknown>)[key]).toBeUndefined()
	})

	// The shop listing, from 20260804000200. All three are optional because a company exists as a legal
	// entity long before its owner writes a public page for it, and nothing here checks them against
	// `published` — that flag is not this path's to write at all, and the collection's `$expr` refuses
	// `published: true` without a slug and a publicName, which is the copy of the rule no write can
	// bypass.
	it('carries the three public fields through, trimmed, when the shop has a listing', () => {
		const result = validateCompany({
			...(validate as object),
			publicName: ' Mark Boutique ',
			slug: ' mark-boutique ',
			description: ' Wood oven since 1975. '
		} as never)

		expect(result.publicName).toBe('Mark Boutique')
		expect(result.slug).toBe('mark-boutique')
		expect(result.description).toBe('Wood oven since 1975.')
	})

	// ⚠️ B42: the database is gaining `minLength: 1` on `publicName`. A blank one already comes back
	// `undefined` from `optionalText`, the same as every other optional field — so this is not a special
	// case, it is the ordinary rule, pinned so it stays true once that migration lands.
	it('drops a blank publicName instead of writing it empty', () => {
		expect(validateCompany({ ...(validate as object), publicName: '   ' } as never).publicName).toBeUndefined()
	})

	// The slug is the permanent address of a public page, so a value that differs from what was typed is
	// refused rather than silently rewritten: an owner who typed `Boutique` is told the slug is
	// lowercase, instead of finding out after the link has been shared.
	it.each([
		['publicName over the cap', { publicName: 'a'.repeat(101) }, 'company.publicName: max 100 characters'],
		['an uppercase slug', { slug: 'Boutique' }, 'company.slug: lowercase letters, digits and single hyphens only'],
		['a doubled hyphen', { slug: 'mark--boutique' }, 'company.slug: lowercase letters, digits and single hyphens only'],
		['a one-character slug', { slug: 'a' }, 'company.slug: min 2 characters'],
		['slug over the cap', { slug: 'a'.repeat(121) }, 'company.slug: max 120 characters'],
		['description over the cap', { description: 'a'.repeat(2001) }, 'company.description: max 2000 characters']
	])('refuses %s', (_desc, patch, expected) => {
		expect(reason(() => validateCompany({ ...(validate as object), ...patch } as never))).toBe(expected)
	})

	// ⚠️ 1000, and it is the collection's cap rather than an invented one.
	it('accepts a registryExtract of exactly 1000 characters and refuses 1001', () => {
		expect(
			validateCompany({ ...(validate as object), registryExtract: 'x'.repeat(1000) } as never).registryExtract
		).toHaveLength(1000)
		expect(reason(() => validateCompany({ ...(validate as object), registryExtract: 'x'.repeat(1001) } as never))).toBe(
			'company.registryExtract: max 1000 characters'
		)
	})

	it.each([
		['legalName', { legalName: '' }, 'company.legalName: field required'],
		['legalName over the cap', { legalName: 'a'.repeat(101) }, 'company.legalName: max 100 characters'],
		['vatNumber', { vatNumber: '1234567890' }, 'company.vatNumber: the VAT number is 11 digits'],
		['taxCode', { taxCode: '1234567890' }, 'company.taxCode: exactly 11 characters'],
		['contactPerson', { contactPerson: '   ' }, 'company.contactPerson: field required'],
		['contactPerson over the cap', { contactPerson: 'a'.repeat(51) }, 'company.contactPerson: max 50 characters'],
		['administrator', { administrator: '' }, 'company.administrator: field required'],
		['administrator over the cap', { administrator: 'a'.repeat(51) }, 'company.administrator: max 50 characters'],
		['uniqueCode', { uniqueCode: 'ABC12' }, 'company.uniqueCode: the unique code is 7 alphanumeric characters'],
		['certifiedEmail', { certifiedEmail: 'boutique@certifiedEmail' }, 'company.certifiedEmail: invalid email address'],
		['registryExtract', { registryExtract: '   ' }, 'company.registryExtract: field required']
	])('refuses a bad %s', (_desc, patch, expected) => {
		expect(reason(() => validateCompany({ ...(validate as object), ...patch } as never))).toBe(expected)
	})

	// The seat's own failures come through with the company's prefix, which is what keeps them apart from
	// any other address on the same form.
	it.each([
		['street', { street: '  ' }, 'company.address.street: field required'],
		['postalCode', { postalCode: 'ABCDE' }, 'company.address.postalCode: the postal code is 5 digits'],
		[
			'position',
			{ position: { coordinates: [9.19] } },
			'company.address.position.coordinates: exactly 2 coordinates are required [longitude, latitude]'
		]
	])('refuses a bad seat %s, naming the nested path', (_desc, patch, expected) => {
		expect(reason(() => validateCompany({ ...(validate as object), address: { ...address, ...patch } } as never))).toBe(expected)
	})
})

describe('validateItem', () => {
	const idCompany = new Types.ObjectId('507f1f77bcf86cd799439015')
	const idCategory = new Types.ObjectId('507f1f77bcf86cd799439030')

	const validate = {
		idCompany,
		idCategory,
		name: ' Sneaker ',
		description: ' Baked this morning ',
		slug: ' sneaker-shoe '
	} as never

	it('returns a trimmed copy, keeping the two ids it was handed', () => {
		expect(validateItem(validate)).toEqual({
			idCompany,
			idCategory,
			name: 'Sneaker',
			description: 'Baked this morning',
			slug: 'sneaker-shoe'
		})
	})

	// Neither id is checked here — existing, live and this owner's takes a database read, which is
	// `throwIfShopOwnerDontOwnCompany`, `throwIfItemCategoryMissing` and `holdItemCategory`/`holdCompany`'s
	// job. This only guarantees the shape carries through untouched, whatever the ids actually name.
	it('passes idCompany and idCategory through exactly as given, not copied or re-cast', () => {
		const result = validateItem(validate)

		expect(result.idCompany).toBe(idCompany)
		expect(result.idCategory).toBe(idCategory)
	})

	it('accepts a name of exactly 150 characters and refuses 151', () => {
		expect(validateItem({ ...(validate as object), name: 'a'.repeat(150) } as never).name).toHaveLength(150)
		expect(reason(() => validateItem({ ...(validate as object), name: 'a'.repeat(151) } as never))).toBe(
			'item.name: max 150 characters'
		)
	})

	it('accepts a description of exactly 2000 characters and refuses 2001', () => {
		expect(validateItem({ ...(validate as object), description: 'a'.repeat(2000) } as never).description).toHaveLength(2000)
		expect(reason(() => validateItem({ ...(validate as object), description: 'a'.repeat(2001) } as never))).toBe(
			'item.description: max 2000 characters'
		)
	})

	// ⚠️ 160 against the name's 150, and the gap is deliberate: a slug is derived from a name and hyphens
	// make it grow, so a 150-character name that survives `requiredText` must still fit `maxLength: 160`.
	it('accepts a slug of exactly 160 characters and refuses 161', () => {
		const at160 = `${'a'.repeat(158)}-b`

		expect(validateItem({ ...(validate as object), slug: at160 } as never).slug).toHaveLength(160)
		expect(reason(() => validateItem({ ...(validate as object), slug: `${at160}c` } as never))).toBe(
			'item.slug: max 160 characters'
		)
	})

	it.each([
		['a blank name', { name: '   ' }, 'item.name: field required'],
		['a blank description', { description: '' }, 'item.description: field required'],
		['a blank slug', { slug: '   ' }, 'item.slug: field required'],
		['an uppercase slug', { slug: 'Sneaker' }, 'item.slug: lowercase letters, digits and single hyphens only'],
		['a one-character slug', { slug: 'a' }, 'item.slug: min 2 characters']
	])('refuses %s', (_desc, patch, expected) => {
		expect(reason(() => validateItem({ ...(validate as object), ...patch } as never))).toBe(expected)
	})
})
