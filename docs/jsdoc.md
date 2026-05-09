# JSDoc

> Sources: [JSDoc Reference](https://jsdoc.app/) · [TypeScript JSDoc](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)

## Rules

- Comment every exported function, type alias, interface, and module-level constant.
- Document WHY, not WHAT — TypeScript types express what; prose captures intent, invariants, and side effects.
- Single-line `/** */` for self-evident exports; multi-line for anything with parameters, a non-trivial return, or surprising behavior.
- Omit types from `@param` and `@returns` — TypeScript is the source of truth.

## Tags

| Tag           | Use                                                                 |
| ------------- | ------------------------------------------------------------------- |
| `@param name` | Each parameter's purpose (one line each)                            |
| `@returns`    | What the return value represents                                    |
| `@template T` | Generic type parameters; include constraint explanation             |
| `@throws`     | Only for functions that may throw; omit inside TaskEither pipelines |
| `@example`    | Short inline usage snippet                                          |
| `@see`        | Link to a related function or external doc                          |
| `@deprecated` | Mark obsolete items with a migration note                           |
| `@internal`   | Unexported implementation details not part of the public API        |

## Patterns

### Functions

```typescript
/**
 * Normalises raw user input before chunking.
 * Strips HTML, collapses whitespace, and lowercases.
 *
 * @param raw - Untrusted text from the ingestion endpoint
 * @returns Cleaned plain-text string
 */
export function normalise(raw: string): string { ... }
```

Arrow functions assigned to a `const` — same style:

```typescript
/**
 * Wraps an OpenAI embedding call in a TaskEither.
 * Left on network error or quota exhaustion.
 *
 * @param text - Pre-normalised chunk text (max 8 191 tokens)
 * @returns TaskEither that resolves to a 1 536-dimension vector
 */
export const embed = (text: string): TE.TaskEither<AppError, number[]> => TE.tryCatch(...);
```

### Types and Discriminated Unions

Describe the union as a whole in the leading comment. Do not add inline comments inside individual variant members.

```typescript
/**
 * All failure modes the service can surface.
 * Kinds: not_found (404), validation (400), upstream (502).
 * Exhaustive switch via `satisfies never` at every call site.
 */
export type AppError =
  | { kind: 'not_found'; service?: string; cause?: unknown }
  | { kind: 'validation'; service?: string; cause?: unknown }
  | { kind: 'upstream'; service?: string; cause?: unknown };
```

### Zod Schemas

```typescript
/**
 * Request body for POST /memories.
 * `source` must be a valid MIME type string.
 */
export const createMemorySchema = z.object({ ... });
```

### Module-Level Constants

```typescript
/** Maps AppError.kind to its HTTP status code. */
export const statusMap: Record<AppError['kind'], number> = { ... };
```

### Fastify Route Handlers

Document the handler factory, not the inline callback:

```typescript
/**
 * Registers the POST /memories route.
 * Validates body with createMemorySchema, calls ingestService, returns 201.
 *
 * @see {@link ingestService}
 */
export default fp(async (app) => { ... });
```
