import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))

const { reportClamSignatureAge } = await import('@lib/clam/reportClamSignatureAge.mjs')

/*
 * RISK_REGISTER R22. Everything here is about the difference between a scanner that answers and a scanner
 * that knows something: `initClamScan()` proves the first, and only the version reply proves the second.
 *
 * `now` is passed explicitly wherever the assertion is about a threshold, so the clock never decides
 * whether a test passes. The one test that lets the default `Date.now()` run says so.
 */

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0)

/** A version reply whose signature database was built `days` before `NOW`. */
const replyBuiltDaysAgo = (days: number): string => `ClamAV 0.103.11/27412/${new Date(NOW - days * DAY).toUTCString()}`

const reader = (getVersion: () => Promise<string>) => ({ getVersion })

beforeEach(() => {
	captureException.mockReset()
	captureMessage.mockReset()
	vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe('a scanner whose signatures are current', () => {
	it('reports fresh, says when they were built, and alerts nobody', async () => {
		const builtAt = new Date(NOW - DAY)

		const report = await reportClamSignatureAge(
			reader(async () => replyBuiltDaysAgo(1)),
			{ now: NOW }
		)

		expect(report).toStrictEqual({
			state: 'fresh',
			alerted: false,
			detail: `signatures built ${builtAt.toISOString()}`
		})
		expect(captureMessage).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
		expect(console.warn).not.toHaveBeenCalled()
	})

	/*
	 * The default threshold is seven days, and this pair is what pins it. ClamAV publishes several times a
	 * day, so a week of silence is already well past a missed update — and a shorter default would alert
	 * on an ordinary weekend of a mirror being slow.
	 */
	it('holds the seven-day default: fresh at exactly seven days, stale one millisecond later', async () => {
		const sevenDays = await reportClamSignatureAge(
			reader(async () => replyBuiltDaysAgo(7)),
			{ now: NOW }
		)
		const aMomentPast = await reportClamSignatureAge(
			reader(async () => replyBuiltDaysAgo(7)),
			{ now: NOW + 1 }
		)

		expect(sevenDays.state).toBe('fresh')
		expect(aMomentPast.state).toBe('stale')
	})

	it('reads the clock itself when no `now` is given', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(NOW))

		const report = await reportClamSignatureAge(reader(async () => replyBuiltDaysAgo(1)))

		expect(report.state).toBe('fresh')
	})
})

describe('a scanner whose signatures have stopped updating', () => {
	it('reports stale, names the age and the limit, and raises both alerts', async () => {
		const report = await reportClamSignatureAge(
			reader(async () => replyBuiltDaysAgo(30)),
			{ now: NOW }
		)

		expect(report).toStrictEqual({
			state: 'stale',
			alerted: true,
			detail: 'virus signatures are 30 days old, past the 7 day limit'
		})
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(
			'[clamav] virus signatures are 30 days old, past the 7 day limit',
			'warning'
		)
		expect(console.warn).toHaveBeenCalledExactlyOnceWith('[clamav] virus signatures are 30 days old, past the 7 day limit')
	})

	it('states the limit it was actually given, not the default one', async () => {
		const report = await reportClamSignatureAge(
			reader(async () => replyBuiltDaysAgo(30)),
			{ now: NOW, maxAgeMs: 2 * DAY }
		)

		expect(report.detail).toBe('virus signatures are 30 days old, past the 2 day limit')
	})
})

describe('a scanner that answers something this cannot read', () => {
	it('quotes the reply back, so the alert is actionable', async () => {
		const report = await reportClamSignatureAge(
			reader(async () => 'ERROR: unknown command'),
			{ now: NOW }
		)

		expect(report).toStrictEqual({
			state: 'unreadable',
			alerted: true,
			detail: 'clamd answered a version string this cannot read: ERROR: unknown command'
		})
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(
			'[clamav] clamd answered a version string this cannot read: ERROR: unknown command',
			'warning'
		)
	})
})

describe('a scanner that is connected but will not answer', () => {
	it('reports the failure to Sentry and to the console, and carries on', async () => {
		const boom = new Error('socket hang up')

		const report = await reportClamSignatureAge(
			reader(async () => Promise.reject(boom)),
			{ now: NOW }
		)

		expect(report).toStrictEqual({
			state: 'unreachable',
			alerted: true,
			detail: 'clamd is connected but did not report its version, so the signature age is unknown'
		})
		expect(captureException).toHaveBeenCalledExactlyOnceWith(boom, {
			extra: { detail: 'clamd is connected but did not report its version, so the signature age is unknown' }
		})
		expect(captureMessage).not.toHaveBeenCalled()
		// ⚠️ The text, not the call count. Sentry needs a DSN to carry this anywhere, so on a machine
		// without one the console line is the only trace a hung scanner leaves — an empty warn is a
		// silent boot, and only asserting what it says can tell the two apart.
		expect(console.warn).toHaveBeenCalledExactlyOnceWith(
			'[clamav] clamd is connected but did not report its version, so the signature age is unknown'
		)
	})

	/*
	 * ⚠️ The reason the deadline exists. `initClamScan()` has already proved the socket opens, so a hung
	 * daemon is not a connection error — it is a promise that never settles, and awaiting it at boot would
	 * hold the service before `listen()` with nothing in the logs to say why.
	 */
	it('gives up after the deadline and names it', async () => {
		vi.useFakeTimers()

		const pending = reportClamSignatureAge(
			reader(() => new Promise<string>(() => undefined)),
			{ now: NOW, timeoutMs: 250 }
		)

		await vi.advanceTimersByTimeAsync(250)

		expect((await pending).state).toBe('unreachable')
		expect(captureException).toHaveBeenCalledExactlyOnceWith(
			new Error('clamd did not answer VERSION within 250ms'),
			expect.anything()
		)
	})

	// A timer left armed after the race is won keeps the event loop alive for its whole duration, which at
	// the five-second default is five seconds of a boot that had already finished.
	it('disarms the deadline once the version arrives', async () => {
		vi.useFakeTimers()

		await reportClamSignatureAge(
			reader(async () => replyBuiltDaysAgo(1)),
			{ now: NOW }
		)

		expect(vi.getTimerCount()).toBe(0)
	})
})
