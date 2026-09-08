# Pi Runtime Copilot Architecture

## Purpose

VS12 adds a real-time, read-only AI work companion to the existing consulting Role OS. PostgreSQL remains the only source of business truth. The assistant observes committed work, reads an authorized snapshot, and produces a traceable `PROPOSAL`; it never performs a business command.

## Runtime flow

```text
Business transaction
  ├─ business state and immutable audit event
  └─ AFTER INSERT trigger → vs12_work_events
                              ↓
                     Assistant outbox poller
                              ↓
             persistent Session / Run / Stream Event
                              ↓
                    AssistantRuntimePort
                    ├─ PiRuntimeAdapter
                    └─ DemoRulesRuntimeAdapter
                              ↓
            server-bound, read-only context tools
                              ↓
              fetch-SSE with replay cursor
                              ↓
                    right-side Copilot
```

Business commit does not depend on the poller, model provider, Pi session, or browser connection. A failure anywhere after the outbox leaves the employee's action intact.

## Module boundaries

### Assistant application

The application layer exposes four operations only:

- create a user-message Run;
- load authorized history;
- stream persisted events after a cursor;
- claim and process pending WorkEvents.

It hides run coalescing, retry, fallback, session recovery and stream persistence.

### Runtime port

`AssistantRuntimePort` owns no business repository. It accepts a frozen runtime request and emits runtime events through a sink. Implementations are Pi, deterministic DEMO_RULES and test Fake.

Pi SDK types stop at the Pi adapter. The package is pinned to `@earendil-works/pi-coding-agent@0.84.2`; its Node requirement is `>=22.19.0`. The CommonJS API loads this ESM-only dependency behind an isolated native dynamic import. If that compatibility seam cannot be verified, the supported fallback architecture is a separate Node 22 RPC sidecar, not an unverified older SDK.

### Context port

The Context adapter temporarily reuses the existing public `project()` and `task()` read models. It verifies that the source task belongs to the authorized project and filters results before returning them to a tool. It does not expose a database pool to Pi.

The first custom tools are:

- `get_current_work_context`
- `get_recent_work_events`
- `get_evidence`

The tool model cannot supply tenant, subject, role or project scope. Tool input schemas are strict. Materials and retrieved text are marked as untrusted business content. Missing source bodies return `BODY_NOT_AVAILABLE`.

### Store

PostgreSQL persists:

- transactional WorkEvents;
- application sessions;
- assistant runs and final suggestions;
- stream events and replay cursors.

Pi's in-memory session is disposable. After process loss, a new Pi session is built from authorized current context, recent WorkEvents and bounded persisted conversation history. Pi session data is never a business fact source.

## Event consistency

The outbox trigger observes the existing append-only `vs01_project_events` inside the same transaction. Only an allowlist of known source events is normalized. Unknown events are ignored rather than guessed.

`source_table + source_event_id` is unique. Workers claim ready rows with `FOR UPDATE SKIP LOCKED`. Events sharing a transaction correlation key are coalesced into one Run, preventing an item completion and its automatic stage transition from producing duplicate advice.

Outbox rows move through `PENDING / PROCESSING / PROCESSED / DEAD_LETTER`. Retry metadata is operational state, not business state.

## Streaming protocol

The browser uses `fetch()` with a readable SSE response so the current demo role header can be sent. Every persisted stream event has an increasing cursor. Reconnection requests `after=<cursor>` and replays only later events.

Stream event types are `STREAM_READY`, `RUN_STARTED`, `STATE_CHANGED`, `TOOL_STARTED`, `TOOL_COMPLETED`, `TEXT_DELTA`, `SUGGESTION`, `RUN_COMPLETED`, `RUN_FAILED` and `HEARTBEAT`.

Raw provider errors, SQL, internal tool arguments, filesystem paths and credentials are never included. `TOOL_COMPLETED` exposes only a safe status and permitted evidence identifiers.

## Authorization and trust

The current `x-vs01-role` header and fixed demo tenant are local demonstration seams, not production identity. The controller authenticates/authorizes before application or retrieval work, constructs an immutable server-side scope, and the Context adapter rechecks project/source-task membership.

Pi receives:

- no built-in read, shell, edit or write tools;
- no business mutation tools;
- no filesystem or database handle;
- no ability to choose its own scope.

All model output is classified `PROPOSAL`. Evidence, confirmed facts, human decisions, current workflow state and formal experience remain distinct. Retrieved content cannot override the system policy.

## Failure behavior

- Missing Pi configuration selects an explicitly labelled DEMO_RULES provider.
- A configured Pi provider is retried at most once; continued failure becomes an explicit fallback Run.
- Tool failure yields a typed safe result and cannot be bypassed by fallback.
- SSE loss is recovered from the persisted cursor.
- Session loss rebuilds AI context and does not change business state.
- Dead-letter WorkEvents remain inspectable and replayable by an operator; they never roll back business transactions.

## Deliberate limitations

VS12 does not provide production authentication, production multi-tenancy, autonomous execution, RAG, connector access, Redis, WebSocket, a broad Pi Skill platform, or a decomposition of the existing large VS01 service. A future stabilization slice should introduce a dedicated ProjectReadModel before expanding the tool catalog.
