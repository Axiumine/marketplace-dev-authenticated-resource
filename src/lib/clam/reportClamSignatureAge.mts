import { clamSignatureFreshness } from '@axiumine/marketplace-common/others/clamSignatureFreshness'
import * as Sentry from '@sentry/node'

/**
 * Reads how old the virus signatures behind this service's `clamd` are, and says so out loud when the
 * answer is not "current".
 *
 * ⚠️ **`initClamScan()` proves a scanner is reachable, not that it knows anything.** A daemon whose
 * signature database stopped updating six months ago answers `clean` exactly as fast as a current one,
 * and every upload it clears looks identical in the logs — RISK_REGISTER R22. Nothing on this platform
 * runs `freshclam`, so a container that has been up since its image was built is the ordinary case rather
 * than the unlucky one, and until this ran at boot nothing anywhere read the daemon's version reply.
 *
 * ⚠️ **This never throws and never stops the boot.** A stale scanner is worse than a fresh one and far
 * better than none, so the failure is reported and the service keeps starting. Refusing to serve over a
 * version string would turn a degraded scanner into an outage, which is the larger harm.
 */

const DAY_MS = 86_400_000

/** The one thing this needs from the `NodeClam` `initClamScan()` hands back. */
export interface IClamVersionReader {
	getVersion: () => Promise<string>
}

/**
 * What the boot learned, and whether it raised an alert about it.
 *
 * `alerted` exists so a test can prove the Sentry path was taken rather than infer it — the same reason
 * `IScanVirusResult` in koa-utils carries one.
 */
export interface IClamSignatureReport {
	state: 'fresh' | 'stale' | 'unreadable' | 'unreachable'
	alerted: boolean
	detail: string
}

/**
 * `getVersion()` with a deadline.
 *
 * ⚠️ **A connected daemon can still never answer.** `initClamScan()` has already proved the socket opens,
 * so a hung `clamd` fails here as a promise that simply never settles — and `await`ing it at boot would
 * hold the service before `listen()` forever, with no error anywhere to say why. The timer is cleared in
 * `finally` whichever way the race ends: leaving it armed keeps the event loop alive for its whole
 * duration and, in a test run, leaks into the next test.
 */
const answerWithin = async (work: Promise<string>, timeoutMs: number): Promise<string> => {
	let timer: NodeJS.Timeout | undefined

	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`clamd did not answer VERSION within ${timeoutMs}ms`)), timeoutMs)
			})
		])
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Asks the scanner for its version, turns the reply into a freshness verdict and reports anything that is
 * not fresh to Sentry and to the console.
 *
 * `now`, `maxAgeMs` and `timeoutMs` are parameters with defaults rather than module constants, so a test
 * pins the boundary without touching the machine's clock and a caller may tighten either. The default is
 * seven days: ClamAV publishes signature updates several times a day, so a week of silence is already far
 * past a missed update and well short of alerting on an ordinary weekend.
 */
export const reportClamSignatureAge = async (
	clam: IClamVersionReader,
	{ now = Date.now(), maxAgeMs = 7 * DAY_MS, timeoutMs = 5000 }: { now?: number; maxAgeMs?: number; timeoutMs?: number } = {}
): Promise<IClamSignatureReport> => {
	let reply: string

	try {
		reply = await answerWithin(clam.getVersion(), timeoutMs)
	} catch (e) {
		const detail = 'clamd is connected but did not report its version, so the signature age is unknown'

		Sentry.captureException(e, { extra: { detail } })
		console.warn(`[clamav] ${detail}`)

		return { state: 'unreachable', alerted: true, detail }
	}

	const verdict = clamSignatureFreshness(reply, now, maxAgeMs)

	if (verdict.state === 'fresh')
		return { state: 'fresh', alerted: false, detail: `signatures built ${verdict.builtAt.toISOString()}` }

	const detail =
		verdict.state === 'stale'
			? `virus signatures are ${Math.floor(verdict.ageMs / DAY_MS)} days old, past the ${Math.floor(maxAgeMs / DAY_MS)} day limit`
			: `clamd answered a version string this cannot read: ${verdict.reply}`

	Sentry.captureMessage(`[clamav] ${detail}`, 'warning')
	console.warn(`[clamav] ${detail}`)

	return { state: verdict.state, alerted: true, detail }
}
