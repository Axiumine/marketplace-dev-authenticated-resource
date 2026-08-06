import http from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const RedisConnect = vi.fn()
const MongoDBConnect = vi.fn()
const initClamScan = vi.fn()
const disconnectAllDatabases = vi.fn()

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))
// redisClient is imported transitively by the handler; a bare stub is enough because the unit
// project never connects — only start()'s failure paths are exercised here.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient: {} }))
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBConnect }))
vi.mock('@axiumine/koa-utils/files/scanVirus', () => ({ initClamScan }))
vi.mock('@lib/db/disconnectAllDatabases.mjs', () => ({ disconnectAllDatabases }))

const {
	ENDPOINT,
	REQUIRED_ENV_VARS,
	checkRequiredEnv,
	buildValidationRules,
	healthResponse,
	logListening,
	gracefulShutdown,
	onUnhandledRejection,
	onUncaughtException,
	start
} = await import('../src/index.mts')

describe('ENDPOINT', () => {
	// logListening's test below only checks the banner *contains* ENDPOINT, which is true even if
	// the constant is mutated to '' — the string being asserted against would mutate right along
	// with it. Pin the literal directly.
	it('is the fixed mount path', () => {
		expect(ENDPOINT).toBe('/authenticated-resource')
	})
})

describe('checkRequiredEnv', () => {
	it('passes when every required variable is set', () => {
		const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, 'x']))
		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	// A plain Error, not a GraphQLError: this runs before the server exists, so there is nobody to
	// answer — the process is meant to die with the variable name in the log.
	it('names the first missing variable', () => {
		expect(() => checkRequiredEnv({})).toThrow(`Missing required environment variable: ${REQUIRED_ENV_VARS[0]}`)
	})

	// The *last* entry, so a mutant that stops the loop short is caught and not just one that skips
	// index 0. It used to be DSN, which is no longer required at all: Sentry is optional, and an
	// unset DSN leaves the SDK inert rather than stopping the service from serving.
	it('names a variable missing further down the list', () => {
		const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, 'x']))
		delete env.SAMESITE_COOKIE

		expect(() => checkRequiredEnv(env)).toThrow('Missing required environment variable: SAMESITE_COOKIE')
	})
})

describe('buildValidationRules', () => {
	it('is empty outside production', () => {
		expect(buildValidationRules({ NODE_ENV: 'test' })).toEqual([])
	})

	it('caps depth and blocks introspection in production', () => {
		expect(buildValidationRules({ NODE_ENV: 'production' })).toHaveLength(2)
	})
})

describe('healthResponse', () => {
	it('reports OK with a round-trippable ISO timestamp', () => {
		const res = healthResponse()
		expect(res.status).toBe('OK')
		expect(res.timestamp).toBe(new Date(res.timestamp).toISOString())
	})
})

describe('logListening', () => {
	let info: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureMessage.mockReset()
		info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
	})
	afterEach(() => {
		info.mockRestore()
		vi.unstubAllEnvs()
	})

	it('logs to the console only, outside production', () => {
		logListening({ NODE_ENV: 'test', PORT: '4026' })
		expect(info).toHaveBeenCalledTimes(1)
		expect(captureMessage).not.toHaveBeenCalled()
	})

	// Exact string, not stringContaining: a mutant that mangles the message but keeps ENDPOINT
	// intact must still fail this test, both for what reaches the console and what is mirrored
	// to Sentry — the two calls are built from the same `message` local, so both are pinned.
	it('also mirrors the exact banner to Sentry in production', () => {
		logListening({ NODE_ENV: 'production', PORT: '80' })
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith('Serving http://*:80/authenticated-resource for production.', 'info')
		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:80/authenticated-resource for production.')
	})

	// No HOSTNAME anywhere: the server binds every interface (see start (success path) below), so
	// the banner has no single host to print — pin the exact text instead of just "contains ENDPOINT".
	it('reports a wildcard host, never a specific one', () => {
		logListening({ NODE_ENV: 'test', PORT: '4026' })
		expect(info).toHaveBeenCalledWith('Serving http://*:4026/authenticated-resource for test.')
	})

	// The real call site — start(), on its success path — invokes logListening() with NO
	// arguments at all, relying on the process.env default parameter. Every test above passes an
	// explicit env object, which is a path production never takes: HOSTNAME going missing from
	// REQUIRED_ENV_VARS and the env template while a stale read of env.HOSTNAME remained here
	// would have printed "for undefined" and every one of those tests would still have stayed
	// green. Stub process.env directly and call with zero arguments to close that gap.
	it('falls back to process.env when called with no arguments, as start() does', () => {
		vi.stubEnv('NODE_ENV', 'test')
		vi.stubEnv('PORT', '4026')

		logListening()

		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:4026/authenticated-resource for test.')
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('also mirrors to Sentry from process.env when NODE_ENV is production and no arguments are passed', () => {
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('PORT', '80')

		logListening()

		expect(captureMessage).toHaveBeenCalledExactlyOnceWith('Serving http://*:80/authenticated-resource for production.', 'info')
		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:80/authenticated-resource for production.')
	})
})

