# REST API Design Guide

## What is REST?

REST (Representational State Transfer) is an architectural style for designing
networked applications. It was defined by Roy Fielding in his 2000 doctoral
dissertation at the University of California, Irvine. REST is not a protocol,
a standard, or a specification — it is a set of architectural constraints that,
when applied collectively, enable scalable, stateless, and loosely coupled
distributed systems.

The name "Representational State Transfer" is descriptive: clients transfer
representations of the state of resources between themselves and the server.
A resource is any named concept — a user, an order, a document, a sensor
reading. A representation is a snapshot of that resource's state encoded in a
format the client can understand, typically JSON or XML.

RESTful APIs are the dominant style for web and mobile APIs today because they
map cleanly onto HTTP and are easy to consume from any programming language or
platform. However, REST is technology-agnostic — the same constraints could be
applied over other protocols, even though HTTP is the overwhelmingly common choice.

Understanding REST requires understanding its constraints individually and as a
system. Each constraint contributes to the overall properties of visibility,
reliability, scalability, simplicity, modifiability, and portability that
characterise well-designed REST systems.

---

## The Six Architectural Constraints

Fielding identified six constraints. A system that satisfies all six is considered
RESTful. Violating any constraint degrades one or more of the system's desirable
properties.

### 1. Client-Server

The first constraint separates the user interface from data storage and business
logic. The client is responsible for the presentation layer — rendering content,
managing user interaction, and handling navigation. The server is responsible for
data persistence, business rule enforcement, and resource management.

This separation of concerns provides several benefits. The client can evolve
independently of the server: a web frontend, a mobile application, and a
command-line tool can all consume the same server API without requiring server
changes. Conversely, the server can be replaced or refactored without breaking
clients, provided the interface contract is maintained.

The client-server constraint also enables the server to be stateless (see the
next constraint) because the server does not need to track per-client presentation
state. Each client manages its own UI state locally, offloading that concern
entirely.

In practice, the client-server separation means that a RESTful API must not
include server-side rendering, session-managed navigation flows, or other
server-driven UI concerns. The server exposes resources; the client decides how
to display them.

### 2. Statelessness

Each request from a client to a server must contain all the information needed
to understand and process the request. The server must not store any client
session state between requests. All session state, if required, is kept entirely
on the client and transmitted with each request.

This constraint is often the most architecturally significant. By eliminating
server-side session state, the server becomes much easier to scale horizontally:
any server instance can handle any request from any client without needing to
coordinate session data with other instances. Load balancers can route requests
to any available instance without sticky sessions.

Visibility improves because each request is self-describing. A monitoring tool
or intermediary can understand the full meaning of a request without needing
context from previous requests. This simplifies debugging, auditing, and replay.

Reliability also improves: recovering from partial failures is straightforward
because the client simply re-sends the complete request to any available server.
There is no partially-completed server-side session state to reconcile.

The trade-off is that repetitive data must be sent with every request. If a
client identifies itself with a bearer token, that token appears in every
request rather than being established once during a login handshake. Network
bandwidth increases modestly, but the scalability and simplicity gains far
outweigh this cost in most systems.

**Stateless vs. connectionless:** The term "stateless" is sometimes confused with
"connectionless." These are distinct concepts. HTTP/1.1 supports persistent
connections (keep-alive), meaning a single TCP connection can be reused for
multiple requests. HTTP/2 and HTTP/3 go further with multiplexed streams over
a single connection. From a network perspective, these protocols are connection-
oriented. However, at the REST application layer, each request is fully
independent — the server behaves as though it has no memory of previous requests
from the same client. A long-lived connection is merely a transport optimisation;
it does not change the stateless character of the REST interaction.

### 3. Cacheability

Responses from the server must define themselves as cacheable or non-cacheable.
If a response is marked cacheable, a client or intermediary cache may reuse that
response for equivalent subsequent requests within the cache's validity period,
without contacting the server.

Caching reduces client-perceived latency, reduces server load, and reduces
network traffic. When implemented correctly, it is one of the most impactful
performance optimisations available in a REST system.

HTTP provides a rich vocabulary for cache control. The `Cache-Control` response
header governs caching behaviour: `max-age=3600` permits caching for one hour,
`no-store` prevents caching entirely, and `no-cache` allows caching but requires
revalidation before use.

