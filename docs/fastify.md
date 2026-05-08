# Fastify + Zod

> Sources: [Plugins](https://fastify.dev/docs/latest/Reference/Plugins/) · [Plugins Guide](https://fastify.dev/docs/latest/Guides/Plugins-Guide/) · [Routes](https://fastify.dev/docs/latest/Reference/Routes/) · [Encapsulation](https://fastify.dev/docs/latest/Reference/Encapsulation/) · [Zod basics](https://zod.dev/basics)

## Plugin Structure

`register` creates an encapsulation scope by default — decorations added inside are invisible to ancestors. Use `fastify-plugin` (`fp`) to share decorations app-wide:

```typescript
import fp from 'fastify-plugin';

// Shared decoration (db, openai client, etc.)
const dbPlugin = fp(async (fastify) => {
  fastify.decorate('db', drizzle(connectionString));
});

// Scoped feature plugin — no fp()
const tasksPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.post('/tasks', { schema: createTaskSchema }, createTaskHandler);
};

// app.ts
fastify.register(dbPlugin);
fastify.register(tasksPlugin, { prefix: '/api/v1' });
```

Fastify loads plugins in declaration order; next plugin loads only after current is ready.

## Schema Validation (Zod)

Use `zod-to-json-schema` to convert Zod schemas for Fastify. Always validate `body`, `params`, `querystring`.

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const createTaskBody = z.object({
  title: z.string().min(1).max(500),
  topicId: z.string().uuid().optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
});

const createTaskSchema = { body: zodToJsonSchema(createTaskBody) };
```

Use `.safeParse()` when you need the error without throwing; use `.parse()` when a ZodError should propagate:

```typescript
const result = createTaskBody.safeParse(req.body);
if (!result.success) return reply.code(400).send(result.error.format());
```

## Route Handlers

Handlers are thin — all logic in service layer:

```typescript
fastify.post('/tasks', { schema: createTaskSchema }, async (req, reply) => {
  const result = await taskService.create(req.user.id, req.body)();
  if (E.isLeft(result)) return sendError(reply, result.left);
  return reply.code(201).send(result.right);
});
```

Always `return reply.send()` — omitting `return` can cause double-send errors after async work.

## Error Handler

One global handler maps `AppError` to HTTP codes:

```typescript
fastify.setErrorHandler((error, _req, reply) => {
  if (error.validation)
    return reply.code(400).send({ error: 'validation', details: error.validation });

  const statusMap: Record<AppError['kind'], number> = {
    not_found: 404,
    validation: 400,
    upstream: 502,
  };
  return reply
    .code(statusMap[(error as AppError).kind] ?? 500)
    .send({ error: (error as AppError).kind });
});
```

Never expose stack traces or internal messages to clients.

## Auth

`preHandler` hook at the plugin level — not per-route:

```typescript
const protectedPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', (req) => req.jwtVerify());
  fastify.register(tasksPlugin);
  fastify.register(documentsPlugin);
};
```

Extend the request type:

```typescript
declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string };
  }
}
```

Always scope DB queries to `req.user.id`. Never trust `user_id` from the request body.

## SSE Streaming

```typescript
reply.raw.setHeader('Content-Type', 'text/event-stream');
reply.raw.setHeader('Cache-Control', 'no-cache');
reply.raw.flushHeaders();

const send = (data: StreamEvent) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
req.raw.on('close', () => controller.abort()); // abort LLM stream on disconnect

for await (const chunk of llmStream) send({ type: 'token', text: chunk });
send({ type: 'sources', chunks: sources });
send({ type: 'done' });
reply.raw.end();
```

## Avoid

- Mutable shared state in route closures — use `fastify.decorate` for singletons
- Logging `req.body` at info level — may contain PII
- Registering the same plugin twice without `fp` — creates duplicate encapsulation
