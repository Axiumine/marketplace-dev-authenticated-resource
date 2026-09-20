import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { Types } from 'mongoose'
import { describe, expect, it } from 'vitest'

import { makeAuthCtx } from '../src/lib/auth/makeAuthCtx.mts'

const OID = '507f1f77bcf86cd799439011'

describe('makeAuthCtx', () => {
	// Redis stores everything as strings; the rest of the service expects a real ObjectId, so this
	// is where the conversion has to happen — resolvers must never re-parse it.
	it('turns the Redis hash into the node-side context, rehydrating _id as an ObjectId', () => {
		const user = makeAuthCtx({ _id: OID, email: 'oste@marketplace.test', tier: TIER.shopOwner })

		expect(user._id).toBeInstanceOf(Types.ObjectId)
		expect(user._id.toHexString()).toBe(OID)
		expect(user.email).toBe('oste@marketplace.test')
		expect('onboardingStep' in user).toBe(false)
	})

	// onboardingStep is optional and must stay absent rather than become `undefined`: the key is
	// only written to Redis while the shopOwner is still walking through onboarding.
	it('copies onboardingStep across when the session carries one', () => {
		const user = makeAuthCtx({ _id: OID, email: 'oste@marketplace.test', tier: TIER.shopOwner, onboardingStep: '3' })

		expect(user.onboardingStep).toBe('3')
	})
})