Conditional requests enable efficient cache revalidation. The server includes an
`ETag` (entity tag) header containing a version identifier for the resource. On
subsequent requests, the client sends `If-None-Match: <etag>`. If the resource
has not changed, the server responds with `304 Not Modified` and an empty body,
saving bandwidth. The `Last-Modified` / `If-Modified-Since` pair serves the same
purpose using timestamps.

The `Vary` header informs caches that a response may differ based on request
headers. `Vary: Accept-Encoding` tells caches to store separate versions for
compressed and uncompressed responses. `Vary: Accept-Language` separates cached
responses by content language.

Designers must take care to mark responses appropriately. A response that should
not be cached (e.g., real-time stock prices, authenticated user-specific data
without a suitable key) must set `Cache-Control: no-store` or risk stale data
being served to clients.

### 4. Uniform Interface

The uniform interface constraint decouples the architecture, allowing each part
to evolve independently. It is the central feature that distinguishes REST from
other network-based architectural styles. The constraint is defined by four
sub-constraints.

**Resource identification in requests:** Resources are identified by URIs.
The server may use any internal representation (a database row, an in-memory
object, a file) but exposes resources through stable, addressable URIs.
`/users/42` identifies a user resource; the internal database structure is
irrelevant to the client. The URI is the contract.

**Resource manipulation through representations:** When a client holds a
representation of a resource — including metadata such as `Content-Type` and
`ETag` — it has enough information to modify or delete that resource, provided
it has permission. The client does not need out-of-band knowledge of the
server's internals. A `PUT` request sends the complete replacement representation;
a `PATCH` request sends a partial modification; a `DELETE` request removes the
resource. All are performed through the representation.

**Self-descriptive messages:** Each message includes enough information to describe
how to process it. The `Content-Type` header specifies the media type of the
body (`application/json`, `text/html`, `application/xml`). The `Accept` header
expresses the client's preferred response type. Method semantics (GET, POST, PUT)
define what action to take. A well-formed HTTP request is fully self-contained.

**Hypermedia as the engine of application state (HATEOAS):** Clients interact
with a REST service entirely through hypermedia provided dynamically by the server.
The server embeds links in responses that guide the client to valid next actions,
rather than the client being hardcoded with knowledge of all possible URLs. A
payment resource might include a `pay` link when payment is pending, a `refund`
link when payment is complete, and no links when the payment is in a terminal
failed state. The client follows the links; it does not predict them.

HATEOAS is the most commonly omitted constraint in APIs that describe themselves
as "REST." Its full implementation requires careful media type design and is
more often seen in APIs built with HAL, JSON:API, or Siren than in ad hoc JSON
APIs. However, even partial implementation improves discoverability and reduces
client-server coupling.

### 5. Layered System

A client interacting with a REST API cannot ordinarily tell whether it is
connected directly to the origin server or to one of several intermediary layers.
Intermediaries such as reverse proxies, load balancers, API gateways, CDN edge
nodes, caching proxies, and security appliances may sit between the client and
the server without the client's knowledge.

Each layer in a layered system sees only the adjacent layers. The client sees the
first intermediary as though it were the server. The origin server sees the last
intermediary as though it were the client. This transparency is what makes the
layered system constraint valuable: operators can insert, replace, or remove
intermediaries without changing client or server code.

Practical implications are significant. A CDN can cache static API responses at
edge nodes globally, reducing latency for geographically distributed clients. An
API gateway can enforce authentication, rate limiting, and request transformation
for all services behind it without each service implementing these concerns
independently. A load balancer can distribute requests across a pool of server
instances without clients needing to know the pool exists.

Security is also enhanced: a Web Application Firewall (WAF) positioned as an
intermediary can inspect and filter traffic before it reaches the application.
The server never exposes its internal address to the public network.

The constraint does impose a limitation: per-request latency may increase if
many intermediary hops add processing overhead. In practice, modern network
infrastructure makes this overhead negligible for most use cases.

### 6. Code on Demand (Optional)

The only optional constraint in REST allows servers to extend client functionality
by transferring executable code. The server sends code that the client downloads
and executes locally, temporarily expanding its capabilities.

The classic example is JavaScript delivered to a web browser. The server sends
not just data but logic that the client executes to render a dynamic UI, validate
form input, or perform computations locally. Applets and WebAssembly modules are
other examples.

