import type { AddressInfo } from 'node:net'

import type { EnvShape } from '@axiumine/marketplace-common/others/assertEnvShape'
import http from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const flush = vi.fn()
const RedisConnect = vi.fn()
const MongoDBConnect = vi.fn()
const initClamScan = vi.fn()
const reportClamSignatureAge = vi.fn()
const disconnectAllDatabases = vi.fn()
const setupFieldEncryption = vi.fn()
const hGetAll = vi.fn()

/** The NodeClam initClamScan() hands back — identity is all start() does with it, so it needs no behaviour. */
const clamScanner = { getVersion: vi.fn() }

/*
 * Captured constructor/factory arguments for the three real, unmocked config objects createServer()
 * builds: graphql-upload's limits, koa-bodyparser's options, and the options object handed to the
 * Apollo/Koa integration. Every wrapper delegates to the real implementation — upload handling, body
 * parsing and the Apollo request path all behave exactly as in production — they only additionally
 * record what they were called with, so the option literals themselves have something asserting their
 * exact value instead of merely being reached. Without that, a mutant that empties one of those
 * objects is executed on every request and still changes nothing any test can see.
 */
const graphqlUploadOptions: unknown[] = []
const bodyParserOptions: unknown[] = []
const koaMiddlewareOptions: { context?: () => Promise<unknown> }[] = []
const apolloServerOptions: { pluginCount: number | undefined; csrfPrevention: unknown }[] = []

vi.mock('@sentry/node', () => ({ captureException, captureMessage, flush }))
// redisClient is imported transitively by the handler, and start() itself now reads one key off it:
// the keygrip record, to prove REDIS_KEY names the namespace this platform was seeded into (ADR-034).
// hGetAll is the only verb that probe uses, so the stub carries that and nothing else.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient: { hGetAll } }))
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBConnect }))
// Mocked because the real one opens a ClientEncryption against a live cluster and reads a 96-byte
// key file off disk (ADR-029) — neither exists in the unit project. What start() owes it is that it
// is awaited and that its rejection lands in the same catch as a datasource failure, and both are
// asserted below.
vi.mock('@axiumine/marketplace-common/encryption/setupFieldEncryption', () => ({ setupFieldEncryption }))
vi.mock('@axiumine/koa-utils/files/scanVirus', () => ({ initClamScan }))
// Mocked because the real one talks to the daemon initClamScan just opened. What start() owes it is
// that it is handed that daemon and awaited; what it does with the answer is its own suite's business.
vi.mock('@lib/clam/reportClamSignatureAge.mjs', () => ({ reportClamSignatureAge }))
vi.mock('@lib/db/disconnectAllDatabases.mjs', () => ({ disconnectAllDatabases }))
vi.mock('graphql-upload/graphqlUploadKoa.mjs', async (importOriginal) => {
	const actual = await importOriginal<{ default: (options: unknown) => unknown }>()
	return {
		default: (options: unknown) => {
			graphqlUploadOptions.push(options)
			return actual.default(options)
		}
	}
})
vi.mock('koa-bodyparser', async (importOriginal) => {
	// `@types/koa-bodyparser` declares `export =`, so `typeof import('koa-bodyparser')` is the bare
	// callable at the type level, with no `.default` — but importOriginal(), like a real dynamic
	// `import()` of a CommonJS module, hands back a namespace object whose `.default` is that callable.
	// Stating that actual runtime shape explicitly (as the graphql-upload mock above already does)
	// keeps the call below typed correctly instead of asserting through a shape that has no `.default`.
	const actual = await importOriginal<{ default: typeof import('koa-bodyparser') }>()
	return {
		// koa-bodyparser mutates its `opts` argument in place (it sets detectJSON/onerror/
		// returnRawBody directly on the object it was given), so the options object must be
		// snapshotted with a shallow copy BEFORE calling through, or the recorded value would
		// reflect koa-bodyparser's post-mutation state instead of what src/index.mts passed in.
		default: (options: Parameters<typeof actual.default>[0]) => {
			bodyParserOptions.push({ ...options })
			return actual.default(options)
		}
	}
})
// Recording wrapper only: `koaMiddleware` is re-exported untouched apart from the push, because what
// is under test is the options literal src/index.mts builds, not the integration's own behaviour.
// Typed through `unknown[]` rather than `Parameters<>`: koaMiddleware is generic in its context type,
// and naming that type here would fix the very thing the assertion is meant to read back.
vi.mock('@as-integrations/koa', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@as-integrations/koa')>()
	const real = actual.koaMiddleware as unknown as (...args: unknown[]) => unknown
	return {
		...actual,
		koaMiddleware: (...args: unknown[]) => {
			koaMiddlewareOptions.push(args[1] as { context?: () => Promise<unknown> })
			return real(...args)
		}
	}
})
vi.mock('@apollo/server', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@apollo/server')>()
	class SpiedApolloServer extends actual.ApolloServer {
		constructor(options: ConstructorParameters<typeof actual.ApolloServer>[0]) {
			// ApolloServer's real constructor appends its own built-in plugins (landing page,
			// usage reporting, ...) directly onto the `plugins` array it was given, so the count
			// must be read BEFORE calling super() — reading it after would count Apollo's own
			// plugins alongside ours. Referencing the constructor parameter before super() is
			// fine; only `this` is off-limits until super() runs.
			const pluginCount = options?.plugins?.length
			const csrfPrevention = options?.csrfPrevention
			super(options)
			apolloServerOptions.push({ pluginCount, csrfPrevention })
		}
	}
	return { ...actual, ApolloServer: SpiedApolloServer }
})

