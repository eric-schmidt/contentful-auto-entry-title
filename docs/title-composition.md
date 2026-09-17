# Title composition

The title is assembled from an ordered list of **fragments** — small modules
that each contribute one piece of the final string. `joinFragments` concatenates
them with a configurable separator, and `Field.tsx` writes the result to the
field the app is mounted on.

## Configuring the composition

Edit the `composition` export in `src/fragments/index.ts`, then rebuild and
redeploy:

```ts
export const composition: FieldNameComposition = {
  fragments: [staticString('Auto Title')],
  separator: ' - ',
};
```

That file also hardcodes the ids the composition reads: field ids `description`
and `regions`, and taxonomy scheme ids `division` and `brand`. There is no
per-content-type configuration UI — `src/fragments/index.ts` is the one place to
change them.

## The `Fragment` interface

A fragment is any object matching the signature in `src/fragments/types.ts`. It
implements **both** halves of a two-phase contract:

- **`subscribe`** runs in the **editor**. It receives the SDK plus an
  `emit(fragment)` callback, subscribes to whatever it needs, and returns a
  teardown that removes its listeners.
- **`compute`** runs in the **Function**. Same value, derived from a CMA-fetched
  entry rather than from live SDK signals.

The two must agree, or the live editor render drifts from what the server
persists. Where both phases read the same data, funnel them through **one pure
function** and pin them with a parity test — `conceptNotation.spec.ts` has an
`it.each` table asserting `subscribe`'s last emit equals `compute`'s return.

### `""` versus `null` — the data-loss guard

This distinction is load-bearing and is the single most important thing to get
right in a new fragment.

| Emit   | Means                          | Effect                                                                             |
| ------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| `""`   | "I have nothing to contribute" | `joinFragments` filters it out; no dangling separator                              |
| `null` | "I could not find out"         | `joinFragments` returns `null` for the **whole title**, and every write path skips |

A title composed without one of its pieces looks perfectly valid, and both write
paths persist whatever they compose — the editor autosaves, the Function
PATCHes. So emitting `""` on a _failed_ lookup does not degrade the title, it
**deletes real data**: that is exactly how a missing delivery key used to strip
`MRRL` out of every title the editor opened or the Function touched. Warn,
return `null`, leave the stored title alone.

## Mount-time writes are withheld

**The problem this solves.** `Field.tsx` recomputes after every `emit()`.
Synchronous fragments (`contentType`, `fieldValue`) emit immediately; async ones
(`publicationDate`, `conceptNotation`, `referencedEntryTitle`) emit only once
their lookups resolve. Writing on each emit produced visible flicker —
description, then date, then region — and, worse, each intermediate write was a
real autosave of a title missing its later pieces.

**How it works now.** Every slot starts as `null` ("unknown"), not `""`.
`joinFragments` returns `null` if _any_ slot is still unknown, and `recompute`
returns early on `null` without touching the field. So the first write happens
only once every fragment has reported — and usually writes nothing at all,
because the assembled value already matches what the server-side function
persisted.

The same mechanism doubles as the data-loss guard described above: a fragment
that reports `null` because a lookup _failed_ rather than because it is still
pending also withholds the write.

**Why `subscribe` can't just be removed:** the editor needs it to report each
fragment's current value on mount. Without it, the first recompute would
assemble a title from nothing and erase the date, notation, and region on every
entry open.

## Authoring a new fragment

- Implement both `subscribe` and `compute`, and keep their outputs aligned.
- **Every `subscribe` path must emit something**, guard clauses included. A slot
  that never emits withholds the title forever. A _permanent_ "there is nothing
  here" condition — a field id absent from this content type, say — is `""`, not
  silence; only a genuine unknown is `null`. See the missing-field branches in
  `fieldValue.ts` and `referencedEntryTitle.ts`.
- **Don't throw from `subscribe`.** Catch and emit `""` or `null` per the table
  above. `compute` _may_ throw — `composeTitle` catches per-fragment failures and
  substitutes `""` — but that fallback predates the `null` convention, so return
  `null` explicitly when you mean "don't write".
- Return a teardown that cancels in-flight async work, so a fast
  unmount/remount doesn't emit stale data into a torn-down slot.
  `publicationDate` does this with a `cancelled` flag.
- A fragment may read **`metadata`** as well as `fields`. `onValueChanged`
  cannot observe `metadata.concepts` — see
  [Taxonomy notation](./taxonomy-notation.md).
- A fragment needing a capability beyond `FragmentCmaClient` takes it as its own
  **optional context key** rather than widening the CMA type (the
  `conceptReader` precedent). Widening `FragmentCmaClient` would stop `sdk.cma`
  satisfying it.
- Register it by adding it to `composition.fragments`.

Two fragments are worth copying as worked examples, because their values live
entirely outside the entry's own fields:
[`publicationDate`](./publication-date.md) and
[`conceptNotation`](./taxonomy-notation.md).

## `conceptNotation({ schemeIds })`

Emits the concatenated **notations** of the taxonomy concepts assigned to the
entry — an entry tagged `Men's` (notation `M`) and `Double RL` (notation `RRL`)
contributes `MRRL`.

- **`schemeIds` is both the filter and the output order.** Only concepts
  belonging to a listed scheme contribute, and schemes emit in the order given.
  So the output is independent of the order concepts happen to appear in
  `metadata.concepts`, and `["division", "brand"]` always yields `M` before
  `RRL`.
- **Season and Year are deliberately excluded.** The content model tags all four
  schemes, but only Division and Brand belong in the title. Adding them is a
  one-line change to `schemeIds`.
- **The intra-fragment join is `""`, not the composition separator.** All
  notations concatenate into a _single_ emitted string, so `joinFragments` sees
  one slot and `" - "` never lands mid-blob — you get `… - MRRL - …`, never
  `M - RRL`.
- A concept whose notation is empty, or which belongs to no listed scheme,
  contributes nothing.

How the concepts are actually read is the non-obvious part:
[Taxonomy notation](./taxonomy-notation.md).
