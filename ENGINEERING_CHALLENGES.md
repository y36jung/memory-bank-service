# 🧗 Engineering Challenges

This page covers the hardest problems I solved while building Memory Bank. For each one, I explain what went wrong, what I did about it, and the tradeoffs I accepted.

Problems are listed in date order. Each date is the day the fix was saved.

Memory Bank is a personal knowledge base with low traffic and a public demo. Many of the tradeoffs below make sense because of that: being trustworthy and cheap to run matters more than handling heavy traffic or answering every kind of question.

## Contents

1. [Questions about files, not what is in them](#1-questions-about-files-not-what-is-in-them)
2. [The browser blocked the live chat stream](#2-the-browser-blocked-the-live-chat-stream)
3. [The chat assistant made up answers](#3-the-chat-assistant-made-up-answers)
4. [Demo logins failed across websites](#4-demo-logins-failed-across-websites)
5. [The hosting bill was too high](#5-the-hosting-bill-was-too-high)
6. ["Who are you?" and off-topic questions](#6-who-are-you-and-off-topic-questions)

**Current challenges**

7. [Slow evals because of the Cohere rate limit](#7-slow-evals-because-of-the-cohere-rate-limit)
8. [Short, vague questions find nothing](#8-short-vague-questions-find-nothing)

**If the app scales**

9. [Put API requests behind a Backend for Frontend (BFF)](#9-put-api-requests-behind-a-backend-for-frontend-bff)

---

## 1. Questions about files, not what is in them

**Date:** 19 June 2026
**Category:** RAG pipeline (retrieval)

### Problem

Questions like "What did I upload last week?" failed. Vector search compares the meaning of the question with the meaning of each chunk of text. It ignores metadata such as file names, upload dates and source types.

### What I did

- I built **hybrid search**. A GPT-4o-mini **tool call** classifies the **query intent** and pulls out **metadata filters**: name keywords, date ranges, source type and media time ranges.
- The app runs those filters as a **SQL query** on **Postgres**. It then **fuses** those results with the **Qdrant** vector results.
- If the classifier fails, the app falls back to plain vector search.
- Later, I ran the classifier and the **HyDE** step in **parallel** to cut **latency**.

### Tradeoffs

- **Each query makes one more LLM call, which adds cost and latency.** This is acceptable because Memory Bank is a personal app with low traffic. Running the calls in parallel also hides most of the extra wait.
- **The classifier can misread a question.** This is acceptable because a failure falls back to plain vector search. In the worst case, the result is no worse than before.
- **Only a fixed set of filter fields is supported.** This is acceptable because names, dates and source types cover most questions people ask about their own files. A fixed set also keeps the SQL safe and easy to test.

---

## 2. The browser blocked the live chat stream

**Dates:** 27 June 2026 (fix), 9 July 2026 (security fix)
**Category:** API and security

### Problem

The app streams chat answers with **Server-Sent Events (SSE)**. The browser blocked the stream because of the **CORS** rules. The `@fastify/cors` plugin adds the `Access-Control-Allow-Origin` header in the `onSend` **hook**. That hook runs after the route handler, but the SSE route has already sent its headers by then.

### What I did

- I set the CORS header myself on the **raw response** before the stream starts, and added `Vary: Origin`.
- Later I found that this fix **reflected any origin**, which is a security hole. I moved the **allow-list** into one shared config, so the app sends the header only for **exact-match** approved origins.
- I added **integration tests** for this.

### Tradeoffs

- **CORS is now handled in two places: the plugin and the SSE route.** If the two disagree, bugs can appear. This is acceptable because both read the same **single source of truth**, and tests check that they match.
- **The exact-match allow-list does not accept wildcards.** Every new frontend address must be added to the config by hand. This is acceptable because the app has only one frontend, and a strict list is much safer than trusting any origin.

---

## 3. The chat assistant made up answers

**Date:** 17 July 2026
**Category:** RAG pipeline (generation and grounding)

### Problem

The assistant sometimes **hallucinated**, meaning it gave answers that were not in the user's documents. There were two causes:

- The **cosine similarity threshold** was too high, so relevant chunks were missed. This is a **semantic gap**.
- Wrong answers stayed in the **chat history** and were fed back to the model as **context**.

### What I did

- I lowered the threshold and added **threshold backoff** (0.2 → 0.1 → 0.05). The app runs one query at the lowest threshold and applies each step **in process**, so there are no extra **round trips**.
- When the search finds nothing, the app skips the **LLM** call and sends a fixed reply that the app itself wrote. This makes an **ungrounded completion** impossible.
- When matches are weak, an `uncertain` flag is set in the SSE payload, and the **system prompt** tells the model to hedge and ask the user to clarify.
- I **filtered the history**, leaving out past answers that cited no sources. The system prompt also tells the model to trust freshly retrieved documents over the history.

### Tradeoffs

- **A lower threshold lets weaker, noisier chunks into the search results.** This is acceptable because the lower threshold only widens the **candidate pool**. A **cross-encoder reranker** then scores each candidate against the user's original question (not the HyDE text) and keeps only the top results. Most low-signal chunks are cut before they reach the model. If the best remaining match is still weak, the `uncertain` flag and the hedging prompt tell the user. Missing a real answer is worse than showing a weak match with a warning.
- **The fixed "no relevant documents" reply is less natural than a reply the model writes.** This is acceptable because a "second brain" is only useful if people can trust it. **Precision** matters more than sounding friendly.
- **Filtering the history can drop a correct answer that cited no sources.** This is acceptable because losing a little context costs far less than repeating a hallucination as if it were fact.

---

## 4. Demo logins failed across websites

**Date:** 2 August 2026
**Category:** Authentication and security

### Problem

The frontend (on Vercel) and the backend are on different **origins**. Because of the **SameSite** rules, browsers did not send the refresh token cookie or the demo device cookie on **cross-site requests**. As a result, demo sessions broke.

### What I did

- I moved the demo device ID from a cookie into a **custom request header** (`x-demo-device-id`). I also added it to CORS `exposedHeaders` so the frontend can read it.
- I set the refresh token cookie to `SameSite=None; Secure` in the demo environment.
- That change opens the door to **CSRF** (cross-site request forgery). To block it, I added an **Origin check** on the refresh and logout routes. The check rejects requests whose `Origin` header is present but not on the allow-list.

### Tradeoffs

- **`SameSite=None` removes the browser's built-in CSRF protection.** This is acceptable because the Origin check replaces it on the routes that use the cookie. The setting also applies only to the `beta` environment.
- **The Origin check fails open when the `Origin` header is missing.** This is acceptable because browsers always send `Origin` on cross-site POST requests, so a real attack would still be caught. Failing open keeps non-browser clients and older same-origin requests working.
- **A client can change the device ID header.** This is acceptable because the ID only keeps demo chat histories apart. It is not a **security boundary**, and real access is still controlled by the **access token**.

### Another option: a BFF

A **Backend for Frontend (BFF)** would avoid this problem entirely. The browser would talk only to its own origin, so no cookies would be cross-site, and `SameSite=None` and the Origin check would not be needed. I chose the fixes above because a BFF adds a network hop and another service to run, which is too much for a low-risk demo. I plan to add one if the app scales. See [Challenge 9](#9-put-api-requests-behind-a-backend-for-frontend-bff).

---

## 5. The hosting bill was too high

**Date:** 28 August 2026
**Category:** Hosting services and cost

### Problem

An **ingestion supervisor** checked the database every 10 minutes using `setInterval`. That traffic kept the **serverless Postgres** database (**Neon**) from **scaling to zero**. These checks used more **compute hours** than the real user traffic did.

### What I did

- I turned off the supervisor in the `beta` environment with an **environment flag** (`NODE_ENV`). This is safe for now because demo users cannot upload documents. In beta, only I can create accounts that are allowed to upload, so new uploads are rare. The supervisor is only a backup that re-queues **stuck jobs**, and the **BullMQ worker** still processes every upload.
- I made **graceful shutdown** work whether or not the supervisor is running.

### Tradeoffs

- **In beta, stuck ingestion jobs are no longer retried automatically.** This is acceptable because demo accounts use documents that are already loaded, so there are few new uploads. If a job does get stuck, the **reingest script** can fix it by hand.
- **The first request after a quiet period has a cold-start delay** while Neon wakes up. This is acceptable for a demo with low traffic, where saving money matters more than a fast first response.
- **Beta and other environments now behave differently.** This is acceptable because the change sits behind a single flag, and other environments keep the supervisor.

---

## 6. "Who are you?" and off-topic questions

**Date:** 27 September 2026
**Category:** RAG pipeline (query classification and retrieval)

### Problem

The app could not tell an off-topic question from a weak match. This is because **HyDE** (Hypothetical Document Embeddings) embeds a sample answer instead of the question itself. A sample answer is general prose, and general prose is somewhat similar to almost any chunk. So the cosine score of an off-topic query still cleared the threshold.

### What I did

- I added a three-way **intent classifier**: `app_identity`, `list_documents` and `search_content`.
- I used the **reranker's relevance score** (**Cohere**, a **cross-encoder**) to spot off-topic queries. The app has two thresholds: one for **irrelevance** and one for **low confidence**.
- I added **unit tests** for each path.

### Regression on the same day

The fix caused a new bug. If a user asked "What is this?" in the middle of a chat, the app described itself instead of the topic being discussed.

I fixed it so the fixed app description is used only for the **first message in a session**. Later in a session, the model looks at the **conversation context** and does one of three things: it asks which meaning the user wants, describes the app, or says it has nothing more to add.

### Tradeoffs

- **The app has no general-knowledge path, so it refuses math and general questions.** This is acceptable because Memory Bank exists to answer questions from the user's own documents. It is not meant to be a general chatbot, and staying in scope keeps every answer **grounded**.
- **The two thresholds (0.05 and 0.3) are starting values, not yet tuned on real data.** They may sometimes reject a valid question. This is acceptable because a wrong refusal is safer than a confident wrong answer, and the values are easy to change later. We will investigate further if necessary to find a value/approach optimal for the app's use case.
- **Identity questions in the middle of a session still need an LLM call.** This is acceptable because the call stops the app from reciting its description in answer to a question that meant something else.

---

# 🚧 Current Challenges

These are problems I am working on now. Each one has a temporary workaround or none yet.

## 7. Slow evals because of the Cohere rate limit

**Date:** 27 September 2026 (workaround added)
**Category:** Testing and evaluation (RAG evals)

### Problem

I measure RAG quality with a **promptfoo** eval suite. Each test case sends one request to the **Cohere Rerank API** (`rerank-v3.5`). My development key is a **free trial key**, which allows only **10 calls per minute**.

promptfoo runs 4 test cases at once by default, so it hit the limit almost right away. The API then returned **HTTP 429** (Too Many Requests) errors. The reranker retries with **exponential backoff** (1 s, 2 s, then 4 s), but the retries soon ran out. At first, this crashed the whole server. I fixed the crash in the chat pipeline's error handling, but the test cases still failed.

### Current workaround

- I set `maxConcurrency: 1` and `delay: 7000` in the promptfoo config. The suite now runs one test case at a time, with a 7-second gap between them. This keeps it at about 8.5 calls per minute, safely under the limit.

### Tradeoffs

- **The eval suite is now very slow.** Each test case takes at least 7 seconds plus the time the pipeline itself takes, and nothing runs in parallel. I accept this for now because reliable results matter more than speed, and the trial key costs nothing. But slow evals mean I run them less often, which makes it harder to catch **regressions** early.

### Ideas I'm exploring

- **Cache rerank results.** I could store each Cohere response, keyed by a **hash** of the query and the chunk IDs. Re-running unchanged test cases would then skip Cohere completely.
- **Use a token-bucket rate limiter instead of a fixed delay.** The limiter would throttle only the rerank calls. Other steps, like **HyDE** and the LLM calls, could then run in parallel, so less time is wasted waiting.
- **Use a mock reranker for test cases that don't test reranking.** An environment flag would turn it on. I would run the full suite with Cohere less often, for example before a release.
- **Run only the affected test files.** promptfoo can filter test cases, so a small change would not need the full suite.
- **Use a paid Cohere key for evals.** It has a much higher rate limit but costs money for each call.

---

## 8. Short, vague questions find nothing

**Date:** Ongoing (the "no relevant documents" reply for these questions comes from the irrelevance check added on 27 September 2026)
**Category:** RAG pipeline (retrieval)

### Problem

Short questions with no exact word match still fail. For example, "X00 status code" gets the fixed "no relevant documents" reply. But my API design document has a section on HTTP status codes that lists 200, 400 and 500. A person would see right away that "X00" means those codes. The app does not.

### Likely causes (still being confirmed)

- "X00" does not appear anywhere in the document, so there is no **lexical match**.
- **HyDE** writes a sample answer from a very short question. The sample may guess a different meaning, which pulls the **embedding** away from the right chunk.
- The **reranker** scores the raw question against each chunk. A short, vague question gets a low **relevance score**, which falls below the **irrelevance threshold** (0.05). The app then treats the result as zero chunks and sends the fixed reply.

### The tension

- The irrelevance threshold from [Challenge 6](#6-who-are-you-and-off-topic-questions) stops the app from answering off-topic questions. But it also rejects vague questions that are actually valid. If I lower the threshold, the off-topic problem comes back. Any fix must improve recall for vague questions without hurting **precision** for off-topic ones.

### Ideas I'm exploring

- **Query rewriting and expansion.** Before searching, a GPT-4o-mini call would rewrite a short question into several clear versions, such as "HTTP 200 status code", "HTTP 400 status code" and "HTTP 500 status code". The app would search with each version (**multi-query retrieval**) and merge the results, for example with **reciprocal rank fusion (RRF)**.
- **Add keyword search to hybrid search.** **BM25** or **Postgres full-text search** would match exact terms like "status code", even when the meaning-based score is low.
- **Ask a clarifying question instead of giving up.** When a question is very short and its scores fall in a grey zone, the app could ask what the user means instead of sending "no relevant documents".
- **Measure it.** I would add short, vague questions to the promptfoo `semantic_gap` test set and tune the thresholds on real relevance score data.

---

# 📈 If the App Scales

These changes are not needed today, but I would make them if the app grows.

## 9. Put API requests behind a Backend for Frontend (BFF)

**Category:** Authentication and security
**Priority:** Low

### How tokens work today

- The frontend (Next.js on Vercel) calls the backend **directly from the browser**, across origins.
- The **access token** is a **JWT** that lasts 15 minutes. The backend returns it in the JSON response body. The frontend keeps it **only in JavaScript memory**, not in `localStorage`, and sends it in an `Authorization: Bearer` header.
- The **refresh token** is an `httpOnly` cookie that lasts 30 days. In beta it is set to `SameSite=None; Secure` so the browser sends it across sites. The token is **rotated** on each use. If an old token is reused, the whole **token family** is cancelled (**reuse detection**).

### Why a BFF would help

- **The browser still holds the access token.** If an **XSS** attack ever succeeded, it could read the token from memory and call the API for up to 15 minutes. With a BFF, Next.js server routes act as a **proxy**. The tokens stay on the server, and the browser gets only a same-origin `httpOnly` session cookie.
- **The backend has to accept cross-site requests.** That is why I needed the CORS allow-list, `SameSite=None` and the Origin check from [Challenge 4](#4-demo-logins-failed-across-websites). With a BFF, the browser talks only to its own origin. The backend could drop cross-site cookies, use stricter **SameSite** settings and stay hidden from the public internet.
- **One place for control.** A BFF is a natural place to add **rate limiting**, logging and request checks for each user.

### Why it can wait

The only accounts people can use today are demo accounts, so little is at risk if something goes wrong:

- The demo account is **anonymous** and shared. Visitors are kept apart only by a device ID.
- Demo chat history is **deleted after 7 days**.
- Demo accounts **cannot upload documents** or delete the account.
- There is a **daily message cap** on the demo account, and **registration is invite-only**.

I would build the BFF once anyone can create their own account and store their own documents. That is when **multi-tenancy** makes a stolen token much more costly.

### Tradeoffs of adding a BFF

- **Every request makes one more network hop**, which adds latency.
- **There is one more service to deploy and monitor.**
- **The SSE chat stream would have to pass through the proxy.** Serverless functions often have time limits that can cut long streams short.