Code on demand is optional because it reduces visibility (intermediaries cannot
inspect executable code as easily as data) and creates a coupling between client
execution environment and server-provided logic. Most REST APIs — particularly
those consumed by mobile apps or backend services — do not implement this
constraint, and that is entirely valid within Fielding's framework.

---

## Resource Naming Conventions

Well-designed resource names are one of the most visible aspects of an API's
quality. They form the public contract between server and client and are costly
to change once published.

**Use nouns, not verbs.** HTTP methods express actions; URIs should identify
things, not operations. `/users` not `/getUsers`. `/orders/99/cancel` violates
this principle; prefer `POST /orders/99/cancellations` where a cancellation is
itself a resource.

**Use plural nouns for collections.** `/users` returns a list; `/users/42`
returns a specific user. This consistency makes URIs predictable. Some teams
use singular nouns for singletons (the authenticated user: `/me`, the server
status: `/health`), which is acceptable.

**Use lowercase and hyphens, not underscores or camelCase.**
`/product-categories` is more readable than `/product_categories` or
`/productCategories`. Hyphens are visible in hyperlinks (underscores are
hidden by underline rendering); lowercase avoids case-sensitivity bugs.

**Express hierarchy with path segments.** A comment on a post:
`/posts/15/comments/88`. Do not exceed three levels of nesting — deeper
hierarchies become difficult to reason about. If a resource makes sense
independently (comments can exist without knowing their parent post),
consider a top-level `/comments` collection filtered by query parameter.

**Use query parameters for filtering, sorting, and pagination.**
`/products?category=electronics&sort=price_asc&page=2&per_page=20`
Query parameters are appropriate for non-hierarchical variations of a
collection. They should not be used for resource identity — that belongs
in path segments.

**Version the API in the URI or via headers.** `/api/v1/users` (URI versioning)
is the most common approach because it is visible in browser address bars,
logs, and curl commands. Header versioning (`Accept: application/vnd.api+json;version=2`)
is cleaner architecturally but less discoverable. Pick one strategy and apply
it consistently across the entire API surface.

**Avoid leaking implementation details.** `/api/v1/mysql_users_table` exposes
the storage technology. `/api/v1/users` does not. Implementation details can
change; URIs should not.

**Keep URIs stable.** Once published, a URI is a commitment. If a resource
must be moved, respond with `301 Moved Permanently` pointing to the new URI.
Deleting published URIs without redirects breaks clients.

---

## HTTP Status Codes

HTTP status codes communicate the outcome of a request. Clients use status codes
to determine whether a request succeeded, failed due to a client error, or failed
due to a server error, without needing to parse the response body.

### 2xx — Success

`200 OK` — the request succeeded. For `GET`, the body contains the requested
resource. For `PUT` or `PATCH`, the body typically contains the updated resource.

`201 Created` — the request succeeded and a new resource was created. The
`Location` header should point to the new resource's URI. Returned by successful
`POST` requests that create resources.

`202 Accepted` — the request has been accepted for asynchronous processing but
not yet completed. The body or headers should explain how the client can check
status (e.g., a job URI).

`204 No Content` — the request succeeded but there is no body to return.
Appropriate for `DELETE` and for `PUT`/`PATCH` when the server chooses not to
echo the updated resource.

### 3xx — Redirection

`301 Moved Permanently` — the resource has been permanently moved to a new URI
given in the `Location` header. Clients should update their bookmarks and send
future requests to the new URI.

`302 Found` — temporary redirect. The resource is temporarily at the URI in
`Location`. Clients should not update bookmarks.

`304 Not Modified` — the client's cached version is current. Returned in response
to a conditional request when the resource has not changed since the client's
last copy. The body is empty.

### 4xx — Client Error

`400 Bad Request` — the request is malformed, has invalid syntax, or violates
validation rules. The body should describe what is wrong.

`401 Unauthorized` — authentication is required and was not provided or failed.
Despite the name, this status indicates unauthenticated (not unauthorised) access.
The `WWW-Authenticate` header specifies the required authentication scheme.

`403 Forbidden` — the client is authenticated but lacks permission to access the
resource. The server understood the request and intentionally refuses it.

`404 Not Found` — the resource does not exist at the given URI. Also used to
hide the existence of resources that the client is not permitted to know about.

`405 Method Not Allowed` — the HTTP method is not supported for this resource.
The `Allow` header lists the permitted methods.

`409 Conflict` — the request conflicts with the current state of the resource.
Common in concurrent modification scenarios (e.g., updating a resource based on
a stale version).

