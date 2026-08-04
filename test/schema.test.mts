import { getIntrospectionQuery, graphql, GraphQLSchema } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The resolvers pull the models in transitively; nothing connects, but the Redis client is
// imported by the auth context type chain and needs a stub in the unit project.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: {} }))

type IntrospectedField = { name: string; description: string | null; args: Array<{ name: string }> }
type IntrospectedType = { name: string; fields: IntrospectedField[] | null; inputFields: Array<{ name: string }> | null }

let schema: GraphQLSchema
let result: Awaited<ReturnType<typeof graphql>>
let types: Map<string, IntrospectedType>

// Imported and assembled fresh inside beforeEach, not at module top level or beforeAll: several of
// the `new GraphQLObjectType({...})` / `new GraphQLInputObjectType({...})` calls this transitively
// reaches throw synchronously (graphql-js validates `name` in the constructor) when a mutant blanks
// their `name`. A throw during a top-level import, or inside `beforeAll`, only SKIPS every test in
// the file — Vitest marks the suite's tests "skipped", not "failed", because the hook that was
// supposed to prepare them never finished. Stryker cannot attribute a skip to any one test, so it
// reports the mutant Survived even though the whole file plainly broke. A throw inside `beforeEach`
// instead fails only the one test that was about to run, which Stryker does attribute correctly.
beforeEach(async () => {
	const { default: QueriesApi } = await import('../src/graphQLApi/schema/queries.mts')
	const { default: MutationsApi } = await import('../src/graphQLApi/schema/mutations.mts')

	schema = new GraphQLSchema({ query: QueriesApi, mutation: MutationsApi })

	// One real introspection run: it validates the assembled schema AND forces every
	// `fields: () => ({...})` thunk in the type files, which is what actually covers them.
	result = await graphql({ schema, source: getIntrospectionQuery() })
	const introspection = result.data?.__schema as unknown as { types: IntrospectedType[] }
	types = new Map(introspection.types.map((t) => [t.name, t]))
})

function fieldsOf(typeName: string): string[] {
	return (types.get(typeName)?.fields ?? []).map((f) => f.name)
}

function inputFieldsOf(typeName: string): string[] {
	return (types.get(typeName)?.inputFields ?? []).map((f) => f.name)
}

function argsOf(root: 'QueriesApi' | 'MutationsApi', name: string): string[] {
	const field = types.get(root)?.fields?.find((f) => f.name === name)
	return (field?.args ?? []).map((a) => a.name)
}

function descriptionOf(root: 'QueriesApi' | 'MutationsApi', name: string): string | null | undefined {
	return types.get(root)?.fields?.find((f) => f.name === name)?.description
}

/** Same, for a field of any object type — `String(field.type)` rather than a re-rendered `ofType` chain. */
function typeOfField(typeName: string, fieldName: string): string {
	const type = schema.getType(typeName) as { getFields(): Record<string, { type: unknown }> }

	return String(type.getFields()[fieldName].type)
}

describe('schema', () => {
	it('assembles without a single validation error', () => {
		expect(result.errors).toBeUndefined()
	})

	// `puntiVenditaShopOwnerTbl`, `puntoVenditaShopOwner` and `categoriePuntoVendita` were
	// removed with the `puntoVendita` and `categoria` collections on 2026-08-04.
	// `shopOwnerCompanies` is the sole survivor on this tier.
	it('exposes only the company query', () => {
		expect(fieldsOf('QueriesApi')).toEqual(['shopOwnerCompanies'])
	})

	// `puntoVenditaAdd`, `puntoVenditaDel` and `puntoVenditaDis` went the same way.
	it('exposes only the company mutations', () => {
		expect(fieldsOf('MutationsApi')).toEqual(['companyAdd', 'companyDel', 'companyUpdate'])
	})

	// The owner is the session's, so an `idShopOwner` argument would be a way to ask for
	// somebody else's companies.
	it('takes no arguments on the list query', () => {
		expect(argsOf('QueriesApi', 'shopOwnerCompanies')).toEqual([])
	})

	it('carries its exact description', () => {
		expect(descriptionOf('QueriesApi', 'shopOwnerCompanies')).toBe('Get companies shopOwner')
	})
})

