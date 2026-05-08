# AI / LLM Integration

> Sources: [OpenAI Embeddings](https://platform.openai.com/docs/api-reference/embeddings/create) · [text-embedding-3-small](https://platform.openai.com/docs/models/text-embedding-3-small) · [Anthropic Tool Use Overview](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview) · [Define Tools](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use) · [Messages API](https://docs.anthropic.com/en/api/messages)

## Model Selection

| Use case                                        | Model               | Reason                              |
| ----------------------------------------------- | ------------------- | ----------------------------------- |
| Auto-linking, intent classify, metadata extract | `gpt-4o-mini`       | Cost ~$0.000135/item, fast          |
| Query answer generation                         | `gpt-4o` (SSE)      | User-facing quality                 |
| Pattern extraction (weekly)                     | `gpt-4o`            | Complex reasoning over task history |
| Agent loops (query, recommendation)             | `claude-sonnet-4-6` | Best tool-use accuracy              |

Default to `gpt-4o-mini` for non-user-facing calls. Upgrade only when quality is measurably insufficient.

## Clients

Instantiate once, share via Fastify decoration:

```typescript
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000 });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
fastify.decorate('openai', openai);
fastify.decorate('anthropic', anthropic);
```

## Embeddings

`text-embedding-3-small` — 1536 dims, max 8192 tokens/input, max 300k tokens/request. Always batch:

```typescript
import * as TE from 'fp-ts/TaskEither';

const embedBatch = (texts: string[]): TE.TaskEither<AppError, number[][]> =>
  TE.tryCatch(
    () =>
      openai.embeddings
        .create({ model: 'text-embedding-3-small', input: texts })
        .then((r) => r.data.map((d) => d.embedding)),
    (cause): AppError => ({ kind: 'upstream', service: 'openai', cause }),
  );
```

Validate `text.trim().length > 0` before embedding — empty strings are rejected by the API.

## Structured Output (Metadata Extraction)

Chain LLM call and parse step in one `pipe` — both are fallible:

```typescript
import { pipe } from 'fp-ts/function';
import * as E from 'fp-ts/Either';

const extractMetadata = (query: string): TE.TaskEither<AppError, QueryMetadata> =>
  pipe(
    TE.tryCatch(
      () =>
        openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: buildMetadataPrompt(query) }],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'query_metadata',
              schema: zodToJsonSchema(queryMetadataSchema),
              strict: true,
            },
          },
        }),
      (cause): AppError => ({ kind: 'upstream', service: 'openai', cause }),
    ),
    TE.flatMap((res) =>
      TE.fromEither(
        E.tryCatch(
          () => queryMetadataSchema.parse(JSON.parse(res.choices[0].message.content!)),
          (cause): AppError => ({ kind: 'validation', message: String(cause) }),
        ),
      ),
    ),
  );
```

## Tool Definitions (Anthropic)

Each tool needs: `name`, `description` (what it does and _when_ to call it), `input_schema` (JSON Schema):

```typescript
const resolveEntityTool = {
  name: 'resolve_entity',
  description:
    'Resolve a topic name mention to its UUID. Call before filtering search results by topic.',
  input_schema: {
    type: 'object',
    properties: {
      mention: { type: 'string', description: 'Topic name as mentioned in the query' },
    },
    required: ['mention'],
  },
};
```

## Agent Loop (Anthropic)

Claude responds `stop_reason: "tool_use"` → execute tools → return `tool_result`. Repeat until `"end_turn"`. Wrap the loop in `TE.tryCatch`; use `TE.sequenceArray` for parallel tool execution:

```typescript
import { sequenceT } from 'fp-ts/Apply';

const executeTools = (blocks: ToolUseBlock[]): TE.TaskEither<AppError, ToolResult[]> =>
  pipe(
    blocks.map((b) =>
      pipe(
        callTool(b.name, b.input),
        TE.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: JSON.stringify(result),
        })),
      ),
    ),
    TE.sequenceArray,
    TE.map((results) => [...results]),
  );

const runAgent = (userQuery: string): TE.TaskEither<AppError, string> =>
  TE.tryCatch(
    async () => {
      const messages: MessageParam[] = [{ role: 'user', content: userQuery }];
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          tools: [resolveEntityTool, searchMemoryTool],
          messages,
        });
        if (response.stop_reason === 'end_turn') return extractText(response.content);
        const toolBlocks = response.content.filter((b) => b.type === 'tool_use') as ToolUseBlock[];
        const toolResults = await executeTools(toolBlocks)().then((r) => {
          if (E.isLeft(r)) throw r.left;
          return r.right;
        });
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });
      }
      throw new Error('agent exceeded max iterations');
    },
    (cause): AppError => ({ kind: 'upstream', service: 'anthropic', cause }),
  );
```

## Error Handling

Wrap all LLM calls in `TE.tryCatch` (see `typescript.md`). Retry on 429 and 5xx with exponential backoff. Do not retry on 400 or 401.

## Cost Control

- Hash-check content before re-embedding (ingestion pipeline already does this — preserve it)
- Batch embedding calls — never embed one chunk per API call in a loop
- Keep prompts in `src/prompts/*.ts` as named exports — no inline prompt strings in services
- Pattern extraction: one `gpt-4o` call per user per week — enforce with `notification_log` equivalent

## Avoid

- Sending raw user input to the LLM without validation
- Streaming to internal callers — stream only to the client SSE endpoint
- `Promise.all` for parallel `TE` operations — use `TE.sequenceArray` or `sequenceT(TE.ApplyPar)`
- Agent loops without a hard `MAX_ITERATIONS` cap
