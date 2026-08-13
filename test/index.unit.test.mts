import http from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const RedisConnect = vi.fn()
const MongoDBConnect = vi.fn()
const initClamScan = vi.fn()
const disconnectAllDatabases = vi.fn()
const setupFieldEncryption = vi.fn()

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))
// redisClient is imported transitively by the handler; a bare stub is enough because the unit
// project never connects — only start()'s failure paths are exercised here.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient: {} }))
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBConnect }))
// Mocked because the real one opens a ClientEncryption against a live cluster and reads a 96-byte
// key file off disk (ADR-029) — neither exists in the unit project. What start() owes it is that it
// is awaited and that its rejection lands in the same catch as a datasource failure, and both are
// asserted below.
vi.mock('@axiumine/marketplace-common/encryption/setupFieldEncryption', () => ({ setupFieldEncryption }))
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
	createServer,
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
	/*
	 * ⚠️ The whole list, by value and in order, rather than a length or a `toContain`. This array is a
	 * contract with every environment the service is deployed into, and both ways of breaking it are
	 * silent: a name dropped from here turns a fatal misconfiguration into a service that starts and
	 * fails later, at a request, somewhere that does not name the cause; a name added here and read
	 * nowhere makes every environment carry a value that does nothing. A length check passes a swap and
	 * a `toContain` passes an addition, so neither notices the change. The order is asserted too — the
	 * boot names the *first* missing variable, and that is the one an operator goes looking for. E18-S03.
	 */
	it('requires exactly these 21 variables, in this order', () => {
		expect(REQUIRED_ENV_VARS).toStrictEqual([
			'PORT',
			'REDIS_IS_CLUSTER',
			'REDIS_DB1_HOST',
			'REDIS_DB2_HOST',
			'REDIS_DB3_HOST',
			'REDIS_DB1_PORT',
			'REDIS_DB2_PORT',
			'REDIS_DB3_PORT',
			'REDIS_USERNAME',
			'REDIS_PASSWORD',
			'REDIS_KEY',
			'MONGODB_URI',
			'CSFLE_MASTER_KEY_PATH',
			'CSFLE_KEY_VAULT_NAMESPACE',
			'REDIRECT_DOMAIN',
			'EMAIL_FROM',
			'DEV_TEAM_EMAIL',
			'HIT_STATS',
			'INTROSPECTION_CODE',
			'PLATFORM_NAME',
			'SAMESITE_COOKIE'
		])
	})

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

	// Named as literals, because none of the three tests above can see WHICH names the list carries:
	// the first builds its environment out of the list itself, so a corrupted entry is satisfied by
	// the very stub the corruption produced. Both are the boot contract of ADR-029 — a service that
	// started without either would write plaintext into collections whose other documents are
	// ciphertext, and only the guard here turns that into a refusal to start.
	it('requires the two field-encryption variables by name', () => {
		expect(REQUIRED_ENV_VARS).toContain('CSFLE_MASTER_KEY_PATH')
		expect(REQUIRED_ENV_VARS).toContain('CSFLE_KEY_VAULT_NAMESPACE')
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

/**
 * The state every start() test needs before it can assert anything: no leftover calls, both
 * datasources and both boot steps resolving, and a stub for every required variable so
 * checkRequiredEnv() is never the thing that fails. Each test then rejects exactly the one it is
 * about.
 */
function resetStartMocks() {
	captureException.mockReset()
	disconnectAllDatabases.mockReset()
	RedisConnect.mockReset().mockResolvedValue(undefined)
	MongoDBConnect.mockReset().mockResolvedValue(undefined)
	setupFieldEncryption.mockReset().mockResolvedValue(undefined)
	initClamScan.mockReset().mockResolvedValue(undefined)
	for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
}

describe('start (failure path)', () => {
	let errorLog: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		resetStartMocks()
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

	// A service that came up with field encryption broken would answer queries with ciphertext and
	// write plaintext beside it, so this failure has to be as fatal as a datasource failure.
	it('reports to Sentry and disconnects with code 1 when field encryption cannot start', async () => {
		const error = new Error('CSFLE_MASTER_KEY_PATH is not set — field encryption cannot start without it')
		setupFieldEncryption.mockRejectedValueOnce(error)

		await start()

		expect(setupFieldEncryption).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		expect(errorLog).toHaveBeenCalledWith('error', error)
	})
})

describe('start (success path)', () => {
	beforeEach(() => {
		resetStartMocks()
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
		// Once, with no arguments: it reads its configuration from the environment, and a caller that
		// passed it anything would be building a second source of truth for the master key path.
		expect(setupFieldEncryption).toHaveBeenCalledExactlyOnceWith()
		expect(info).toHaveBeenCalledTimes(1)
		expect(captureException).not.toHaveBeenCalled()
		expect(disconnectAllDatabases).not.toHaveBeenCalled()

		listen.mockRestore()
		info.mockRestore()
		await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()))
	})
})

// ⚠️ **`app.proxy` off is load-bearing, not an unset default nobody thought about.** With it off,
// `ctx.ip` is the socket address — nginx's own — so no client address is reachable in this process
// at all, which is the design: the per-caller rate limit is the edge's (`conf.d/20-rate-limit.conf`
// keys its zones on `$binary_remote_addr` after `real_ip_header CF-Connecting-IP`), and nothing here
// can write a visitor's address to Redis, to a log line or to Sentry. Turning it on would silently
// start trusting `X-Forwarded-For` and start producing real addresses everywhere `ctx.ip` is read.
// A comment cannot prevent that; this test can, and it is the reason the setting is never assigned.
describe('app.proxy', () => {
	it('is off on the constructed Koa app', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')

		const { app, apolloServer } = await createServer()

		expect(app.proxy).toBeFalsy()

		await apolloServer.stop()
		vi.unstubAllEnvs()
	})
})

/*
 * ⚠️ The boot itself, not just `checkRequiredEnv`. The check runs OUTSIDE `start()`'s try, so a missing
 * variable has to travel out of `start()` to the caller instead of being swallowed into the
 * disconnect-and-exit that handles a datasource failure — and it must get there before anything has
 * connected, because a datasource handle left half-open by a boot nobody completed is a connection
 * the pool goes on holding. E18-S03.
 */
describe('start (missing environment)', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('rejects — with no datasource touched — when a required variable is missing', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		vi.stubEnv('REDIS_KEY', '')
		RedisConnect.mockClear()
		disconnectAllDatabases.mockClear()

		await expect(start()).rejects.toThrow('Missing required environment variable: REDIS_KEY')
		expect(RedisConnect).not.toHaveBeenCalled()
		expect(disconnectAllDatabases).not.toHaveBeenCalled()
	})
})