`422 Unprocessable Entity` — the request is syntactically valid but semantically
incorrect (e.g., a field value fails domain validation). Widely used for API
input validation errors.

`429 Too Many Requests` — the client has exceeded the rate limit. The
`Retry-After` header specifies how many seconds to wait before retrying.

### 5xx — Server Error

`500 Internal Server Error` — an unexpected condition prevented the server from
fulfilling the request. The client should not retry without modification unless
the server indicates the error is transient.

`502 Bad Gateway` — an upstream server returned an invalid response.

`503 Service Unavailable` — the server is temporarily unable to handle requests
(overloaded or in maintenance). The `Retry-After` header should estimate when
the server will be available.

`504 Gateway Timeout` — an upstream server did not respond in time.

Using status codes correctly is critical. Returning `200 OK` with an error object
in the body (`{"error": "not found"}`) forces clients to parse the body to detect
failure, defeating the purpose of status codes. Use the appropriate 4xx or 5xx
code and include error details in the body as supplementary information.

---

## Request and Response Formats

### Content Negotiation

HTTP supports content negotiation, allowing clients and servers to agree on
response format. The client sends an `Accept` header listing its preferred
media types with quality factors: `Accept: application/json;q=1.0, application/xml;q=0.8`.
The server selects the best match from its supported types and sets the
`Content-Type` of the response accordingly.

Similarly, the `Content-Type` header on a request body tells the server how
to parse the body: `Content-Type: application/json` for JSON,
`Content-Type: multipart/form-data` for file uploads.

### JSON

JSON (JavaScript Object Notation) is the de facto standard format for REST APIs.
It is human-readable, widely supported, and efficiently parseable. All keys
should be `camelCase` (matching JavaScript conventions) or `snake_case`
(common in Python-originated APIs). Pick one and apply it consistently.

Dates should be ISO 8601 strings: `"2024-03-15T10:30:00Z"`. Avoid Unix
timestamps in JSON bodies — they are not human-readable and make debugging
harder. Monetary values should be represented as integers in the smallest
denomination (cents, not dollars) to avoid floating-point precision issues.

### Response Envelope

Many APIs wrap all responses in a consistent envelope:

```json
{
  "data": { ... },
  "error": null,
  "meta": { "page": 1, "total": 247 }
}
```

Envelopes provide a consistent structure for clients to parse and make it easy
to add metadata (pagination, warnings) without breaking existing clients.
The trade-off is verbosity. APIs targeting machine consumers often omit envelopes
for collection endpoints and return the array directly.

### API Versioning in Response Format

When introducing breaking changes (removing a field, changing a field's type,
restructuring a response), create a new API version rather than modifying the
existing one. Document deprecated fields with a `deprecated` annotation in the
API schema and provide a migration guide before removal.

---

## Authentication and Authorisation

### Bearer Tokens

The most common authentication mechanism for REST APIs is the Bearer token,
sent in the `Authorization` header: `Authorization: Bearer <token>`. Bearer
tokens are opaque strings that the server validates on each request. They may
be session tokens (looked up in a database), JWTs (self-contained, validated
with a secret or public key), or API keys.

### JSON Web Tokens (JWT)

A JWT is a self-contained token encoding claims as a JSON object, signed with
HMAC-SHA256 or RSA. The server can validate a JWT without a database lookup by
verifying the signature. The token's payload includes an expiry (`exp` claim),
the subject (`sub`), and any application-specific claims (roles, permissions).

JWTs eliminate session storage on the server, enabling stateless authentication
consistent with the REST statelessness constraint. However, revoking a JWT
before its expiry is difficult — the common mitigations are short expiry times
(15 minutes) combined with refresh tokens, or a revocation list checked on
critical operations.

### OAuth 2.0

OAuth 2.0 is an authorisation framework for delegated access. It allows a user
to grant a third-party application access to their resources on a server without
sharing their credentials. The four main flows (grants) are: authorisation code
(for web apps), client credentials (for service-to-service), implicit (deprecated),
and device code (for input-constrained devices).

The authorisation code flow produces an access token (short-lived, sent with
every request) and a refresh token (long-lived, exchanged for new access tokens
when the current one expires). Access tokens should have a short lifetime (minutes
to an hour); refresh tokens can be valid for days or months.

### API Keys

