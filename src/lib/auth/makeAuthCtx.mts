import { IRedisDataImprenditore } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataImprenditore'
import { IRedisDataImprenditoreForNode } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataImprenditoreForNode'
import { Types } from 'mongoose'

export function makeAuthCtx(redData: IRedisDataImprenditore): IRedisDataImprenditoreForNode {
	let dt: IRedisDataImprenditoreForNode = {
		_id: new Types.ObjectId(redData._id),
		email: redData.email
	}

	if (typeof redData.onboardingStep !== 'undefined') {
		dt.onboardingStep = redData.onboardingStep
	}

	return dt
}
