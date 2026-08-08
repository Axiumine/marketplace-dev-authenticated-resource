import { IRedisDataShopOwner } from '@axiumine/marketplace-common/others/Redis/IRedisDataShopOwner'
import { IRedisDataShopOwnerForNode } from '@axiumine/marketplace-common/others/Redis/IRedisDataShopOwnerForNode'
import { Types } from 'mongoose'

export function makeAuthCtx(redData: IRedisDataShopOwner): IRedisDataShopOwnerForNode {
	let dt: IRedisDataShopOwnerForNode = {
		_id: new Types.ObjectId(redData._id),
		email: redData.email
	}

	if (typeof redData.onboardingStep !== 'undefined') {
		dt.onboardingStep = redData.onboardingStep
	}

	return dt
}