API keys are long random strings issued to developers for programmatic access.
They are simple to implement and audit but have limitations: they do not expire
by default, they cannot be scoped per-user, and they are difficult to rotate at
scale. Best suited for server-to-server integration where the security model is
simpler.

---

## API Versioning Strategies

Versioning is inevitable: APIs evolve, and clients cannot always update
simultaneously. The three dominant strategies are URI versioning, header
versioning, and content negotiation.

**URI versioning** embeds the version in the path: `/api/v1/users`. It is the
most widely adopted strategy because it is explicit, visible in browser dev tools
and logs, easy to route at the infrastructure level, and supports multiple
versions running simultaneously behind different upstreams. The trade-off is
that URIs are no longer "pure" resource identifiers — the version is a routing
concern, not a resource attribute.

**Header versioning** uses a custom request header: `X-API-Version: 2` or an
`Accept` header with a vendor media type: `Accept: application/vnd.myapp.v2+json`.
This keeps URIs clean and is preferred by strict REST purists who argue that
the resource identifier should be stable across versions. The trade-off is
reduced discoverability — version headers are invisible in browser navigation
and harder to test with simple tools like curl.

**Query parameter versioning** appends the version to the query string:
`/api/users?version=2`. It is the most convenient for quick testing but is
generally discouraged for production APIs because query parameters are often
cached without version awareness and are easy to omit accidentally.

Whatever strategy is chosen, version increments should be reserved for breaking
changes. Additive changes — new optional fields, new endpoints — should not
require a version bump.

---

## Rate Limiting

Rate limiting protects API servers from overload, prevents abuse, and ensures
fair resource allocation across clients. Without rate limiting, a single misbehaving
client can degrade service for all others.

### Common Rate Limiting Algorithms

**Fixed window:** Count requests per client per time window (e.g., 1,000 requests
per hour). Simple to implement but susceptible to burst attacks at window boundaries:
a client can make 1,000 requests in the last second of one window and 1,000 more
in the first second of the next.

**Sliding window:** Count requests in the last N seconds rather than in fixed
clock-aligned windows. Smooths out burst behaviour at boundaries. More expensive
to compute, typically requiring a time-series store like Redis.

**Token bucket:** Each client has a bucket that fills at a fixed rate (tokens
per second). Each request consumes one token. Requests are rejected when the
bucket is empty. Bursts are allowed up to the bucket's capacity. This is the
most flexible algorithm for accommodating occasional spikes.

**Leaky bucket:** Requests queue at a fixed output rate regardless of input rate.
Provides smooth output but queued requests experience latency during bursts.

### Rate Limit Headers

Clients must be informed of their rate limit status. The conventional headers are:

- `X-RateLimit-Limit`: the total request quota for the window
- `X-RateLimit-Remaining`: requests remaining in the current window
- `X-RateLimit-Reset`: Unix timestamp when the window resets (or `Retry-After` seconds)

When the limit is exceeded, respond with `429 Too Many Requests` and a
`Retry-After` header specifying how many seconds to wait.

### Client-Side Backoff

Clients that receive a `429` should implement exponential backoff with jitter:
wait an initial period, double it on each retry, add random jitter to prevent
thundering herds when many clients hit the limit simultaneously. A client that
retries immediately without backoff will continue to contribute to the overload
condition it triggered.

---

## Pagination

APIs returning collections should always paginate. Returning unbounded result sets
wastes bandwidth, strains servers, and can cause client memory issues. Any
collection endpoint that could return more than a few dozen items should support
pagination from day one.

### Offset-Based Pagination

The simplest form: `GET /users?page=3&per_page=20`. The server calculates the
SQL offset as `(page - 1) * per_page`. The response includes metadata:
total count, current page, total pages, and optionally `next` and `prev` links.

Offset pagination has a well-known problem: if records are inserted or deleted
while a client is paginating, items may be skipped or duplicated. It also becomes
slow on large datasets because the database must scan and discard `offset` rows
before returning results.

### Cursor-Based Pagination

The server returns an opaque cursor (typically an encoded ID or timestamp) with
each page. The client sends the cursor to retrieve the next page:
`GET /users?after=cursor_abc123&limit=20`. The server translates the cursor to
a `WHERE id > cursor_id` condition, which is index-friendly and consistent even
when new records are inserted.

Cursor pagination is strongly preferred for high-volume, real-time datasets
(social media feeds, event logs, audit trails). Its limitation is that clients
cannot jump to arbitrary pages — navigation is strictly sequential.

