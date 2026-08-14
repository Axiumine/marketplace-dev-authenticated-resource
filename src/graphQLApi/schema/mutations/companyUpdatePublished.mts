import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { funCompanyUpdatePublished } from '@lib/company/funCompanyUpdatePublished.mjs'
import { throwIfShopOwnerDontOwnCompany } from '@lib/company/throwIfShopOwnerDontOwnCompany.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	published: boolean
}

/**
 * Publishes a shop of the signed-in owner, or takes it off the public site.
 *
 * The company half of the same split as `itemUpdatePublished`: `companyUpdate` saves the card,
 * this decides whether anyone sees it. The ownership guard runs first, as on every write here.
 *
 * ⚠️ **`published: true` can still fail, and the message comes from the database.** A shop must have a
 * `slug` and a `publicName` before it may be published — the `$expr` clause on the collection — and
 * both are optional fields of `GraphQLInputCompany`. An owner who has not named the shop yet has to
 * save it first and publish second, which is the same order the single mutation used to enforce inside
 * one call.
 */
export const companyUpdatePublished = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'publishes or unpublishes a company',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		published: { type: new GraphQLNonNull(GraphQLBoolean) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		await throwIfShopOwnerDontOwnCompany(ctx.state.user._id, args._id)

		try {
			await funCompanyUpdatePublished(args._id, ctx.state.user._id, args.published)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
