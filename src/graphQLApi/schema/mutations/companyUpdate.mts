import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputCompany } from '@GraphQLInput/GraphQLInputCompany.mjs'
import { IContextShopOwnerAuthenticatedResource } from '@lib/auth/IContextShopOwnerAuthenticatedResource.mjs'
import { funCompanyUpdate, ICompanyUpdate } from '@lib/company/funCompanyUpdate.mjs'
import { throwIfShopOwnerDontOwnCompany } from '@lib/company/throwIfShopOwnerDontOwnCompany.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	company: ICompanyUpdate
}

/** Saves a company of the signed-in owner. The ownership guard runs first, as on every write here. */
export const companyUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'update company',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		company: { type: new GraphQLNonNull(GraphQLInputCompany) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextShopOwnerAuthenticatedResource) {
		await throwIfShopOwnerDontOwnCompany(ctx.state.user._id, args._id)

		try {
			await funCompanyUpdate(args._id, ctx.state.user._id, args.company)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