describe('gracefulShutdown', () => {
	beforeEach(() => {
		captureMessage.mockReset()
		disconnectAllDatabases.mockReset()
	})

	it('drains Apollo, closes the server and disconnects with code 0', async () => {
		const apolloServer = { stop: vi.fn().mockResolvedValue(undefined) }
		const httpServer = { close: vi.fn((cb: () => void) => cb()) }

		await gracefulShutdown('SIGTERM', apolloServer as never, httpServer as never)

		expect(captureMessage).toHaveBeenCalledWith('SIGTERM received, shutting down gracefully...')
		expect(apolloServer.stop).toHaveBeenCalledTimes(1)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(0)
	})
})

describe('process handlers', () => {
	let exit: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})
	afterEach(() => exit.mockRestore())

	it('onUnhandledRejection reports the reason and exits 1', () => {
		const reason = new Error('boom')
		onUnhandledRejection(reason)
		expect(captureException).toHaveBeenCalledWith(reason)
		expect(exit).toHaveBeenCalledWith(1)
	})

	it('onUncaughtException reports the error and exits 1', () => {
		const error = new Error('kaboom')
		onUncaughtException(error)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(exit).toHaveBeenCalledWith(1)
	})
})

describe('start (failure path)', () => {
	let errorLog: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		disconnectAllDatabases.mockReset()
		RedisConnect.mockReset().mockResolvedValue(undefined)
		MongoDBConnect.mockReset().mockResolvedValue(undefined)
		initClamScan.mockReset().mockResolvedValue(undefined)
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		errorLog.mockRestore()
		vi.unstubAllEnvs()
	})

	it('reports to Sentry and disconnects with code 1 when MongoDB fails to connect', async () => {
		const error = new Error('mongo boom')
		MongoDBConnect.mockRejectedValueOnce(error)

		await start()

		expect(MongoDBConnect).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		// The console.error call carries a literal first argument ('error') alongside the real
		// error object — assert both, or a mutant that blanks the literal survives unnoticed.
		expect(errorLog).toHaveBeenCalledWith('error', error)
	})

	// Both datasources are opened by the same Promise.all, so Redis's rejection has to be covered
	// separately — MongoDB resolving is not enough to prove the catch handles either side.
	it('reports to Sentry and disconnects with code 1 when Redis fails to connect', async () => {
		const error = new Error('redis boom')
		RedisConnect.mockRejectedValueOnce(error)

		await start()

		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		expect(errorLog).toHaveBeenCalledWith('error', error)
	})

	// Unique to the resource tier: uploads are scanned, so a missing clamd is a boot failure and
	// not something to discover on the first upload.
	it('reports to Sentry and disconnects with code 1 when ClamAV cannot be initialised', async () => {
		const error = new Error('no clamd socket')
		initClamScan.mockRejectedValueOnce(error)

		await start()

		expect(initClamScan).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		expect(errorLog).toHaveBeenCalledWith('error', error)
	})
})

describe('start (success path)', () => {
	beforeEach(() => {
		captureException.mockReset()
		disconnectAllDatabases.mockReset()
		RedisConnect.mockReset().mockResolvedValue(undefined)
		MongoDBConnect.mockReset().mockResolvedValue(undefined)
		initClamScan.mockReset().mockResolvedValue(undefined)
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		// Real value for the one env var httpServer.listen() actually needs to bind a socket —
		// every other REQUIRED_ENV_VARS entry stays the harmless 'x' stub above, since nothing on
		// this path reads them. No HOSTNAME stub: the listen options carry no host key at all (see
		// start()), so a live one would go unread.
		vi.stubEnv('PORT', '0')
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	// The only place in the unit project that reaches past createServer(): every failure-path test
	// above rejects before getting here, so this is what actually exercises the httpServer.listen()
	// Promise, its options object and the success return value — the rest of "server wiring" stays
	// with the integration project (test/integration/index.itest.mts), which is what this test does
	// NOT do: it never sends it a request, so the auth middleware's real Redis client is never
	// touched.
	it('builds the real server, listens, and returns live handles', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
		// spyOn keeps the real implementation (it only records calls), so the socket still binds for
		// real — this is what proves the options object handed to listen() carries no host key at
		// all, not just that some field happens to be absent from a mock's recorded call.
		const listen = vi.spyOn(http.Server.prototype, 'listen')

		const server = await start()

		expect(server).toBeDefined()
		expect(server?.httpServer.listening).toBe(true)
		expect(listen).toHaveBeenCalledExactlyOnceWith({ port: '0' }, expect.any(Function))
		expect(info).toHaveBeenCalledTimes(1)
		expect(captureException).not.toHaveBeenCalled()
		expect(disconnectAllDatabases).not.toHaveBeenCalled()

		listen.mockRestore()
		info.mockRestore()
		await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()))
	})
})