describe('mutation arguments', () => {
	// No `idShopOwner` on any of the three: the owner is the session's. `companyAdd` takes the input
	// object alone and `companyUpdate` takes it beside the `_id`, so a company cannot be handed to
	// another owner by saving its card.
	it.each([
		['companyAdd', ['company']],
		['companyDel', ['_id']],
		['companyUpdate', ['_id', 'company']]
	])('%s takes %j', (name, expected) => {
		expect(argsOf('MutationsApi', name)).toEqual(expected)
	})

	// Literal text, nothing computes it, pin it.
	it.each([
		['companyAdd', 'add company'],
		['companyDel', 'del company'],
		['companyUpdate', 'update company']
	])('%s carries its exact description', (name, description) => {
		expect(descriptionOf('MutationsApi', name)).toBe(description)
	})
})

describe('object types', () => {
	it('GraphQLCompany carries the company, its owner and its legal seat', () => {
		expect(fieldsOf('GraphQLCompany')).toEqual([
			'_id',
			'idShopOwner',
			'legalName',
			'vatNumber',
			'taxCode',
			'contactPerson',
			'administrator',
			'uniqueCode',
			'certifiedEmail',
			'address',
			'registryExtract'
		])
		expect(fieldsOf('GraphQLCompanyAddress').length).toBeGreaterThan(0)
		expect(typeOfField('GraphQLCompanyAddress', 'position')).toBe('GraphQLCompanyPosition!')
	})

	// `taxCode` and `uniqueCode` are the two the collection stores only when given. Asserted as the complete
	// list of nullables rather than one at a time: a NonNull dropped from any other field would let a
	// missing value read back as null instead of failing the row.
	it('leaves taxCode and uniqueCode nullable on a company, and nothing else', () => {
		const nullable = fieldsOf('GraphQLCompany').filter((name) => !typeOfField('GraphQLCompany', name).endsWith('!'))

		expect(nullable).toEqual(['taxCode', 'uniqueCode'])
	})

	// `GraphQLPuntoVendita` and `GraphQLPuntovenditaTbl` were removed with the `puntoVendita`
	// collection on 2026-08-04 — nothing on this tier resolves an `company` through a shop any more.
	it('does not carry the removed punto vendita types', () => {
		expect(types.has('GraphQLPuntoVendita')).toBe(false)
		expect(types.has('GraphQLPuntovenditaTbl')).toBe(false)
	})
})

describe('input types', () => {
	// `GraphQLInputCompany` mirrors the output type minus the two fields the server sets.
	it('mirrors the company, minus the two fields the owner cannot set', () => {
		expect(inputFieldsOf('GraphQLInputCompany')).toEqual(
			fieldsOf('GraphQLCompany').filter((f) => f !== '_id' && f !== 'idShopOwner')
		)
		expect(inputFieldsOf('GraphQLInputCompanyAddress')).toEqual(fieldsOf('GraphQLCompanyAddress'))
		expect(inputFieldsOf('GraphQLInputCompanyPosition')).toEqual(fieldsOf('GraphQLCompanyPosition'))
	})

	// The four punto-vendita-only inputs (contacts, openingHours, address, farina options) were removed
	// with the collection they served on 2026-08-04.
	it('does not carry the removed punto vendita inputs', () => {
		expect(types.has('GraphQLInputPuntoVenditaContacts')).toBe(false)
		expect(types.has('GraphQLInputPuntoVenditaOpeningHours')).toBe(false)
		expect(types.has('GraphQLInputPuntoVenditaAddress')).toBe(false)
		expect(types.has('GraphQLInputOpzFarine')).toBe(false)
	})
})
