# Test quality policy — 100% coverage **and** 100% mutation score, no exceptions

This service requires **100% test coverage on every metric** — statements, branches,
functions, and lines — **and a 100% Stryker mutation score**. Both are hard gates, not targets.

They answer different questions, which is why both exist:

| Gate | Question it answers |
|---|---|
| coverage | did a test *execute* this line? |
| mutation | would a test *fail* if this line were wrong? |

100% coverage with weak assertions is the normal failure mode, and it is invisible to the
coverage number. Mutation testing is what falsifies it: Stryker rewrites `src/` one small
change at a time (`true` → `false`, a string → `""`, a block → `{}`) and re-runs the suite.
A mutant that *survives* is an edit no test noticed.

## The rule

If coverage is below 100% on any metric, the fix is one of:

1. **Add the missing tests** for the uncovered lines / branches / functions.
2. **Delete the code** if it is unreachable or dead.

If the mutation score is below 100%, the fix is one of:

1. **Strengthen the assertion** that should have caught the mutant.
2. **Delete the code** if the mutant proves the branch is dead.
3. **Document an equivalent mutant** with `// Stryker disable next-line <Mutator>: <why>` —
   only when the mutated code provably cannot behave differently on any reachable input.

**Never** lower a threshold to make a run pass. The thresholds are the specification;
red means the work is not done, not that the number is wrong.

## Where it is enforced

| Layer | File | What it does |
|---|---|---|
| Local test run | `vitest.config.mts` → `test.coverage.thresholds` | `yarn test:cov` exits non-zero if any metric < 100% |
| Local mutation run | `stryker.config.mjs` → `thresholds.break` | `yarn test:mutation` exits non-zero if the score < 100 |
| Qodana scan gate | `qodana.yaml` → `failureConditions.testCoverageThresholds` (`total`/`fresh` = 100) | `./qodana.sh` fails the scan if coverage < 100% |
| Git `pre-commit` | `.githooks/pre-commit` | blocks the commit if `yarn test:cov` **or** the Qodana scan fails |
| Git `pre-push` | `.githooks/pre-push` | blocks the push if `yarn lint:check`, `yarn test:cov`, `yarn test:mutation` **or** the Qodana scan fails |

The coverage layers read the same coverage run (vitest, v8 provider, lcov →
`coverage/lcov.info`, `all: true` over `src/**/*.mts`). Change coverage config in
`vitest.config.mts` only. Qodana has no mutation gate — `pre-push` is the only one.

Both hooks run the scan on purpose. `git merge --no-ff` never fires `pre-commit` —
git runs that hook for `git commit` only — so the merge commit, the one revision
that reaches `origin`, is the single commit no pre-commit scan ever sees. And
Qodana Cloud files each report under the branch it ran on, so a repo scanned only
at commit time never produces a `main`-tagged report to baseline against. Each hook
hands `qodana.sh` `SKIP_TESTS=1`, reusing the `coverage/lcov.info` its own coverage
step just wrote rather than letting the script regenerate it with a test run whose
failure it swallows. `SKIP_QODANA=1` skips the scan alone; the coverage and
mutation gates stay.

## Two projects, one coverage report

`vitest.config.mts` defines two projects; `yarn test:cov` runs both and aggregates coverage:

| Project | Files | Datasources | Purpose |
|---|---|---|---|
| `unit` | `test/*.test.mts` | mocked | pure logic, error paths, prod branches — fast, offline |
| `integration` | `test/integration/*.itest.mts` | **real Redis cluster + real MongoDB + real clamd** | boots the server via `start()` and drives it over HTTP |

This is the **ShopOwner resource tier**: every request goes through
`authorizationAuthenticatedResourceHandler()`, which reads
`Authorization: Bearer access:<token>` and looks the session up in Redis. There is no cookie
and no Keygrip here — the refresh cookie belongs to `marketplace-dev-authenticated-authorization`,
which is also what writes the session this one reads.