const {
	ENDPOINT,
	REQUIRED_ENV_VARS,
	ENV_SHAPES,
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

/*
 * ⚠️ The shape table the cases below are driven from is written out here rather than read off
 * `ENV_SHAPES`, and the two are reconciled by one assertion. `it.each` is evaluated when vitest
 * COLLECTS the file, and in the services that import `src/index.mts` dynamically inside a `beforeAll`
 * — which is how a module-load-time mutant is made attributable to a test — the export does not exist
 * yet at that moment. A table read from the module would generate zero cases there, and zero cases is
 * a green run. Written here it generates the same cases in all nine.
 */
const EXPECTED_SHAPES: Readonly<Record<string, EnvShape>> = {
	PORT: 'port',
	REDIS_IS_CLUSTER: 'flag01',
	REDIS_URL: 'redisUrl',
	REDIS_DB1_HOST: 'hostname',
	REDIS_DB2_HOST: 'hostname',
	REDIS_DB3_HOST: 'hostname',
	REDIS_DB1_PORT: 'port',
	REDIS_DB2_PORT: 'port',
	REDIS_DB3_PORT: 'port',
	REDIS_KEY: 'keyPrefix',
	MONGODB_URI: 'mongoUri',
	CSFLE_MASTER_KEY_PATH: 'absolutePath',
	CSFLE_KEY_VAULT_NAMESPACE: 'namespace',
	STATIC_FOLDER: 'absolutePath'
}

/**
 * A value of the right *kind* for every name the map above constrains, and `'x'` for every name it does
 * not. `checkRequiredEnv` runs a shape pass after the presence loop, so an environment of `'x'`
 * everywhere no longer reaches the branch a test is about — it fails on `PORT` before getting there.
 *
 * `flag01` samples `'0'`, which keeps the default environment on the single-node Redis branch the old
 * `'x'` landed on: every test below that turns on `REDIS_URL` still tests what it used to.
 */
const SHAPED: Readonly<Record<EnvShape, string>> = {
	absolutePath: '/srv/marketplace',
	email: 'noreply@shop.lan',
	flag01: '0',
	hostname: 'db1',
	keyPrefix: 'marketplaceDev:',
	mongoUri: 'mongodb://127.0.0.1:27017/dbMarketplaceDev',
	namespace: 'dbMarketplaceDev.__keyVault',
	origin: 'https://shop.lan',
	// ⚠️ `0`, not a real port: `validEnv()` reaches `start()` in the tests below and a fixed number would
	// make them bind it for real — colliding with whichever service of this fleet is running on the
	// developer's machine. `0` is the ephemeral port the integration projects bind on for the same reason.
	port: '0',
	redisUrl: 'redis://127.0.0.1:6379'
}

/** One value of the wrong kind per shape, each a mistake a real environment makes rather than nonsense. */
const MISSHAPEN: Readonly<Record<EnvShape, string>> = {
	absolutePath: 'srv/marketplace',
	email: 'noreply.shop.lan',
	flag01: 'true',
	hostname: 'redis://db1',
	keyPrefix: 'marketplaceDev',
	mongoUri: 'redis://127.0.0.1:6379',
	namespace: 'dbMarketplaceDev',
	origin: 'https://shop.lan/',
	port: '4027x',
	redisUrl: 'mongodb://127.0.0.1:27017/dbMarketplaceDev'
}

const shaped = (name: string): string => SHAPED[EXPECTED_SHAPES[name]] ?? 'x'
const validEnv = (): Record<string, string> => Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, shaped(k)]))

