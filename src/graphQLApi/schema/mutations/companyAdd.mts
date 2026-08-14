import { OnlyIdType } from '@axiumine/koa-utils/graphQL/schema/types/OnlyIdType'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { ICompanySchema } from '@axiumine/marketplace-common/models/MongoDBInterfaces/ICompanySchema'
import { GraphQLInputCompany } from '@GraphQLInput/GraphQLInputCompany.mjs'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { ICompanyUpdate } from '@lib/company/funCompanyUpdate.mjs'
import { GraphQLError, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	company: ICompanyUpdate
}

/**
 * Creates a company for the signed-in owner.
 *
 * New with 20260803000100: the company used to be typed into the shop-add mutation and stored inside
 * the shop, which made the second shop of the same chain collide on the unique VAT number. It is
 * created once here and then referenced by id.
 *
 * The new `_id` is the return value — unlike the operator tier's `Boolean`, because the owner's own flow
 * is "create the company, then create the shop under it" and the second step needs the id the first one
 * produced.
 */
export const companyAdd = {
	type: new GraphQLNonNull(OnlyIdType),
	description: 'add company',
	args: {
		company: { type: new GraphQLNonNull(GraphQLInputCompany) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		// `published: false` is stamped here rather than taken from the input: publishing is
		// `companyUpdatePublished`. It is also the only value the validator would accept from a shop
		// this new — `published: true` needs a `slug` and a `publicName`, both optional on the input.
		const newCompany: ICompanySchema = {
			_id: new Types.ObjectId(),
			idShopOwner: ctx.state.user._id,
			...args.company,
			published: false
		}

		// `return await`, not `return`: without the await the promise escapes the try, so the catch
		// below can never run and a duplicate VAT number would surface as an unhandled rejection
		// instead of the 409 tryCatchRethrow makes of it.
		try {
			return await Company.create(newCompany)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
