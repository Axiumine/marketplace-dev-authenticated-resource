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
| `companyUpdatePublished`, `itemUpdatePublished` | the publish switches — see below |

⚠️ **Publishing is a separate operation, not a field of the card.** `published` is deliberately absent
from `GraphQLInputCompany` and `GraphQLInputItem`: `companyUpdate` and `itemUpdate` `$set` the whole
object, so a flag inside the input would make every save a write of the flag — and an owner who reopened
a form loaded before an operator unpublished something would put it straight back without asking to.
`companyAdd` and `itemAdd` stamp `false`; the two `*UpdatePublished` mutations are the only writers of
the flag on this tier, matching the operator tier's `itemUpdatePublished` on 4024.

A company also has to be nameable before it can be published: the collection's `$expr` refuses
`published: true` without both `slug` and `publicName`, so the save comes first and the publish second.

| Queries | |
|---|---|
| `shopOwnerCompanies` | the caller's own shops |
| `companyItems` | one shop's catalogue |
| `itemCategories` | read-only here — category writes are Admin-only, in `marketplace-dev-admin-authenticated-resource` |

## The item picture

⚠️ **`itemAdd` is the only mutation on this platform that takes a file, and the only writer of
`item.image`.** The `Upload` sits inside `GraphQLInputItem` rather than beside it, so adding an item and
giving it a picture are one call: `graphqlUploadKoa` (mounted in `src/index.mts`) turns the multipart
part into a promise of a stream, and `storeItemImage` hands it to koa-utils' `uploadTempImage` —
extension and MIME check, ClamAV scan, then a re-encode to webp. That re-encode is the security step:
the file that reaches the static domain is one this process built from decoded pixels, so a payload
smuggled inside a valid image does not survive it.

⚠️ **The size cap is 5 MB and it is not configurable from here.** It is `storeUploadAsTemp`'s default
inside koa-utils, which `uploadTempImage` never overrides; `graphqlUploadKoa`'s 30 MB sits above it and
never binds, and `MAX_IMAGE_MB` in the `env` template is read by nothing in this service or in that
library. A larger picture fails inside `uploadTempImage`, which collapses every cause to
`Error storing image`, so the client is told 500 rather than "too big".

Three steps, **straddling the insert**, and the order is the design: store the upload in the temp
directory → `Item.create` → `moveFileStaticDomain` into `STATIC_FOLDER/item/<idCompany>/`. Nothing
becomes publicly reachable before the document exists, so the ordinary failure — a slug already taken in
the shop, 409 — leaves the file in the temp directory where no URL points. The mirror case is not
repaired: a move that fails after a successful insert answers 500 with the item already created. See
`itemAdd.mts`.

`item.image` holds **a file name and nothing else** — `<_id>.webp`, no path and no URL, because the two
segments that locate it are already on the document. `moveFileStaticDomain` is handed the same name
*without* its extension: `moveTempFile` under it re-appends the temp file's own, so passing the stored
name lands the bytes as `<_id>.webp.webp` while the document says otherwise. `IStoredItemImage` carries
both forms for that reason and neither call site builds the other's.

⚠️ **`itemUpdate` shares the same input and must never write the field.** `IItemUpdate` omits it and
`funItemUpdate` drops the key at the `$set` as well, because what arrives over the wire is not what the
type says: GraphQL will hand an `Upload` to the save without complaint, and `$set` would write a promise
into a path the validator declares a string. There is no replace-a-picture path yet, deliberately.

`STATIC_FOLDER` is required at boot for this reason. Unset it does not fail — the destination directory
becomes the literal `undefined/item/...` under the working directory, the move succeeds, and the only
symptom is one broken picture.

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
