import { getIntrospectionQuery, graphql, GraphQLObjectType, GraphQLSchema } from 'graphql'
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

/** The rendered type of one argument — the only place a list's own nullability is readable. */
function typeOfArg(root: 'QueriesApi' | 'MutationsApi', fieldName: string, argName: string): string {
	// Query/Mutation roots are always object types — unlike typeOfField's typeName, which also takes
	// input types, `root` never needs anything getFields() gives an input type, so a real instanceof
	// check narrows this properly instead of asserting through a shape GraphQLUnionType does not have.
	const type = schema.getType(root)
	if (!(type instanceof GraphQLObjectType)) throw new Error(`${root} is not an object type`)

	return String(type.getFields()[fieldName].args.find((a) => a.name === argName)?.type)
}

describe('schema', () => {
	it('assembles without a single validation error', () => {
		expect(result.errors).toBeUndefined()
	})

	// The shop-ownership and shop-category link tables were removed with the shop and
	// category collections on 2026-08-04.
	// `companyItems` and `itemCategories` are the catalogue's read side, which is not that
	// collection coming back: items hang off `company` directly, with no shop in between.
	it('exposes the company and catalogue queries', () => {
		expect(fieldsOf('QueriesApi')).toEqual(['companyItems', 'itemCategories', 'shopOwnerCompanies'])
	})

	// The shop add/delete/disable mutations went the same way. The five
	// `item*` are the owner's whole write surface on the catalogue — there is deliberately no
	// `itemCategory*` here, because the taxonomy is written on the Admin tier alone.
	// The three `*UpdatePublished` are the publish split: saving a card and putting it on the public site
	// are two operations, so an owner reopening a stale form cannot republish what someone took down.
	// `itemsUpdatePublished` is the bulk half of the item one, for the select-all control on a list that
	// is not paged — a separate field, so the singular's one-id contract stays exactly as narrow as it is.
	// `shopOwnerDel` is the owner's own account, and it is the only field here that is not about the
	// catalogue: an owner may close their account themselves, which is the ShopOwner half of a decision the
	// Admin tier already had. There is no `shopOwnerUpdateStatus` beside it and there must not be —
	// suspension is the admin's instrument, and only the Admin tier lifts one.
	it('exposes the company and item mutations', () => {
		expect(fieldsOf('MutationsApi')).toEqual([
			'companyAdd',
			'companyDel',
			'companyUpdate',
			'companyUpdatePublished',
			'itemAdd',
			'itemDel',
			'itemUpdate',
			'itemUpdatePublished',
			'itemsUpdatePublished',
			'shopOwnerDel'
		])
	})

	// Same reasoning as `shopOwnerCompanies`: the taxonomy is platform-wide, so an argument here
	// could only narrow it in a way no caller is entitled to define.
	it('takes no arguments on the category query', () => {
		expect(argsOf('QueriesApi', 'itemCategories')).toEqual([])
	})

	// `companyItems` is the one query that does take one, because an owner may hold several
	// companies and the item list is a per-shop screen. That is exactly why its resolver checks
	// ownership before reading.
	it('takes the company id on the item query', () => {
		expect(argsOf('QueriesApi', 'companyItems')).toEqual(['idCompany'])
	})

	it.each([
		['companyItems', 'Get items of a company'],
		['itemCategories', 'Get item categories']
	])('%s carries its exact description', (name, description) => {
		expect(descriptionOf('QueriesApi', name)).toBe(description)
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
	// No `idShopOwner` on any of the nine: the owner is the session's. `companyAdd` takes the input
	// object alone and `companyUpdate` takes it beside the `_id`, so a company cannot be handed to
	// another owner by saving its card. The item five carry no `idShopOwner` either — an item's owner is
	// reached through its company, which is what the guards traverse.
	// The two publish mutations take the flag beside the `_id` and nothing else: they are not a save
	// with one field, so no input object appears here.
	it.each([
		['companyAdd', ['company']],
		['companyDel', ['_id']],
		['companyUpdate', ['_id', 'company']],
		['companyUpdatePublished', ['_id', 'published']],
		['itemAdd', ['item']],
		['itemDel', ['_id']],
		['itemUpdate', ['_id', 'item']],
		['itemUpdatePublished', ['_id', 'published']],
		['itemsUpdatePublished', ['_ids', 'published']],
		['shopOwnerDel', []]
	])('%s takes %j', (name, expected) => {
		expect(argsOf('MutationsApi', name)).toEqual(expected)
	})

	// Literal text, nothing computes it, pin it.
	it.each([
		['companyAdd', 'add company'],
		['companyDel', 'del company'],
		['companyUpdate', 'update company'],
		['companyUpdatePublished', 'publishes or unpublishes a company'],
		['itemAdd', 'add item'],
		['itemDel', 'del item'],
		['itemUpdate', 'update item'],
		['itemUpdatePublished', 'publishes or unpublishes an item'],
		['itemsUpdatePublished', 'publishes or unpublishes several items at once'],
		['shopOwnerDel', 'closes the signed-in shopOwner account']
	])('%s carries its exact description', (name, description) => {
		expect(descriptionOf('MutationsApi', name)).toBe(description)
	})

	/*
	 * ⚠️ `[ID!]!` and not `[ID]` — the inner `!` is what stops a `null` reaching the resolver inside the
	 * list, where it would be de-duplicated to a single entry and counted against an ownership check it
	 * can never satisfy. Rendered through the schema rather than introspection, which reports argument
	 * names alone.
	 */
	it('takes a non-null list of non-null ids on the bulk publish mutation', () => {
		expect(typeOfArg('MutationsApi', 'itemsUpdatePublished', '_ids')).toBe('[ID!]!')
	})
})

describe('object types', () => {
	// The last four are the shop listing, not the legal entity: `publicName` is the trading name a
	// customer sees where `legalName` is a legal instrument, and `published` is the switch that puts
	// the company on an indexed public page.
	it('GraphQLCompany carries the company, its owner, its legal seat and its shop listing', () => {
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
			'registryExtract',
			'publicName',
			'slug',
			'description',
			'published'
		])
		expect(fieldsOf('GraphQLCompanyAddress').length).toBeGreaterThan(0)
		expect(typeOfField('GraphQLCompanyAddress', 'position')).toBe('GraphQLCompanyPosition!')
	})

	// The five the collection stores only when given. Asserted as the complete list of nullables
	// rather than one at a time: a NonNull dropped from any other field would let a missing value read
	// back as null instead of failing the read. `published` is deliberately not among them — it is
	// `required: true` on the model, so every item has one and a null would mean the read is wrong.
	it('leaves the optional company fields nullable, and nothing else', () => {
		const nullable = fieldsOf('GraphQLCompany').filter((name) => !typeOfField('GraphQLCompany', name).endsWith('!'))

		expect(nullable).toEqual(['taxCode', 'uniqueCode', 'publicName', 'slug', 'description'])
	})

	// Every field NonNull but one, `published` included: an item is either a draft or on a public page,
	// and a third state read back as null would be silently neither.
	//
	// `image` is that one, and the null is the whole value of the field: it says the item has no
	// picture, which is exactly what a card has to know before it can choose between one and a
	// placeholder. It is a file name rather than a URL — the client joins it to `idCompany`, which is on
	// this same type.
	it('GraphQLItem carries the item, its company and its category', () => {
		expect(fieldsOf('GraphQLItem')).toEqual([
			'_id',
			'idCompany',
			'idCategory',
			'name',
			'description',
			'slug',
			'published',
			'image'
		])
		expect(fieldsOf('GraphQLItem').filter((name) => !typeOfField('GraphQLItem', name).endsWith('!'))).toEqual(['image'])
		expect(typeOfField('GraphQLItem', 'image')).toBe('String')
	})

	// `idParent` is the one nullable, and that nullability *is* the tree: absent means top level,
	// present means a subcategory of the one it names. Depth is capped at two on the Admin tier.
	it('GraphQLItemCategory leaves only idParent nullable', () => {
		expect(fieldsOf('GraphQLItemCategory')).toEqual(['_id', 'idParent', 'name', 'slug', 'position'])
		expect(typeOfField('GraphQLItemCategory', 'idParent')).toBe('ID')
		expect(typeOfField('GraphQLItemCategory', 'position')).toBe('Int!')
	})
})

