import type { GraphQLError } from 'graphql'
import { expect } from 'vitest'

type Outcome = { message: string; http: { status: number }; description: string }

/**
 * A thrown koa-utils error, flattened into a plain object.
 *
 * Every `throw*` helper in koa-utils builds its error the same way — `new GraphQLError(title, {
 * extensions: { http: { status }, description } })` — so `message` only ever holds one of a handful of
 * generic titles ('Oops', 'Conflict', 'Bad Request') shared by every failure in the service. The text
 * that says *which* failure it is lives in `extensions.description`, and `toThrow(...)` cannot see it:
 * it matches against `message` and would pass just as happily on the wrong error.
 *
 * Reading the description is also what makes an emptied string literal a failing test rather than a
 * surviving mutant — Stryker's StringLiteral mutator blanks exactly those messages.
 *
 * Not a `*.test.mts` file on purpose: the unit project collects `test/*.test.mts`, so this sits beside
 * the suites without becoming one.
 */
function unpack(e: unknown): Outcome {
	const { message, extensions } = e as GraphQLError

	return { message, ...(extensions as Omit<Outcome, 'message'>) }
}

/** As above, for the validators, which throw synchronously. */
export function failure(fn: () => unknown): Outcome {
	try {
		fn()
	} catch (e) {
		return unpack(e)
	}

	throw new Error('expected the call to throw, it returned')
}

/**
 * The description of a validator failure.
 *
 * Every one of them is `throwErrorWrongUserInput`, so title and status are always 'Bad Request' / 400
 * and only the message differs. `failure` above still asserts all three where a test has a reason to —
 * this is for the long `it.each` tables, where repeating the constant pair on every row hides the one
 * value that varies.
 */
export function reason(fn: () => unknown): string {
	const outcome = failure(fn)

	expect(outcome.message).toBe('Bad Request')
	expect(outcome.http).toEqual({ status: 400 })

	return outcome.description
}
