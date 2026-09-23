import { MongoDBDisconnect } from '@axiumine/koa-utils/dataSources/MongoDB'
import { RedisDisconnect } from '@axiumine/koa-utils/dataSources/Redis'
import * as Sentry from '@sentry/node'

/**
 * Disconnects from all databases and exits the process
 * @param exitCode - The exit code to use when terminating the process
 */
export async function disconnectAllDatabases(exitCode: number = 0): Promise<never> {
	const DISCONNECT_TIMEOUT = 5000 // 5 seconds timeout

	try {
		await Promise.race([
			Promise.all([MongoDBDisconnect(), RedisDisconnect()]),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Database disconnection timeout')), DISCONNECT_TIMEOUT))
		])

		Sentry.captureMessage('All databases disconnected successfully', 'info')
		// Flushed ahead of the exit below: this is the last thing the process does, so an event queued
		// and never sent is an event lost for good rather than merely delayed.
		await Sentry.flush(2000)
		process.exit(exitCode)
	} catch (e) {
		Sentry.captureException(e, {
			extra: { detail: 'Error during database disconnection' }
		})
		await Sentry.flush(2000)
		process.exit(1)
	}
}
