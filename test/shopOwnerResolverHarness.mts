import { Types } from 'mongoose'

import type { IContextShopOwnerAuthenticatedResource } from '../src/lib/auth/IContextShopOwnerAuthenticatedResource.mts'

/** The caller every resolver suite runs as — the shop owner whose `_id` the session carries. */
export const SHOP_OWNER_ID = new Types.ObjectId('507f1f77bcf86cd799439011')

/** The company that shop owner owns, and the one every ownership guard is armed to accept. */
export const ID_COMPANY = new Types.ObjectId('507f1f77bcf86cd799439015')

/**
 * The context the mutations read the caller out of.
 *
 * ⚠️ **The owner comes from the session and never from the input**, on every write in this service, so a
 * suite that built its own context per test could let a resolver take an id from its arguments and still
 * pass. One context, one owner, shared by both mutation suites.
 */
export const ctx = { state: { user: { _id: SHOP_OWNER_ID } } } as unknown as IContextShopOwnerAuthenticatedResource

/** Anything not a Mongo duplicate-key / [Validator] error ends up a 500 through tryCatchRethrow. */
export const driverError = new Error('connection reset')

/** What a GraphQL mutation exposes to a caller: the field config's own resolver. */
export type Resolver = { resolve: (...a: never[]) => unknown }

/**
 * Calls a mutation the way Apollo does — root, args, context — so the suites read as the API does.
 *
 * Not a `*.test.mts` file on purpose: the unit project collects `test/*.test.mts`, so this sits beside the
 * suites without becoming one.
 */
export function run(mutation: Resolver, args: unknown): unknown {
	return mutation.resolve(null as never, args as never, ctx as never)
}