describe('checkRequiredEnv', () => {
	/*
	 * ⚠️ The whole list, by value and in order, rather than a length or a `toContain`. This array is a
	 * contract with every environment the service is deployed into, and both ways of breaking it are
	 * silent: a name dropped from here turns a fatal misconfiguration into a service that starts and
	 * fails later, at a request, somewhere that does not name the cause; a name added here and read
	 * nowhere makes every environment carry a value that does nothing. A length check passes a swap and
	 * a `toContain` passes an addition, so neither notices the change. The order is asserted too — the
	 * boot names the *first* missing variable, and that is the one an admin goes looking for.
	 */
	it('requires exactly these 16 variables, in this order', () => {
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
			'STATIC_FOLDER'
		])
	})

	// ⚠️ `REDIS_URL` is set here and is deliberately NOT in the list: it is required only when
	// `REDIS_IS_CLUSTER` is not `'1'`, which is the branch `validEnv()`'s `'0'` lands on.
	it('passes when every required variable is set', () => {
		const env = { ...validEnv(), REDIS_URL: 'redis://127.0.0.1:6379' }
		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	// A plain Error, not a GraphQLError: this runs before the server exists, so there is nobody to
	// answer — the process is meant to die with the variable name in the log.
	it('names the first missing variable', () => {
		expect(() => checkRequiredEnv({})).toThrow(`Missing required environment variable: ${REQUIRED_ENV_VARS[0]}`)
	})

	// The *last* entry, so a mutant that stops the loop short is caught and not just one that skips
	// index 0. It used to be DSN, which is no longer required at all: Sentry is optional, and an
	// unset DSN leaves the SDK inert rather than stopping the service from serving. Then it was
	// SAMESITE_COOKIE, which left the list as read by nothing — the name has to be the one the list ends
	// with today, so this assertion moves every time the tail of the list does. It ends with STATIC_FOLDER now: `moveFileStaticDomain` interpolates it into the destination
	// path, and unset it does not fail — the picture lands under a directory literally named
	// `undefined`, which no vhost serves.
	it('names a variable missing further down the list', () => {
		const env = validEnv()
		delete env.STATIC_FOLDER

		expect(() => checkRequiredEnv(env)).toThrow('Missing required environment variable: STATIC_FOLDER')
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

	/*
	 * ⚠️ **The single-node branch — the one `SETUP.md` puts a fresh machine on.** `REDIS_URL` is not in
	 * `REQUIRED_ENV_VARS` and must not be: the committed `env` ships it empty because this stack runs the
	 * cluster branch, where nothing reads it. So the guard is a branch of its own and gets its own tests.
	 * Unset, it is an error nowhere else — node-redis defaults the url to `redis://localhost:6379` and the
	 * service connects to whatever answers there, which is the wrong-but-populated environment
	 * `RISK_REGISTER` R04 describes.
	 */
	it('requires REDIS_URL when REDIS_IS_CLUSTER is not "1"', () => {
		const env = validEnv()
		env.REDIS_IS_CLUSTER = '0'

		expect(() => checkRequiredEnv(env)).toThrow('Missing required environment variable: REDIS_URL')
	})

	it('accepts the single-node branch once REDIS_URL names a server', () => {
		const env = validEnv()
		env.REDIS_IS_CLUSTER = '0'
		env.REDIS_URL = 'redis://127.0.0.1:6379'

		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	// ⚠️ The cluster branch builds its client from REDIS_DB1..DB3 and never reads REDIS_URL, so demanding it
	// here would refuse the boot of every machine this workspace ships configured. `'1'` exactly, as a
	// string: that is the comparison koa-utils makes, and `1` or `'true'` takes the single-node branch.
	it('does not require REDIS_URL on the cluster branch', () => {
		const env = validEnv()
		env.REDIS_IS_CLUSTER = '1'

		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	/*
	 * ⚠️ The whole map, by value, for the same reason the array above is asserted whole: both ways of
	 * breaking it are silent. A name dropped from `ENV_SHAPES` stops being checked and the boot goes back
	 * to accepting any non-empty string in that slot; a shape changed to the wrong one refuses a correct
	 * value on the next machine provisioned. Neither shows up in a run of this suite otherwise — and it is
	 * also what ties `EXPECTED_SHAPES` to the module, so the table cannot quietly drift into testing a map
	 * the service does not use.
	 */
	it('shape-checks exactly these names', () => {
		expect(ENV_SHAPES).toStrictEqual(EXPECTED_SHAPES)
	})

	/*
	 * One wrong-kind value per name, on an environment that is otherwise complete and well formed — so
	 * the only thing that can fail is the shape pass, and the message must name that one variable.
	 * `REDIS_URL` is spread in because a misshapen `REDIS_IS_CLUSTER` is not `'1'` and puts the check on
	 * the single-node branch, where an absent url is a *presence* fault that would mask the shape one.
	 */
	it.each(Object.entries(EXPECTED_SHAPES))('refuses a %s that is not a valid %s', (name, shape) => {
		const env = { ...validEnv(), REDIS_URL: SHAPED.redisUrl, [name]: MISSHAPEN[shape] }

		expect(() => checkRequiredEnv(env)).toThrow(`ENV_SHAPE_INVALID: ${name} must be `)
	})

	// Every fault at once: provisioning a machine is when this fires, and one name per restart is a queue.
	it('names every misshapen variable in one message', () => {
		const env = { ...validEnv(), REDIS_URL: SHAPED.redisUrl, PORT: MISSHAPEN.port, REDIS_KEY: MISSHAPEN.keyPrefix }

		expect(() => checkRequiredEnv(env)).toThrow(
			'ENV_SHAPE_INVALID: PORT must be a TCP port between 0 and 65535; REDIS_KEY must be a key prefix ending in ":".'
		)
	})

	/*
	 * ⚠️ Presence first, shape second, and the order is the assertion. One name is unset here *and*
	 * `PORT` is misshapen; the boot must name the missing one, because an admin told to fix a format in
	 * a variable they have not written yet goes looking for a line that is not in the file.
	 */
	it('reports a missing variable before a misshapen one', () => {
		const env: Record<string, string> = { ...validEnv(), REDIS_URL: SHAPED.redisUrl, PORT: MISSHAPEN.port }
		delete env.MONGODB_URI

		expect(() => checkRequiredEnv(env)).toThrow('Missing required environment variable: MONGODB_URI')
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
		flush.mockReset().mockResolvedValue(true)
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})
	afterEach(() => exit.mockRestore())

	// Neither handler can `await`: Node calls them synchronously and does not wait for a returned
	// promise, so process.exit() has to be reached from flush()'s own callback instead — pinned with
	// the exact timeout, or a boot-time crash is reported to the log and lost from Sentry regardless.
	it('onUnhandledRejection reports the reason, flushes Sentry, then exits 1', async () => {
		const reason = new Error('boom')
		onUnhandledRejection(reason)
		expect(captureException).toHaveBeenCalledWith(reason)

		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))

		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
	})

	// The ordering itself, not just that both eventually happened: process.exit() must wait on the
	// flush promise settling, or a mutant that drops the `.finally` wiring and exits immediately would
	// pass the test above unnoticed.
	it('onUnhandledRejection does not exit until the flush settles', async () => {
		let resolveFlush: (value: boolean) => void = () => undefined
		flush.mockReturnValueOnce(new Promise<boolean>((resolve) => (resolveFlush = resolve)))

		onUnhandledRejection(new Error('boom'))
		await Promise.resolve()
		await Promise.resolve()
		expect(exit).not.toHaveBeenCalled()

		resolveFlush(true)
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
	})

	it('onUncaughtException reports the error, flushes Sentry, then exits 1', async () => {
		const error = new Error('kaboom')
		onUncaughtException(error)
		expect(captureException).toHaveBeenCalledWith(error)

		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))

		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
	})

	it('onUncaughtException does not exit until the flush settles', async () => {
		let resolveFlush: (value: boolean) => void = () => undefined
		flush.mockReturnValueOnce(new Promise<boolean>((resolve) => (resolveFlush = resolve)))

		onUncaughtException(new Error('kaboom'))
		await Promise.resolve()
		await Promise.resolve()
		expect(exit).not.toHaveBeenCalled()

		resolveFlush(true)
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
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
	// The scanner start() gets back, and the only member anything downstream of it reads.
	initClamScan.mockReset().mockResolvedValue(clamScanner)
	reportClamSignatureAge.mockReset().mockResolvedValue({ state: 'fresh', alerted: false, detail: 'stubbed' })
	// A seeded namespace, so every test below is about the failure it arms rather than about the
	// keygrip probe start() now runs first. Only `wrapped` is read — presence, never the value.
	hGetAll.mockReset().mockResolvedValue({ wrapped: 'seeded' })
	// ⚠️ `REDIS_URL` is stubbed on top of the list because it is not in it: the guard requires it only
	// when `REDIS_IS_CLUSTER` is not `'1'`, and `validEnv()`'s `'0'` is that branch.
	for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, shaped(k))
	vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379')
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

	/*
	 * ⚠️ **A connection that opened is not a namespace that exists.** `REDIS_KEY` is a prefix, so a value
	 * naming a namespace nobody seeded connects, answers and stays empty: before this probe the service
	 * booted clean and then missed on every session lookup, answering 401 to every shop owner while the
	 * fleet around it worked — `RISK_REGISTER` R04's local half. Same outcome as any other boot failure,
	 * which is the point: it dies rather than serving.
	 */
	it('reports to Sentry and disconnects with code 1 when the keygrip record is not in this namespace', async () => {
		hGetAll.mockResolvedValueOnce({})

		await start()

		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(`${SHAPED.keyPrefix}keygrip`)
		expect(captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('KEYGRIP_RECORD_MISSING') })
		)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		// Before field encryption: nothing that touches data runs on a connection whose namespace the
		// service could not find.
		expect(setupFieldEncryption).not.toHaveBeenCalled()
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
		// Nothing asks a scanner that failed to start how old its signatures are.
		expect(reportClamSignatureAge).not.toHaveBeenCalled()
	})

	/*
	 * A reachable scanner and a current one are not the same claim, and only the second one keeps an
	 * upload safe — RISK_REGISTER R22. This asserts the reading happens at boot and is handed the daemon
	 * initClamScan opened; that a stale answer is reported rather than thrown on is asserted where the
	 * reading itself lives, in test/reportClamSignatureAge.test.mts.
	 */
	it('asks the scanner it just opened how old its signatures are', async () => {
		await start()

		expect(reportClamSignatureAge).toHaveBeenCalledExactlyOnceWith(clamScanner)
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
		// The keygrip record read once, at `<REDIS_KEY>keygrip` — the exact key, because the whole point
		// of the probe is which namespace it looked in. `REDIS_KEY` is the 'x' stub here.
		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(`${SHAPED.keyPrefix}keygrip`)
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
/*
 * ⚠️ createServer() assembled and then actually driven, over a real socket. It connects no
 * datasource — start() does that, separately — so the whole stack can be listened on an ephemeral
 * port and requested with `fetch`, with Redis mocked at the one seam the bearer gate reads
 * (`hGetAll`, the same seam authorizationAuthenticatedResourceHandler.test.mts uses) and no cluster
 * anywhere. Every other test in this file stops at the handles createServer() returns, which left
 * the auth middleware, the upload/bodyparser wiring and all three routing arms reachable only from
 * test/integration/index.itest.mts — a project Stryker never runs (see vitest.mutation.config.mts),
 * so they were excluded from `mutate` by line range instead of tested.
 */
describe('createServer (real Koa/Apollo assembly, driven over a real socket)', () => {
	// The bearer gate runs before any routing decision, so every request that expects to get past it
	// carries a real access credential; `tier` is not decoration, because the handler refuses a
	// session that does not carry `shopOwner` and the whole assembly would answer 403 instead.
	const OID = '507f1f77bcf86cd799439011'
	const AUTHENTICATED = { authorization: 'Bearer access:unit-test-token' }

	let app: Awaited<ReturnType<typeof createServer>>['app']
	let httpServer: Awaited<ReturnType<typeof createServer>>['httpServer']
	let apolloServer: Awaited<ReturnType<typeof createServer>>['apolloServer']
	let base: string

	beforeEach(async () => {
		graphqlUploadOptions.length = 0
		bodyParserOptions.length = 0
		koaMiddlewareOptions.length = 0
		apolloServerOptions.length = 0
		hGetAll
			.mockReset()
			.mockResolvedValue(Object.assign(Object.create(null), { _id: OID, email: 'oste@marketplace.test', tier: 'shopOwner' }))

		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, shaped(k))
		vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379')

		const server = await createServer()
		app = server.app
		httpServer = server.httpServer
		apolloServer = server.apolloServer

		await new Promise<void>((resolve) => httpServer.listen(0, resolve))
		base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
	})

	afterEach(async () => {
		await apolloServer.stop()
		await new Promise<void>((resolve) => httpServer.close(() => resolve()))
		vi.unstubAllEnvs()
	})

	/*
	 * The whole options object in each case, not a subset: `graphqlUploadKoa({})` (no size or file
	 * cap at all — a 30MB limit and a 10-file limit replaced by graphql-upload's own defaults),
	 * `bodyParserKoa({})` (every key dropped), an emptied `enableTypes`/`extendTypes.json` array or
	 * any one of the three type strings blanked all still reach their real implementation, still
	 * serve requests, and all still fail this exact match.
	 */
	it('caps uploads at 30MB and 10 files, and parses json/form/text bodies', () => {
		expect(graphqlUploadOptions).toEqual([{ maxFileSize: 30000000, maxFiles: 10 }])
		expect(bodyParserOptions).toEqual([
			{
				enableTypes: ['json', 'form', 'text'],
				// Multipart requests are deliberately excluded here — graphqlUploadKoa handles
				// those — so only 'application/json' extends the json type, nothing else.
				extendTypes: { json: ['application/json'] }
			}
		])
	})

	// pluginCount asserts the drain plugin is still wired (an emptied `plugins` array would leave the
	// httpServer undrained on shutdown); csrfPrevention: true is what keeps this endpoint refusing a
	// simple, credentialed cross-site POST, asserted end to end two tests below.
	it('hardens Apollo with the drain plugin and csrfPrevention', () => {
		expect(apolloServerOptions).toEqual([{ pluginCount: 1, csrfPrevention: true }])
	})

	it('serves the assembled schema at ENDPOINT for an authenticated caller', async () => {
		const res = await fetch(`${base}${ENDPOINT}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...AUTHENTICATED },
			body: JSON.stringify({ query: '{ __schema { queryType { name } mutationType { name } } }' })
		})
		const json = (await res.json()) as {
			data?: { __schema: { queryType: { name: string }; mutationType: { name: string } } }
		}

		expect(res.status).toBe(200)
		expect(json.data?.__schema).toEqual({ queryType: { name: 'QueriesApi' }, mutationType: { name: 'MutationsApi' } })
	})

	/*
	 * ⚠️ The raw Koa `ctx`, not the integration's own empty default — read off the options object
	 * rather than out of a resolver, because every resolver in this schema reaches Mongo before it
	 * touches the context. What the options object shows is exactly what is at stake: the resolvers
	 * scope their queries by `ctx.state.user._id`, which the auth middleware wrote onto this very
	 * object, so a `context()` returning `undefined` — or an options literal emptied to `{}`, which
	 * makes the integration supply its own `{}` instead — is a resolver with no caller identity.
	 */
	it('hands the Koa ctx of the request itself to Apollo as the resolver context', async () => {
		const res = await fetch(`${base}${ENDPOINT}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...AUTHENTICATED },
			body: JSON.stringify({ query: '{ __typename }' })
		})
		await res.json()

		expect(koaMiddlewareOptions).toHaveLength(1)
		const context = koaMiddlewareOptions[0]?.context
		expect(context).toBeTypeOf('function')

		const ctx = (await context?.()) as { path: string; app: unknown; state: { user: { _id: string } } }
		expect(ctx.path).toBe(ENDPOINT)
		expect(ctx.app).toBe(app)
		// And it is the ctx the auth middleware has already written to, not a bare one.
		expect(ctx.state.user._id.toString()).toBe(OID)
	})

	/*
	 * Apollo's CSRF prevention treats `application/x-www-form-urlencoded` as suspicious unless a
	 * non-empty `x-apollo-operation-name` (or `apollo-require-preflight`) header is present. With
	 * `csrfPrevention: false` this request would instead reach runHttpQuery and fail on a different,
	 * later check.
	 */
	it('blocks a form-encoded POST with no preflight header as a potential CSRF attempt', async () => {
		const res = await fetch(`${base}${ENDPOINT}`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', ...AUTHENTICATED },
			body: 'query=' + encodeURIComponent('{ __typename }')
		})
		const json = (await res.json()) as { errors?: { message: string }[] }

		expect(res.status).toBe(400)
		expect(json.errors?.[0]?.message).toContain('potential Cross-Site Request Forgery')
	})

	it('serves /health once the bearer gate is satisfied', async () => {
		const res = await fetch(`${base}/health`, { headers: AUTHENTICATED })
		const json = (await res.json()) as { status: string; timestamp: string }

		expect(res.status).toBe(200)
		expect(json.status).toBe('OK')
		expect(new Date(json.timestamp).toISOString()).toBe(json.timestamp)
	})

	// Nothing is mounted after the router, so an unknown path ends in Koa's own 404 — which is the
	// point: it must not be answered by either of the two arms above.
	it('falls through to 404 for an unknown path', async () => {
		const res = await fetch(`${base}/nope`, { headers: AUTHENTICATED })

		expect(res.status).toBe(404)
	})

	// No credential at all: the bearer gate runs before the ENDPOINT/health/else routing decision, so
	// every path answers the same 412 — including /health, which a routing-only test would miss.
	it('rejects a request that carries no bearer credential at all', async () => {
		const res = await fetch(`${base}/health`)
		const json = (await res.json()) as { message?: string }

		expect(res.status).toBe(412)
		expect(json.message).toBe('Precondition Failed')
	})
})

describe('app.proxy', () => {
	it('is off on the constructed Koa app', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, shaped(k))
		vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379')

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
 * the pool goes on holding.
 */
describe('start (missing environment)', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('rejects — with no datasource touched — when a required variable is missing', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, shaped(k))
		vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379')
		vi.stubEnv('REDIS_KEY', '')
		RedisConnect.mockClear()
		disconnectAllDatabases.mockClear()

		await expect(start()).rejects.toThrow('Missing required environment variable: REDIS_KEY')
		expect(RedisConnect).not.toHaveBeenCalled()
		expect(disconnectAllDatabases).not.toHaveBeenCalled()
	})
})
