/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'vitest',
	vitest: {
		configFile: 'vitest.mutation.config.mts'
	},
	coverageAnalysis: 'perTest',
	// ignoreStatic was here, on the theory that mutants in module-load code (schema
	// declaration thunks, top-level constants) can never be killed once the module sits in
	// the ESM registry. That theory was wrong — it was an attribution artifact, not an
	// unkillable-mutant problem. When the module under test is imported at the top of a
	// test file (or via a top-level `await import(...)`), a mutant that changes module-load
	// behaviour fires during Vitest's file-collection phase, before any test body runs;
	// Stryker cannot attribute the resulting failure to a test, so it reports the mutant as
	// Survived even though the suite plainly noticed (the whole file fails to collect). The fix
	// is to import the module under test inside `beforeEach` (or inline inside `it`) instead of
	// at module top level or inside `beforeAll` — a throw in `beforeAll` only marks the suite's
	// tests "skipped", which Stryker still can't attribute as a kill; a throw in `beforeEach`
	// marks the one test about to run "failed", which it does attribute. See
	// @axiumine/marketplace-common, which went from 45.95 to 100.00 with this flag
	// absent and the same fix applied. Static mutants are back in scope; none are excluded.
	reporters: ['clear-text', 'progress', 'html'],
	/**
	 * 28 workers on a 32-thread box. The `4` this replaces was never measured anywhere — the same literal
	 * sat in all nine Stryker configs on the platform, frontend included, where dropping it
	 * cut 59 minutes to 18.
	 *
	 * Measured here, 803 mutants, machine otherwise idle:
	 *
	 *   concurrency 4  → 99s
	 *   concurrency 28 → 45s
	 *
	 * ⚠️ "It still scored 100" is **not** what justified this, and must not justify the next change. A
	 * starved worker misses a deadline, its test fails, and Stryker records the mutant as *killed* —
	 * overload inflates the score, so 100 at any concurrency is consistent with a gate that has quietly
	 * stopped checking. At the break threshold there is no headroom for the number to show it.
	 *
	 * What was compared instead is the set of non-killed mutants, where load surfaces first: both runs
	 * ended on the same zero non-killed mutants — no survivor, no timeout, nothing to compare away.
	 * Re-measure that way before touching this.
	 */
	concurrency: 28,
	timeoutMS: 60000,
	// Mutation score is a push gate — see COVERAGE.md. `break` fails the run (exit 1)
	// below this score, which is what the pre-push hook keys off. Raise it as tests
	// improve; never lower it to make a run pass.
	thresholds: { high: 100, low: 95, break: 100 },
	/**
	 * Scan and coverage output, copied into the sandbox for no reason. Stryker's always-ignored list
	 * covers only `node_modules`, `.git`, `/reports`, `*.tsbuildinfo`, `/stryker.log` and `.stryker-tmp`
	 * — `ignorePatterns` itself defaults to empty, and `.qodana/` here runs to tens of megabytes.
	 *
	 * It is not only wasted copying. `disableTypeChecks: true` resolves to the glob
	 * `**\/*.{js,ts,jsx,tsx,html,vue,mjs,mts,cts,cjs}` matched with `dot: true`, so it descends into
	 * dotted directories, and every run logged a `ParseError` trying to strip `@ts-` directives out of
	 * Qodana's own `thirdPartySoftwareList.html`. Stryker swallows that error and carries on, so the
	 * gate stayed green while printing a stack trace nobody could act on.
	 *
	 * Neither directory is an input to any test: both are gitignored build output.
	 */
	ignorePatterns: ['.qodana', 'coverage'],
	mutate: [
		'src/**/*.mts'

		// ⚠️ index.mts is mutated in full, and that is a deliberate change of policy. It used to be
		// excluded wholesale and re-included as two hand-written LINE RANGES, because createServer()'s
		// body — the bearer gate, the upload and bodyparser wiring, all three routing arms — was
		// reachable only from test/integration/index.itest.mts, a project Stryker never runs (see the
		// header of vitest.mutation.config.mts). It is not any more: test/index.unit.test.mts now boots
		// the assembled server on an ephemeral port and drives ENDPOINT, /health, an unknown path and an
		// uncredentialed request over a real socket, with Redis mocked at the one seam the gate reads. The
		// unit project alone covers every statement, branch and function of this file.
		//
		// The ranges had meanwhile rotted exactly as their own warning said they would — ADR-029's
		// `await setupFieldEncryption()` is named in that warning, and the same thing happened again: the
		// file grew and nobody re-derived the boundaries, so spans drifted in and out of scope while the
		// score stayed at 100 and said nothing. A line range is only ever as good as the last person who
		// remembered to move it; a span that really is unreachable from the unit project should fail the
		// run as NoCoverage, not disappear from it.
		//
		// The one genuinely unreachable span — the `if (process.env.NODE_ENV !== 'test')` entrypoint tail
		// — is carved out in the source instead, by a `// Stryker disable all` / `// Stryker restore all`
		// pair around it, where it moves with the code it guards. Same shape, and the same reason, as
		// marketplace-dev-admin-authenticated-resource.

		// instrument.mts is NOT excluded. Static mutants are back in scope (see above), so its
		// only module-load statement (`Sentry.init(...)`) is now a live mutated statement, not
		// one dropped before Stryker can report it. The `insecureHttpsModule.request` function
		// body is invoked directly by test/instrument.test.mts, and its mutants —
		// rejectUnauthorized flipped, the delegate call dropped, the return value swapped — are
		// real and killable alongside it. Verified by running this file through Stryker in
		// isolation (`npx stryker run --mutate "src/instrument.mts"`): 5 mutants instrumented,
		// 5 killed, 0 survived, mutation score 100.00.

		// No exclusion for src/graphQLApi/schema/{types,frag,GraphQLInput}/** or
		// queries.mts/mutations.mts — see the note above on ignoreStatic's removal for why an
		// isolated run showed they need none.
	]
}
