import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import mongoose from 'mongoose'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { start } from '../../src/index.mts'

/*
 * start()'s catch arm — the boot-failure path — driven for real.
 *
 * No fault is simulated: the datasource URL is pointed at something MongoDB genuinely refuses, and
 * the real driver raises the real error. Redis still connects for real on the same Promise.all,
 * which is the point of doing it this way: the catch has to tear down a HALF-CONNECTED process,
 * and disconnectAllDatabases really closes that live Redis client on the way out. The failure lands
 * inside the Promise.all that connects the datasources, which is BEFORE initClamScan() runs, so
 * this path never touches the antivirus daemon either.
 *
 * Its own file because it must run with nothing connected yet — index.itest.mts boots the service
 * in its own beforeAll, and vitest gives each test file its own module registry, so this one starts
 * from a clean slate.
 */
describe('start() when MongoDB refuses the connection', () => {
	const realUri = process.env.MONGODB_URI

	afterAll(async () => {
		process.env.MONGODB_URI = realUri
		await redisClient.close().catch(() => undefined)
	})

	it('logs, tears down the datasources that did come up, and exits 1', async () => {
		// Shaped like a connection string, so both env guards pass it, and refused by the driver
		// itself, which cannot read `99999` as a port. That keeps the failure where this test wants it —
		// inside MongoDBConnect()'s real driver — and off the two guards, which the tests below own.
		process.env.MONGODB_URI = 'mongodb://127.0.0.1:99999/dbRefused'

		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		try {
			// Resolves rather than throwing: the catch handles the error and (normally) exits.
			await expect(start()).resolves.toBeUndefined()

			expect(errorLog).toHaveBeenCalled()
			expect(exit).toHaveBeenCalledWith(1)

			// The teardown was real, not just attempted: mongoose never came up and the Redis client
			// that did is closed again.
			expect(mongoose.connection.readyState).toBe(0)
			expect(redisClient.isOpen).toBe(false)
		} finally {
			exit.mockRestore()
			errorLog.mockRestore()
		}
	})

	/*
	 * The env guard runs OUTSIDE start()'s try, so a missing variable is not caught, not reported
	 * to Sentry, and never reaches disconnectAllDatabases — it propagates straight out of start()
	 * and the process dies without touching a datasource. Driven through start() rather than by
	 * calling checkRequiredEnv() directly, so it is that ordering being tested and not just the
	 * guard's own loop. It used to delete PLATFORM_NAME, which nothing in this suite's setup touched —
	 * until that variable left REQUIRED_ENV_VARS as read by nothing, at which point the
	 * boot no longer minded its absence and this test failed on the real service reaching MongoDB.
	 * STATIC_FOLDER replaces it and is the better choice anyway: it is the LAST entry of the list, so a
	 * mutant that stops the loop one short fails here as well as in the unit suite. The restore in
	 * `finally` puts back exactly what was there, and the delete window closes before anything else in the
	 * process can read it.
	 */
	it('refuses to boot at all, and connects nothing, when a required variable is missing', async () => {
		const realKey = process.env.STATIC_FOLDER
		delete process.env.STATIC_FOLDER

		try {
			await expect(start()).rejects.toThrow('Missing required environment variable: STATIC_FOLDER')

			expect(mongoose.connection.readyState).toBe(0)
			expect(redisClient.isOpen).toBe(false)
		} finally {
			process.env.STATIC_FOLDER = realKey
		}
	})
})