### Link Headers

The `Link` response header communicates pagination navigation links per
RFC 5988: `Link: </users?page=4>; rel="next", </users?page=1>; rel="prev"`.
This is the standard way to expose pagination links at the HTTP layer, keeping
the response body clean for APIs that do not use an envelope format.

---

## Error Handling Best Practices

Consistent, informative error responses reduce debugging time and improve
developer experience. Ad hoc error formats (`{"message": "Something went wrong"}`)
are frustrating to work with. Adopt a standard.

### RFC 7807: Problem Details for HTTP APIs

RFC 7807 defines a standard `application/problem+json` media type for error
responses:

```json
{
  "type": "https://api.example.com/errors/validation-failed",
  "title": "Validation Failed",
  "status": 422,
  "detail": "The 'email' field must be a valid email address.",
  "instance": "/api/v1/users",
  "invalid-params": [{ "name": "email", "reason": "must match pattern ^[^@]+@[^@]+$" }]
}
```

The `type` URI identifies the error class (and can link to documentation).
`title` is a human-readable summary. `status` mirrors the HTTP status code.
`detail` provides request-specific context. `instance` identifies the specific
occurrence. Extensions (like `invalid-params`) provide structured error detail
for programmatic handling by clients.

### Validation Errors

Return `422 Unprocessable Entity` with a list of field-level errors so clients
can highlight specific form fields. Do not return only the first error — validate
all fields and report all failures at once to avoid multiple round-trips.

### Do Not Leak Internal Details

Error messages must not include stack traces, SQL queries, internal service names,
or file paths. These constitute information disclosure vulnerabilities. Log the
full details server-side; send only a safe, human-readable message to the client
along with a correlation ID that operators can use to find the server-side log entry.

---

## Caching in Depth

HTTP caching is the single highest-leverage performance optimisation for REST APIs.
A response served from cache costs no server compute, no database query, and
near-zero network latency for clients near a cache node.

### ETag and Conditional GET

The `ETag` header carries a version token for a resource — a hash of its content
or an opaque version string. The server includes it in responses:
`ETag: "a3f5c8d"`. On subsequent requests, the client sends
`If-None-Match: "a3f5c8d"`. If the resource is unchanged, the server returns
`304 Not Modified` with no body. The client uses its cached copy. If the resource
has changed, the server returns `200 OK` with the new content and a new ETag.

### Last-Modified and If-Modified-Since

An alternative to ETag using timestamps: `Last-Modified: Wed, 12 Mar 2025 08:00:00 GMT`.
The client later sends `If-Modified-Since: Wed, 12 Mar 2025 08:00:00 GMT`. This
works well for resources whose modification time is naturally tracked but is less
precise than ETags (timestamps have one-second resolution; ETags can detect
sub-second changes and concurrent modifications).

### Cache-Control Directives

- `public`: the response may be cached by any cache, including shared caches (CDNs).
- `private`: the response is specific to a single user and must not be stored in shared caches.
- `max-age=N`: the response is fresh for N seconds.
- `s-maxage=N`: overrides `max-age` for shared caches only; useful when CDN TTL should differ from browser TTL.
- `no-cache`: the cached copy must be revalidated with the origin before use.
- `no-store`: the response must not be cached at all (for sensitive data).
- `stale-while-revalidate=N`: the cache may serve a stale response for N seconds while revalidating in the background, eliminating revalidation latency for the end user.
- `must-revalidate`: once stale, the cached response must not be used without successful revalidation.

### Vary Header

The `Vary` header tells shared caches that the response depends on specific
request headers, not just the URL. `Vary: Accept-Encoding` stores separate
cached copies for gzip-compressed and uncompressed responses.
`Vary: Authorization` prevents user-specific responses from being served to
other users by a shared cache. Using `Vary: *` effectively disables shared
caching for that resource.

### Cache Invalidation

Cache invalidation is notoriously difficult. Strategies include:

- Content-addressable URLs (embed a hash in the URL): `/assets/app.a3f5c8d.js` never changes content at a given URL, so `max-age` can be set to one year safely.
- Surrogate keys: tag cached responses with resource identifiers; purge all entries for a resource when it changes (Fastly, Varnish, Cloudflare support this).
- Short TTLs: accept some staleness; tune `max-age` to a tolerable freshness window.