`start()` additionally arms the antivirus (`initClamScan()`) before the server is built, so the
integration project needs **clamd listening on `/var/run/clamav/clamd.ctl`** on top of the two
datasources. This service really does accept uploads (`graphql-upload` + `sharp` + `clamscan`),
so a missing clamd is a boot failure by design — an image must never reach disk unscanned — and
the unit project covers that failure path with a mock.

The integration project uses the `REDIS_*` / `MONGODB_URI` values from `.env` (loaded by the
sources' own `dotenv.config()`). It overrides only the keyspace prefix
(`REDIS_KEY=marketplaceDev:itest:authenticatedResource:`, this service's own isolated, ACL-allowed
namespace — the `marketplaceDev:itest:` stem is shared because the ACL grants that pattern, but the
third segment is unique per service so all seven can run their integration suites at once),
`PORT=0` (ephemeral) and `INTROSPECTION_CODE`. Run just one side with `yarn test:unit` /
`yarn test:integration`.

Consequence: the coverage gate — and therefore `pre-push` — needs Redis, MongoDB and clamd
reachable. That is intentional: 100% here means the server was really booted and really talked
to all three, not that a mock returned the expected value.

**The integration suite writes to MongoDB now** — for the one collection left on this tier.
Alongside its own Redis access sessions, it seeds a real `company` document with the raw driver
(checked by the collection's own `$jsonSchema`, not the Mongoose model) and drives
`shopOwnerCompanies`, `companyAdd` and `companyDel` for real over HTTP, dropping every document
it created in `afterAll`. This is new since the old shop and category collections were removed
(2026-08-04): the two collections the suite used to read only (the shop-ownership link table and
the shop-category link table) are gone, `company` is the sole survivor, and a single collection was
small enough a target to seed and mutate for real. The unit project still carries the error
paths (duplicate `vatNumber`, a driver failure, an ownership rejection) that would mean corrupting a
real index or forging a rejection to reach through HTTP; `tryCatchRethrow` is left unmocked
there too, so failures really travel through it.

## A note on the `graphql` realm

`vitest.config.mts` inlines `@axiumine/marketplace-common` and `@axiumine/koa-utils`
alongside `graphql` / `@apollo/server` / `@as-integrations`. The schema embeds GraphQL objects
those two packages build (`GraphQLBaseAddressFrag`, `GraphQLPositionFrag`, `OnlyIdType`), so
they have to see the *same* transformed `graphql` copy as the sources — otherwise graphql
refuses the type with "Cannot use GraphQLObjectType … from another module or realm". The bare
`/graphql/` pattern already covers `graphql-scalars`, `graphql-upload` and `graphql-depth-limit`.

The same split is why error assertions match on `.message` rather than `instanceof GraphQLError`.

## Enabling the hook

The `pre-push` hook lives in `.githooks/` (tracked in git). It is activated by:

```bash
git config core.hooksPath .githooks
```

The `prepare` script in `package.json` runs this automatically on `yarn install`, so a
fresh clone is gated after the first install. To verify:

```bash
git config --get core.hooksPath   # -> .githooks
```

## Server boot and Sentry init are covered — do not exclude them

`src/index.mts` (Koa/Apollo wiring, upload middleware, routing, shutdown) and
`src/instrument.mts` (Sentry init) reach 100% through the **integration** project, which boots
the real server and hits `/authenticated-resource`, `/health` and an unknown path over HTTP.
They are **not** `v8 ignore`d and must stay that way — the only `v8 ignore` block is the
entrypoint tail of `index.mts` (the `if (NODE_ENV !== 'test')` bootstrap that registers signal
handlers and calls `start()`), which cannot run under the test process without killing the
worker via `process.exit`. Every function it wires (`start`, `gracefulShutdown`,
`onUnhandledRejection`, `onUncaughtException`) is exercised directly by tests, so the ignored
block contains only the wiring, no logic.

## Mutation testing — what is mutated, and what is not

`yarn test:mutation` runs Stryker (`stryker.config.mjs`) with the **vitest** runner over
`vitest.mutation.config.mts`. One deliberate scope decision remains, plus one that turned out to
be a mistake and was reverted:

| Setting | Why |
|---|---|
| runs the **`unit` project only** | Stryker re-runs the suite once per mutant. Pointing that at `test/integration/index.itest.mts` would hammer the real Redis cluster, the real dev MongoDB and clamd hundreds of times per mutant run — this service's own isolated `marketplaceDev:itest:authenticatedResource:` namespace doesn't change that, since `fileParallelism: false` still serialises everything within it. Unit tests are Redis/Mongo/clamd-mocked, so mutant runs stay hermetic and parallel. |
| `!src/index.mts` with two ranges added back, `src/index.mts:1-112` and `src/index.mts:184-227` | Unlike a file only reachable through the integration project, most of `index.mts` **is** unit-tested directly (`test/index.unit.test.mts` drives `checkRequiredEnv`, `buildValidationRules`, `healthResponse`, `logListening`, `gracefulShutdown`, `onUnhandledRejection`, `onUncaughtException` and all three of `start()`'s failure paths plus its success path with every datasource mocked), so only two ranges stay out of scope: lines 113-183 (`createServer()`'s body — none of the unit tests reach it, since every mocked failure path rejects before `start()` calls it; only the integration project reaches it, by booting the real server) and lines 228-246 (the `if (NODE_ENV !== 'test')` entrypoint tail, already `/* v8 ignore */`d in the source because it cannot run under the test process without killing the worker via `process.exit`). |

**`ignoreStatic` was removed, not kept.** It used to sit here on the theory that mutants in
module-load code (the `fields: () => ({...})` thunks of the GraphQL type/frag/input declarations,
`queries.mts`/`mutations.mts`) are permanently unkillable — that importing the schema once at a
test file's top level exercises every thunk before Stryker's active mutant is even switched in, so
there is nothing left for a later `it()` to catch. That reasoning was half right and half wrong.
Dropping the flag and re-running honestly surfaced real survivors — not because those mutants were
unkillable, but because of an **attribution artifact**: several mutants (blanking a `name:` field
on a `GraphQLObjectType` / `GraphQLInputObjectType`) make graphql-js throw *synchronously at
construction*, and a throw during a top-level `await import(...)` (or inside `beforeAll`) makes
Vitest mark every test in the file **"skipped"**, not "failed" — Stryker cannot attribute a skip to
any one test, so it reports Survived even though the whole file plainly broke. Moving the same
imports into `beforeEach` instead fixes this: the throw now fails only the one test about to run,
which Stryker *does* attribute as a kill. The remaining survivors were plain description-string
literals that nothing had ever asserted the exact text of. Fixing both closed every survivor with
**no new exclusions and no weakened assertions**.

`src/instrument.mts` was never excluded, static or otherwise: `Sentry.init(...)` is its only
module-load statement, and `insecureHttpsModule.request`'s function body is invoked directly by
`test/instrument.test.mts`, so its mutants (`rejectUnauthorized` flipped, the delegate call
dropped, the return value swapped) were always real and killable.

No `// Stryker disable` directive exists anywhere in `src/` — every mutant Stryker raised,
including every static one, was killable with a strong-enough assertion, not an equivalence
argument.

⚠️ **The domain-specific product collections and the delivery-cost collection, plus the resolvers,
GraphQL types and unit/integration tests that served only them, were removed from this service in one
piece of work** (see *What the port deleted or fixed* below, and the parent workspace `CLAUDE.md`
for the product decision). The mutant and coverage figures that used to be pinned in this file were
tied to that code and are stale now that it is gone — the numbers above describe the shape of the
gates, not a snapshot to compare against. Re-run `yarn test:cov` and `yarn test:mutation` for the
current baseline; do not restore the old counts.

⚠️ **The old shop and category collections went the same way, in a second cut on the same day.**
This was the service hit hardest of the seven: of 4 queries and 6 mutations only the 3 `company`
mutations and `shopOwnerCompanies` survived. Gone with the two collections: the shop-category link
table, the shop-ownership link table, the shop add/delete/disable mutations, the shop GraphQL
types, the four shop-only inputs (contacts, openingHours, address, a product-options type) and
every test that exercised any of them. `test/schema.test.mts` now asserts their absence by name
rather than staying silent about it. Same consequence as the first cut: the coverage and mutation
figures below predate this removal too — re-run rather than trust the numbers.

### Writing tests that kill

`test/index.unit.test.mts` is the clearest surviving example of the general pattern: `expect(errorLog).toHaveBeenCalledWith('error', error)`
asserts the literal first argument to `console.error`, not just that it was called — a weaker
`toHaveBeenCalled()` would have let a mutant blank the `'error'` literal survive unnoticed. The
same discipline applies to the GraphQL type assertions in `test/schema.test.mts`: asserting a
field's rendered type string (e.g. `String(fields.someField.type)`) catches a mutant that wipes a
field's `type` to `undefined`, which a bare `Object.keys(fields)` name-list check would miss.

## What the port deleted or fixed

Reaching 100% (before the catalog was removed) surfaced code that could not be covered because it
could not run, and — through the integration project — one bug that broke the whole shop-owner
read path. Recorded here so the changes are not mistaken for gratuitous edits. The old shop and
category collections are gone now too (see above), so every entry below is history: kept because
it explains a decision, a pattern, or a defect, not because the code it names is still on disk.

- **`sanitizeFilter` vs `$exists` — the real one.** `MongoDBConnect` (koa-utils) sets
  `mongoose.set('sanitizeFilter', true)` **globally**, so a bare `$`-operator object inside a
  filter is stripped and read as a literal value. The shop-ownership link table's two files
  (both since deleted with the shop collection itself) both passed
  `{ deleted: { $exists: false } }` unwrapped, and the first integration query answered:

  ```
  Cast to date failed for value "{ '$exists': false }" (type Object) at path "deleted" for model "Shop"
  ```

  Fixed by wrapping in mongoose's `trusted({ $exists: false })` in both files, which is what the
  admin resource service already did. The pattern outlives the two files it was found in:
  `shopOwnerCompanies` filters the same way and its unit assertion compares against
  `trusted(...)` too, so a regression on the survivor still fails the suite.
- The shop-update mutation file — **deleted**, twice over: first as an
  empty file with no export and no importer, then for good along with the rest of the shop collection.
- `authorizationAuthenticatedResourceHandler` — the `x-introspectioncode` bypass dereferenced a
  missing `Authorization` header (`authorization!.startsWith(...)`) and threw a `TypeError`,
  so it could never succeed and the `if (!introspection)` guard below it was unreachable.
  Guarded with `!introspection &&`, matching the sibling services. The dead
  `accessToken !== ''` check and an unused `operationName` block went with it.
- **Un-awaited `Model.create()`** across the `*Add` mutations — `return Model.create(doc)`
  inside a `try` means the promise escapes before the `catch` can see it, so a write failure
  surfaced as an unhandled rejection instead of a GraphQL error. All now `return await`.

Two items used to sit here as **documented but deliberately left alone** — the shop-disabled
function's `disable`/`disabled` key mismatch (a data-migration decision, not a test-porting one) and
the shop-category link table's harmless GraphQL type mismatch. Both are moot
now: the functions, the collections and the mismatch all went together in the shop-and-category
removal above. Nothing replaces the entries — there is no equivalent decision pending
on `company`.

## Running it

```bash
yarn test:cov       # coverage + threshold check (the source of truth)
yarn test:mutation  # Stryker; report at reports/mutation/mutation.html
./qodana.sh         # full Qodana Ultimate scan, incl. the 100% coverage gate
```

`git push` runs the first two, in that order, and blocks on either.
