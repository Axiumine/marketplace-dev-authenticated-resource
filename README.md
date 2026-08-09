# marketplace-dev-authenticated-resource

Domain GraphQL for the **ShopOwner** tier — what a shop owner does to their own shops and their own
catalogue. Port **4026**, endpoint `/authenticated-resource`.

Token lifecycle is not here: `marketplace-dev-authenticated-authorization` (4029) refreshes the session and
`marketplace-dev-authenticated-logout` (4030) ends it. This service only reads a session that already
exists and serves the domain behind it.

## What it answers

| Mutations | |
|---|---|
| `companyAdd`, `companyUpdate`, `companyDel` | a shop **is** a `company` — there is no separate shop entity and there will not be |
| `itemAdd`, `itemUpdate`, `itemDel` | catalogue entries, domain-neutral by ADR-008 |

| Queries | |
|---|---|
| `shopOwnerCompanies` | the caller's own shops |
| `companyItems` | one shop's catalogue |
| `itemCategories` | read-only here — category writes are Admin-only, in `marketplace-dev-admin-authenticated-resource` |

## Ownership is the whole job

⚠️ **Every mutation here takes an id from the client, so every mutation must prove the caller owns it.**
That is what `throwIfShopOwnerDontOwnCompany` and `throwIfShopOwnerDontOwnItem` are for, and why they are
called before the write rather than folded into it. A session proves *who* you are; it proves nothing about
*which* `company` or `item` rows are yours. Skipping the guard on a new mutation gives any authenticated
shop owner write access to every other shop's data, and no test outside this repo would notice.

`throwIfItemCategoryMissing` is the same shape for a foreign key the caller supplies: `item.idCategory`
must point at a real `itemCategory`, and only this service checks it — the `$jsonSchema` validates the
field's type, not that the referenced document exists.

`makeAuthCtx` builds the per-request context those guards read. Resolvers do not reach into the session
themselves.

## Related files

| Topic | File |
|---|---|
| rules for agents working in this repo | [`CLAUDE.md`](./CLAUDE.md) |
| git hooks, gate order, node selection | [`REPO.md`](./REPO.md) |
| the whole platform — tiers, ports, terminology | parent [`CLAUDE.md`](./CLAUDE.md) |

## License

GPL-3.0-or-later — see [LICENSE](./LICENSE).