---

## HATEOAS in Practice

Hypermedia as the Engine of Application State (HATEOAS) is the constraint that
elevates a hypermedia API above a plain data API. In a fully HATEOAS-compliant
service, a client starts from a single well-known entry point (the API root) and
discovers all available actions through links embedded in server responses. The
client never constructs URIs by concatenating strings — it follows links.

### Why HATEOAS Matters

Without HATEOAS, clients must be programmed with out-of-band knowledge of the
API's URL structure. This creates tight coupling: when the server changes a URL,
all clients must update. With HATEOAS, the server owns the URL space entirely.
It can rename, restructure, or extend URLs without breaking compliant clients,
because those clients follow links rather than constructing them.

HATEOAS also enables self-documenting APIs: a developer can navigate the entire
API surface by following links from the root, discovering what operations are
available on each resource and what their effect will be.

### Media Type Formats for HATEOAS

**HAL (Hypertext Application Language)** is the most widely adopted format.
Resources include a `_links` property with named link relations:

```json
{
  "id": 42,
  "status": "pending",
  "_links": {
    "self": { "href": "/orders/42" },
    "pay": { "href": "/orders/42/payments" },
    "cancel": { "href": "/orders/42/cancellations" },
    "customer": { "href": "/customers/17" }
  }
}
```

When the order is paid, the server omits the `pay` link and adds a `refund` link.
The client checks for the presence of links rather than computing state from fields.

**JSON:API** is a more opinionated specification that standardises resource
structure, relationships, and error format, in addition to links. It uses a
`links` object at the document and resource levels:

```json
{
  "data": {
    "type": "orders",
    "id": "42",
    "attributes": { "status": "pending" },
    "links": { "self": "/orders/42" },
    "relationships": {
      "customer": { "links": { "related": "/orders/42/customer" } }
    }
  }
}
```

JSON:API is verbose but provides strong conventions around sparse fieldsets,
compound documents (including related resources in a single response), and sorting.

**Siren** extends the concept with "actions" — named operations that specify
the HTTP method, target URL, and expected fields:

```json
{
  "properties": { "status": "pending" },
  "actions": [
    {
      "name": "pay",
      "href": "/orders/42/payments",
      "method": "POST",
      "fields": [{ "name": "amount", "type": "number" }]
    }
  ]
}
```

Actions give clients enough information to build a form without any prior knowledge
of the operation.

### Practical Adoption

Very few public APIs fully implement HATEOAS. The overhead of designing link
relations, choosing a media type, and educating API consumers is substantial.
The benefit is largest in long-lived APIs with many clients that evolve at
different speeds. For internal APIs consumed by a small number of tightly
controlled clients, the pragmatic approach is partial HATEOAS: include obvious
navigation links (`self`, `next`, `prev`, `parent`) without attempting the full
state-machine link model.

---

## Security Best Practices

Security is not an afterthought in API design — it must be addressed at every
layer of the stack. The following practices address the most common vulnerability
classes in REST APIs.

### Input Validation

Never trust client input. Validate every field: type, length, format, range, and
allowed values. Use a schema validation library (e.g., Zod, Joi, JSON Schema) at
the API boundary. Reject requests that fail validation with `422 Unprocessable Entity`
and a structured error listing every violation. Do not attempt to sanitise
malformed input by guessing the client's intent — reject it.

Particularly important: validate content types. A request with
`Content-Type: application/json` but a non-JSON body should be rejected
immediately with `400 Bad Request`. Do not attempt to parse the body as
another format.

### Injection Prevention

SQL injection remains a top vulnerability in data-backed APIs. Always use
parameterised queries or prepared statements — never interpolate client-supplied
values into query strings. An ORM that generates parameterised queries by default
(Drizzle, Prisma, SQLAlchemy) is safer than raw query construction, but even
ORMs can be misused with raw query escape hatches.

For APIs that pass user input to external systems (shell commands, LDAP queries,
XML parsers), apply the same principle: use APIs that accept parameters separately
from the command structure. Shell injection via `exec(\`convert ${userFile}\`)` is
as dangerous as SQL injection.

### Transport Security

All API traffic must use TLS (HTTPS). HTTP-only APIs transmit credentials and
data in plaintext, vulnerable to interception on any network path between client
and server. Configure TLS 1.2 as the minimum version; prefer TLS 1.3. Set HTTP
Strict Transport Security (HSTS) to prevent protocol downgrade attacks:
`Strict-Transport-Security: max-age=31536000; includeSubDomains`.