describe('input types', () => {
	// `GraphQLInputCompany` mirrors the output type minus the two fields the server sets and the one
	// that is a separate operation: `published` is written by `companyUpdatePublished` alone, so a save
	// of the card cannot carry it and this assertion is what stops it coming back.
	it('mirrors the company, minus the two fields the owner cannot set and the publish flag', () => {
		expect(inputFieldsOf('GraphQLInputCompany')).toEqual(
			fieldsOf('GraphQLCompany').filter((f) => f !== '_id' && f !== 'idShopOwner' && f !== 'published')
		)
		expect(inputFieldsOf('GraphQLInputCompanyAddress')).toEqual(fieldsOf('GraphQLCompanyAddress'))
		expect(inputFieldsOf('GraphQLInputCompanyPosition')).toEqual(fieldsOf('GraphQLCompanyPosition'))
	})

	// `_id` is the server's and `published` is `itemUpdatePublished`'s. `idCompany` stays writable on
	// purpose — saving an item is also how it moves between the owner's shops, which is why `itemUpdate`
	// guards the source and the destination separately.
	it('mirrors the item, minus the id the server sets and the publish flag', () => {
		expect(inputFieldsOf('GraphQLInputItem')).toEqual(fieldsOf('GraphQLItem').filter((f) => f !== '_id' && f !== 'published'))
	})

	// ⚠️ `image` is on both lists above and is **not** the same thing twice — bytes going in, a file
	// name coming back — so the mirror assertion cannot tell them apart and this is what does. It also
	// pins the one nullable member of the input: an item may be created without a picture, and an
	// `Upload` cannot be echoed back for a client to resend on the next save.
	it('takes the item picture as bytes and answers a file name', () => {
		expect(typeOfField('GraphQLInputItem', 'image')).toBe('Upload')
		expect(typeOfField('GraphQLItem', 'image')).toBe('String')
	})

	// There is no `GraphQLInputItemCategory` on this tier at all: the taxonomy is written on the
	// Admin one. An input type here would be the first half of a write path nothing should have.
	it('carries no category input', () => {
		expect(types.has('GraphQLInputItemCategory')).toBe(false)
	})
})
