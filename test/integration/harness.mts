import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'

// The sources call dotenv.config() transitively (MongoDB/Redis datasources, handler); this is a
// belt-and-suspenders load so the REDIS_*/MONGODB_URI values are present at this file's top level.
dotenv.config()

import { start } from '../../src/index.mts'

/****************************************************************************************
 * Boot and drain, shared by every integration suite in this repo.
 *
 * Both suites boot the same server and tear down the same ownership chain, so the two
 * copies of that code were byte-identical — a duplication Qodana flagged twice, and a
 * real hazard besides: a fix to one drain order silently left the other wrong.
 ****************************************************************************************/

/** The raw driver handle — only defined once start() has connected. */
export function db() {
	return mongoose.connection.db!
}

/** Boot the real server on an ephemeral port and hand back its handle plus the base URL. */
export async function bootServer() {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB / clamd')

	const { httpServer } = server
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')

	return { httpServer, base: `http://127.0.0.1:${address.port}` }
}

/**
 * Cleanup must never abort halfway. `afterAll` drains MongoDB first and Redis second, so a single
 * failed delete — a cluster MOVED mid-resharding, a handle closed early — would otherwise strand
 * every id and key registered after it, and would skip the Redis drain entirely. Mongo residue is
 * harmless, globalSetup drops and re-migrates the database on the next run; a stranded Redis key
 * sits in the cluster for its whole TTL, which for a refresh session is 90 days.
 */
export async function drainSafely(what: string, remove: () => Promise<unknown>) {
	try {
		await remove()
	} catch (error) {
		console.error(`[afterAll] cleanup failed for ${what}:`, error)
	}
}

/** Delete every id this run wrote to one collection, one document at a time. */
export async function drainDocuments(collection: string, ids: mongoose.Types.ObjectId[]) {
	for (const _id of ids) {
		await drainSafely(`${collection} ${_id.toString()}`, () => db().collection(collection).deleteOne({ _id }))
	}
}

/**
 * The tail every suite ends with: the companies seeded, then the session keys, then the three
 * handles.
 */
export async function drainAndClose(httpServer: Server, seeded: { companies: mongoose.Types.ObjectId[]; keys: string[] }) {
	await drainDocuments('company', seeded.companies)
	// One del per key — this is a cluster, so a multi-key del would CROSSSLOT.
	for (const key of seeded.keys) {
		await drainSafely(key, () => redisClient.del(key))
	}

	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	await redisClient.close()
	await mongoose.disconnect()
}