### Sensitive Data Exposure

Do not return more data than the client needs. If a user profile endpoint is
called by a non-admin client, do not include the user's hashed password, internal
IDs used in other systems, or administrative metadata. Use response schemas to
define exactly what each endpoint returns and strip fields server-side.

Avoid logging sensitive data. Request and response bodies containing authentication
credentials, payment card numbers, or personal health information must not appear
in application logs. Log only what is necessary for debugging (request ID,
method, path, status code, duration).

### CORS

Cross-Origin Resource Sharing (CORS) controls which web origins may call the API
from a browser. Set `Access-Control-Allow-Origin` to a specific allowlist of
trusted origins, not `*`, for any endpoint that handles authenticated requests.
Wildcard origins combined with `Access-Control-Allow-Credentials: true` are
explicitly forbidden by the CORS specification but some older implementations
permit it, creating credential theft vulnerabilities.

Preflight caching reduces overhead: `Access-Control-Max-Age: 86400` allows
browsers to cache CORS preflight results for 24 hours, avoiding an `OPTIONS`
request before every cross-origin call.

### Mass Assignment

Reject fields in request bodies that clients should not control. If a user update
endpoint accepts `{ "name": "Alice" }`, ensure it does not also accept
`{ "name": "Alice", "role": "admin" }`. Explicitly allowlist the fields that
are updateable; reject or silently ignore all others. This prevents mass
assignment attacks where an attacker elevates privileges by including unexpected
fields.

---

## HTTP Methods and Their Semantics

HTTP defines a standard set of methods (sometimes called verbs) with well-specified
semantics. REST APIs must honour these semantics to interoperate correctly with
HTTP infrastructure — caches, proxies, browsers, and HTTP client libraries all
rely on method semantics to behave correctly.

### Safe Methods

A method is **safe** if it does not modify server state. Safe methods may be
invoked freely by automated agents, prefetched by browsers, and retried without
concern for side effects.

`GET` retrieves a resource representation. It must not modify state. A `GET`
request with a body is technically allowed but strongly discouraged — many
intermediaries discard the body, and semantically a `GET` has no payload to process.

`HEAD` behaves identically to `GET` but returns only headers and no body.
Used to check whether a resource exists, retrieve its metadata (size, last
modified), or test a URL without downloading the content. Safe and idempotent.

`OPTIONS` retrieves the set of methods and communication options for a resource.
Used in CORS preflight requests to determine which origins and methods are permitted.

### Idempotent Methods

A method is **idempotent** if applying it multiple times produces the same server
state as applying it once. Idempotency is a safety property for retry logic:
if a network failure occurs after sending a request but before receiving the
response, an idempotent method can be safely retried.

`GET`, `HEAD`, and `OPTIONS` are idempotent (and also safe).

`PUT` replaces the entire resource at the target URI with the request payload.
Sending the same `PUT` twice results in the same state as sending it once.
`PUT` should be used when the client controls the resource's URI (e.g., uploading
a file to a known path). Do not use `PUT` for partial updates — that is `PATCH`.

`DELETE` removes the resource. The first `DELETE` removes it; subsequent `DELETE`
requests against the same URI return `404 Not Found` (the resource is already gone),
but the server state is the same — the resource does not exist. Thus `DELETE` is
idempotent.

### Unsafe Methods

**`POST`, `PUT`, `PATCH`, and `DELETE` are unsafe HTTP methods because they modify
server state.** `POST` and `PATCH` are additionally non-idempotent — sending them
twice may produce different results (two resource creations, two partial updates).

`POST` creates a new resource or triggers an operation. The server assigns the
URI. `POST /orders` creates a new order; each invocation creates a distinct order.
Not idempotent.

`PATCH` applies a partial modification to a resource. The request body contains
a description of the changes, not the full replacement representation. Whether
a given `PATCH` operation is idempotent depends on its semantics: `SET field=value`
is idempotent; `INCREMENT counter` is not.

Clients should not automatically retry unsafe methods after a network failure
without user confirmation. A retry might create duplicate orders, charge a
payment card twice, or send a message multiple times. Where idempotent retries
are required for unsafe operations, implement idempotency keys: the client generates
a unique key per logical operation and sends it with the request. The server
deduplicates based on the key.
