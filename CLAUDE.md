# marketplace-dev-authenticated-resource

Backend svc 4 of 9. ShopOwner tier, resource concern. Port 4026.

**Read parent first** — [`../../../CLAUDE.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/CLAUDE.md)
Tier/concern split, port table, terminology, auth model live there. Not here.

| Need | File |
|---|---|
| what this svc is, its GraphQL surface, its traps | [`README.md`](./README.md) |
| hook internals, gate order, node selection, mutation-gate rationale | [`REPO.md`](./REPO.md) |
| anything cross-repo | parent `CLAUDE.md` |

## ⚠️ NEVER run the mutation gate by hand

`yarn test:mutation` is **hook-only** — `pre-push` calls it, nothing else does, and neither a commit nor
a "quick check on one file" is a reason to run it, nor is `npx stryker run` direct. To reproduce a
survivor, apply the mutant by hand in the source and run `yarn test`, which takes seconds. Why:
[`REPO.md`](./REPO.md).

## Rules

- **Never commit on `main`.** Branch first: `git switch -c <type>/<slug>`. Merge = user decision alone.
- Merged → delete branch: `git branch -d <slug>`. `-d` only. `-D` never.
- **No remote.** Push-on-request: no `git push` unless the user asked for it in that message.
- **Never lower a coverage or mutation threshold, and never remove a gate.** Threshold miss → write the
  missing test. Bypasses (`SKIP_QODANA=1`, `--no-verify`) are gate removals: use only when the user says so.
- Tabs, not spaces. eslint + prettier both enforce.
- English only — identifiers, comments, fixtures. No exception.
- Domain query/mutation → **resource** svc. Token lifecycle → **authorization** svc.

## Gates

commit → secret guard, lint, types, coverage, Qodana. push → same + semgrep (SAST) + trivy (dependency
advisories) + mutation. All blocking. Why: [`REPO.md`](./REPO.md).

## GitNexus

- **MUST run `impact({target, repo})` before editing a symbol** — `repo:` is mandatory, always a
  `marketplace*` registry name.
- **MUST run `detect_changes()` before committing.**
- Full rules and this repo's registry name: [`AGENTS.md`](./AGENTS.md).
