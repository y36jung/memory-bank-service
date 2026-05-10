# TypeScript

> Sources: [TSConfig Reference](https://www.typescriptlang.org/tsconfig/) · [strict](https://www.typescriptlang.org/tsconfig/strict.html) · [noUncheckedIndexedAccess](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html) · [exactOptionalPropertyTypes](https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html) · [fp-ts TaskEither](https://gcanti.github.io/fp-ts/modules/TaskEither.ts.html) · [fp-ts function](https://gcanti.github.io/fp-ts/modules/function.ts.html)

## tsconfig

`strict` enables: `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, and more. Add these on top:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

- `noUncheckedIndexedAccess` — adds `undefined` to array/record lookups; catches out-of-bounds at compile time
- `exactOptionalPropertyTypes` — `{ color?: 'dark' | 'light' }` rejects `undefined` as a value; setting the key to `undefined` is not the same as omitting it

Both are included in `tsc --init` defaults as of TypeScript 5.9.

## Rules

- No `any` — use `unknown` and narrow, or proper generics
- No `!` non-null assertions outside test files
- No `as` casts unless you own both sides
- Prefer `const`; `let` only when reassignment is necessary
- Never mutate function parameters — return new values
- Guard at the source — when a `const` or type requires a null/undefined check before use, export a helper from the same module that owns it; never repeat the guard at call sites

```typescript
// errors.ts — guard lives here, next to the map it wraps
export const statusMap: Record<AppError['kind'], number> = { ... };
export function statusFromKind(kind: AppError['kind'] | undefined): number {
  return kind != null ? statusMap[kind] : 500;
}

// app.ts — call site has no null check
reply.code(statusFromKind(error.kind));
```

## Error Types

Discriminated union — never throw plain strings:

```typescript
type AppError =
  | { kind: 'not_found'; id: string }
  | { kind: 'validation'; message: string }
  | { kind: 'upstream'; service: string; cause: unknown };
```

Exhaustive switch via `satisfies never`:

```typescript
default: err satisfies never; // compile error if a case is missing
```

## fp-ts TaskEither

`tryCatch` signature (official): `(f: LazyArg<Promise<A>>, onRejected: (reason: unknown) => E) => TaskEither<E, A>`

Use at every I/O boundary. Compose with `pipe`. Unwrap once at the edge.

```typescript
import * as TE from 'fp-ts/TaskEither';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

const embed = (text: string): TE.TaskEither<AppError, number[]> =>
  TE.tryCatch(
    () =>
      openai.embeddings
        .create({ model: 'text-embedding-3-small', input: text })
        .then((r) => r.data[0].embedding),
    (cause): AppError => ({ kind: 'upstream', service: 'openai', cause }),
  );

const pipeline = (input: RawInput) =>
  pipe(normalize(input), TE.flatMap(embed), TE.flatMap(writeToQdrant));

// Unwrap once at route handler or worker
const result = await pipeline(input)();
if (E.isLeft(result)) handleError(result.left);
```

Never mix `try/catch` with `TE` inside a pipeline.

## Naming

| Thing            | Style                | Example            |
| ---------------- | -------------------- | ------------------ |
| Types/Interfaces | PascalCase           | `SearchChunk`      |
| Functions        | camelCase            | `resolveEntity`    |
| Files            | kebab-case           | `outbox-worker.ts` |
| Zod schemas      | camelCase + `Schema` | `createTaskSchema` |

## Imports

Path aliases — no `../../../` chains:

```json
{ "paths": { "@db/*": ["src/db/*"], "@services/*": ["src/services/*"] } }
```
