# TypeScript Client Implementation Plan

This plan splits the TypeScript client work into two implementation PRs.

The split is intentional:

1. Build the shared runtime and transports first, so command execution, discovery, and local setup can be tested without the final typed client surface.
2. Build the public client and action types second, as a typed wrapper over the tested transport capabilities.

This mirrors the intended architecture: transports do the work, actions are typed transport consumers, and clients compose actions around a resolved transport.

The implementation must not carry forward obsolete client shapes from earlier experimental branches:

- no curried `client(command)(input)` API;
- no HTTP-only `createClient({ baseUrl })`;
- no root-module client creation exports;
- no data-only run return;
- no bare async iterable stream return;
- no stream terminal records without full metadata;
- no RPC alias command identity;
- no HTTP/RPC/MCP local setup actions.

## PR 1: Runtime And Transport Foundation

Goal: create the shared runtime contracts that both HTTP and memory transports use.

This PR should make command execution and discovery available through transport-level APIs, but it does not need to expose the final public client action surface.

### 1. Extract Command Tree Utilities

Create an internal command-tree module.

Suggested file:

```txt
src/internal/command-tree.ts
```

Move or expose the command graph utilities embedded in `Cli.ts`:

- command entry types;
- alias detection;
- group detection;
- fetch gateway detection;
- canonical command resolution;
- command traversal helpers;
- mounted sub-CLI traversal behavior.

The module should define canonical command IDs as CLI token paths joined by single spaces.

Command identity rules:

- aliases are CLI-only and are not generated client command IDs;
- root CLIs are callable by their own name;
- mounted root CLIs keep their own command ID;
- mounted router CLIs prefix their leaf commands with the router name;
- nested router CLIs flatten into single-space command IDs;
- raw fetch gateways are traversable for HTTP routing but are not RPC/client command IDs;
- OpenAPI-mounted fetch gateways contribute generated operation command IDs.

Consumers:

- HTTP RPC runtime;
- memory transport runtime;
- discovery builders;
- MCP tool discovery;
- typegen where useful.

### 2. Extract Shared Command Runtime

Create an internal client runtime module.

Suggested file:

```txt
src/internal/client-runtime.ts
```

This module should expose a runtime function equivalent to:

```ts
type ExecuteClientCommand = (
  cli: RuntimeCliContext,
  request: RpcRequest,
) => Promise<RpcResponse | RpcStreamResponse>
```

Responsibilities:

- validate `RpcRequest`;
- resolve canonical command IDs;
- reject unknown commands;
- reject command groups;
- reject structured RPC calls to raw fetch gateways;
- call `Command.execute()`;
- execute through a structured args/options parse mode rather than argv, split HTTP, or MCP flat-param parsing;
- call `Command.execute()` with `agent: true`;
- call `Command.execute()` with empty `argv`;
- call `Command.execute()` with explicit JSON/full-output semantics;
- preserve middleware behavior;
- preserve root, group, and command middleware order;
- preserve env/vars behavior for in-process execution;
- preserve CLI env and command env validation;
- preserve validation `fieldErrors`;
- preserve root command identity and mounted CLI identity;
- apply `selection`;
- format `output.text`;
- compute token count/limit/offset metadata;
- compute `nextOffset`;
- preserve CTA metadata;
- produce full success/error envelopes;
- produce streaming records for streaming commands;
- include full metadata on terminal stream records;
- call command stream `return()` on cancellation;
- defer streaming middleware after-hooks until stream consumption or cancellation.

HTTP RPC and memory transport request execution must both call this shared runtime.

### 3. Define RPC Contracts

Add shared types for:

```ts
type RpcRequest
type RpcFullEnvelope
type RpcResponse
type RpcOutput
type RpcMeta
type RpcStreamRecord
type RpcStreamResponse
```

These are runtime/protocol contracts, not public `ClientRunResult` types.

Validation behavior belongs here and should be tested independently.

RPC contract tests should cover:

- command trimming and empty-command validation;
- canonical command metadata;
- structured args validation independent from options validation;
- structured options validation independent from args validation;
- root command execution;
- mounted root CLI execution;
- mounted router command execution;
- raw fetch gateway rejection;
- alias rejection for typed-client RPC command identity;
- JSON validation errors before command execution.

### 4. Implement HTTP RPC Through Shared Runtime

Keep:

```http
POST /_incur/rpc
```

Route behavior:

- parse JSON request body;
- delegate validation/execution to the shared runtime;
- serialize non-streaming envelopes as JSON;
- serialize streaming command results as NDJSON;
- return JSON validation errors before a stream starts;
- advertise and accept `application/json, application/x-ndjson`;
- treat `Accept` as capability advertisement, not as a command-shape override;
- call `return()` on command streams when the HTTP response body is cancelled;
- preserve existing direct HTTP route behavior outside `/_incur/rpc`.

Direct command HTTP routes must preserve existing streaming behavior while RPC is added:

- async generator commands stream NDJSON chunks;
- terminal `c.ok(..., { cta })` metadata is preserved;
- terminal `c.error()` values become terminal error records;
- thrown stream errors become terminal error records;
- response cancellation closes the command stream.

Tests:

- success envelope;
- command error envelope;
- validation error;
- unknown command;
- command group rejection;
- fetch gateway rejection;
- output formatting;
- selection;
- token count;
- token limit/offset;
- streaming chunk/done records;
- streaming error records;
- terminal stream metadata;
- stream cancellation cleanup.

### 5. Extract Discovery Builders

Create an internal client discovery module.

Suggested file:

```txt
src/internal/client-discovery.ts
```

Expose a shared function equivalent to:

```ts
type DiscoverClientResource = (
  cli: RuntimeCliContext,
  request: DiscoveryRequest,
) => Promise<DiscoveryResponse>
```

Discovery builders:

- `llms`;
- `llmsFull`;
- `schema`;
- `help`;
- `openapi`;
- `skillsIndex`;
- `skill`;
- `mcpTools`.

Reuse existing primitives:

- `Skill.index()`;
- `Skill.generate()`;
- `Skill.split()`;
- `Openapi.fromCli()`;
- `Mcp.collectTools()`;
- existing help/schema formatting logic.

Discovery builders must include OpenAPI-mounted operation commands everywhere command discovery is expected, and must exclude raw fetch gateways from command-run discovery.

Avoid duplicated traversal between:

- CLI `--llms`;
- CLI `--llms-full`;
- well-known skills routes;
- `_incur` discovery routes;
- memory discovery.

### 6. Add HTTP Discovery Routes

Add client discovery routes:

```http
GET /_incur/llms
GET /_incur/llms-full
GET /_incur/schema
GET /_incur/help
GET /_incur/mcp/tools
GET /_incur/skills
GET /_incur/skill
```

Keep existing public routes:

```http
GET /openapi.json
GET /openapi.yml
GET /openapi.yaml
GET /.well-known/openapi.json
GET /.well-known/skills/index.json
GET /.well-known/skills/{name}/SKILL.md
POST /mcp
```

HTTP discovery routes should delegate to shared discovery builders.

Tests:

- structured discovery payloads;
- formatted discovery payloads;
- content types;
- invalid query params;
- unknown command;
- command group handling where valid;
- unknown skill;
- unsafe skill names;
- matching payloads with existing well-known skills where applicable;
- matching MCP tool descriptors with `Mcp.collectTools()`.

### 7. Extract Local Setup Runtime

Create an internal local setup module.

Suggested file:

```txt
src/internal/client-local.ts
```

Expose wrappers for memory local actions:

```ts
type LocalRuntime = {
  skills: {
    add(options?: SkillsAddOptions | undefined): Promise<SyncedSkills>
    list(options?: SkillsListOptions | undefined): Promise<SkillsList>
  }
  mcp: {
    add(options?: McpAddOptions | undefined): Promise<McpRegistration>
  }
}
```

Reuse existing local implementations:

- `SyncSkills.sync()`;
- `SyncSkills.list()`;
- `SyncMcp.register()`.

This module should use TypeScript-shaped options:

- `global?: boolean | undefined`;
- `agents?: string[] | undefined`;
- `command?: string | undefined`;
- `depth?: number | undefined`.

Parity details:

- `skills.add()` uses configured sync depth when present, otherwise `1`;
- `skills.add({ global: false })` maps to CLI `--no-global`;
- `skills.list()` uses the same depth default as CLI `skills list`;
- `mcp.add()` defaults `global` to `true`;
- `mcp.add({ agents })` maps to repeated CLI agents;
- `mcp.add({ command })` maps to CLI command override.

It should not expose shell completions.

### 8. Implement Transports

Add transport constructors.

Suggested files:

```txt
src/client/transports/createTransport.ts
src/client/transports/http.ts
src/client/transports/memory.ts
```

The exact file layout can differ, but keep transport code separate from action code.

Transport constructors:

```ts
httpTransport(options): HttpTransport
memoryTransport(cli, options): MemoryTransport
```

Transport behavior:

- `httpTransport(...).request()` calls `POST /_incur/rpc`;
- `httpTransport(...).discover()` calls HTTP discovery routes;
- `memoryTransport(...).request()` calls shared command runtime;
- `memoryTransport(...).discover()` calls shared discovery builders;
- `memoryTransport(...).local` calls shared local setup runtime.

HTTP transport details:

- use `options.fetch ?? globalThis.fetch`;
- throw `ClientError` when no fetch implementation exists;
- wrap fetch/network rejections in `ClientError` with message `RPC request failed`;
- normalize base URLs with and without trailing slashes;
- preserve base URL path prefixes;
- serialize omitted `args` and `options` as `{}`;
- send required protocol headers;
- merge custom headers predictably;
- parse JSON envelopes;
- parse NDJSON streams split across network chunks;
- ignore blank NDJSON lines;
- accept final NDJSON records without trailing newline;
- throw `ClientError` for invalid JSON, malformed envelopes, malformed stream records, missing stream bodies, and EOF before terminal stream records;
- cancel the underlying HTTP reader when the consumer stops early.

Memory transport details:

- execute in process without calling `cli.fetch()`;
- use explicit `env` option as the environment source;
- do not read CLI config defaults;
- close in-process streams when the consumer stops early.

Transport tests should directly exercise transports without the final public client:

- HTTP request success/error;
- HTTP stream parsing at transport level;
- missing fetch implementation;
- fetch/network rejection wrapping;
- HTTP base URL normalization;
- omitted `args`/`options` serializing as `{}`;
- required protocol headers;
- HTTP custom headers;
- non-JSON envelope errors;
- malformed envelope errors;
- HTTP malformed-response errors;
- NDJSON records split across chunks;
- blank NDJSON lines;
- final NDJSON record without trailing newline;
- missing stream body errors;
- malformed stream record errors;
- truncated stream errors;
- HTTP discovery routing;
- memory request behavior matching the HTTP runtime;
- memory env injection;
- memory middleware ordering;
- memory stream cancellation;
- memory discovery behavior matching the HTTP discovery builders;
- memory local actions;
- no local capability on HTTP transport.

### 9. Implement OpenAPI Command Generation

OpenAPI-mounted fetch handlers must generate command entries and command-map types before the public client layer is built.

Runtime behavior:

- dereference `$ref` pointers;
- support standard HTTP methods plus OpenAPI 3.2 `query`;
- merge path-level and operation-level parameters;
- use `operationId` as the command leaf name;
- derive fallback names from method and path when `operationId` is absent;
- apply `basePath`;
- URL-encode path parameters;
- map query parameters into `URLSearchParams`;
- flatten JSON request body object properties into options;
- infer output schemas from the first `200` response, then first `2xx` response;
- convert only `application/json` request and response bodies;
- return command errors with `HTTP_${status}` for failed fetch responses.

Type behavior:

- OpenAPI-mounted commands are included in `Cli.Cli<commands>`;
- OpenAPI-mounted commands are included in generated `Commands`;
- raw fetch gateways are excluded from generated command maps;
- generated OpenAPI args/options/output types match runtime command schemas.

Tests:

- path-level parameters;
- operation-level parameters;
- optional and required query parameters;
- optional and required JSON body fields;
- optional request body semantics;
- success output inference;
- operation fallback naming;
- OpenAPI 3.2 `query`;
- path parameter URL encoding;
- boolean and number path/query coercion;
- strict boolean string coercion;
- raw fetch gateway exclusion;
- no serving required before OpenAPI-mounted command generation;
- generated command round trip through memory transport.

### 10. PR 1 Non-Goals

Do not complete the final typed public client surface in this PR.

Do not add final `RunActions`, `DiscoveryActions`, or `LocalActions` method binding except where needed for low-level transport tests.

Do not change MCP tool scope to include setup/admin commands.

Do not add shell completions to any client/transport API.

## PR 2: Public Client And Type Surface

Goal: build the final typed API over the tested transport/runtime foundation.

This PR should make `docs/api_example.ts` typecheck conceptually against the public client surface.

### 1. Implement Client Creation

Implement:

```ts
createClient({ transport, ...defaults })
createHttpClient(options)
createMemoryClient(cli, options)
```

`createClient` should:

- generate a `uid`;
- resolve the transport factory;
- store client defaults;
- expose resolved transport metadata;
- attach action sets.

Convenience factories must remain thin wrappers.

`createMemoryClient(cli)` should infer `commands` from `Cli.Cli<commands, ...>` when possible, and should allow an explicit generic override when inference is not desired.

An explicit permissive command map such as `Record<string, { args: unknown; options: unknown; output: unknown }>` should be supported as an intentional escape hatch.

### 2. Implement Action Binding

Add action modules.

Suggested layout:

```txt
src/client/actions/run.ts
src/client/actions/discovery.ts
src/client/actions/local.ts
```

Actions should be standalone functions that consume a client.

The bound client methods should call those standalone actions.

The action model should stay close to viem's pattern:

- action implementation receives `client`;
- action calls `client.transport` capabilities;
- convenience client creators compose action sets;
- future overrides/extensions remain possible.

### 3. Add RunActions

Implement:

```ts
client.run(command, input?)
```

Runtime behavior:

- merge client defaults and per-call output controls;
- build `RpcRequest`;
- call `client.transport.request()`;
- normalize successful envelopes into `ClientRunResult`;
- throw `ClientError` for command failures;
- normalize CTAs;
- attach `output.next()` where applicable;
- return stream wrapper for streaming commands.

Type behavior:

- command IDs are generated canonical command IDs;
- aliases are not accepted by generated client types;
- required args/options require `input`;
- selected data is `unknown`;
- `selection: undefined` clears default selection;
- streaming commands return `ClientStreamResponse`;
- non-streaming commands return `ClientRunResult`.

Tests:

- `.test-d.ts` for required/optional input;
- `.test-d.ts` for root command IDs;
- `.test-d.ts` for mounted root CLI IDs;
- `.test-d.ts` for mounted router CLI IDs;
- `.test-d.ts` for permissive command maps;
- `.test-d.ts` for memory client command inference and explicit override;
- `.test-d.ts` for selected data;
- `.test-d.ts` for default selection clearing;
- runtime tests for output controls;
- runtime tests for `ClientError`;
- runtime tests for `output.next()`.

### 4. Add CTA Normalization

Normalize RPC CTA metadata into public client CTA objects.

Rules:

- CTA data lives under `meta.cta`;
- runnable CTAs expose typed `run()`;
- unresolved CTAs expose `runnable: false` and `unresolvedReason`;
- `cliCommand` is CLI-ready text;
- `cliCommand` includes the CLI/root command prefix exactly once;
- structured CTA args render as positional values;
- structured CTA args with value `true` render as placeholders;
- structured CTA options render as `--key value` flags;
- structured CTA options with value `true` render as placeholders;
- `raw` preserves source CTA data;
- CTA `run()` inherits client defaults, not source-run output controls.

Tests:

- string CTA;
- structured CTA;
- command CTA;
- unknown command CTA;
- invalid input CTA;
- error CTA;
- streaming terminal CTA.

### 5. Add Stream Wrapper

Implement `ClientStreamResponse`.

Behavior:

- default async iteration yields chunks;
- `records()` yields all normalized records;
- `final` resolves/rejects from the terminal record;
- stream is single-consumer;
- protocol errors throw `ClientError`;
- terminal command errors are yielded by `records()` and thrown by default iteration/final;
- split NDJSON records are parsed correctly;
- blank NDJSON lines are ignored;
- final NDJSON records do not require a trailing newline;
- early consumer exit cancels or returns the underlying stream.

Tests:

- chunk iteration;
- final metadata;
- terminal error;
- records mode;
- single-consumer enforcement;
- cancellation behavior;
- invalid JSON record errors;
- malformed record errors;
- missing body errors;
- EOF before terminal record errors.

### 6. Add DiscoveryActions

Implement:

```ts
client.llms()
client.llmsFull()
client.schema(command?)
client.help(command?)
client.openapi()
client.skills.index()
client.skills.get(name)
client.mcp.tools()
```

Runtime behavior:

- call `client.transport.discover()`;
- normalize discovery errors into `ClientError`;
- preserve structured return by default;
- return strings for explicit `format`.

Type behavior:

- omitted `format` returns structured data;
- literal `format` returns `string`;
- variable `DiscoveryFormat | undefined` returns structured-or-string;
- command scopes are typed from generated command maps;
- `skills.get(name)` accepts safe strings and server/runtime validates existence.

Tests:

- `.test-d.ts` for overloads;
- `.test-d.ts` for command scope narrowing;
- runtime tests for all discovery actions over HTTP transport;
- runtime tests for all discovery actions over memory transport.

### 7. Add LocalActions

Implement local actions only for memory clients:

```ts
memory.skills.add(options?)
memory.skills.list(options?)
memory.mcp.add(options?)
```

Runtime behavior:

- actions call `client.transport.local`;
- no HTTP route is involved;
- no RPC call is involved;
- no MCP tool is involved;
- local action defaults match the spec.

Type behavior:

- `MemoryClient` exposes local actions;
- `HttpClient` does not expose local actions;
- `Client<commands, Transport>` does not expose local actions;
- `Client<commands, MemoryTransport>` exposes local actions.

Tests:

- `.test-d.ts` for action availability;
- runtime tests for skills add/list;
- runtime tests for MCP registration;
- runtime tests for default local-action option mapping;
- runtime tests or route tests proving HTTP/RPC/MCP do not expose local setup/admin commands.

### 8. Update Typegen

Generated command maps should include:

- canonical command IDs;
- `args`;
- `options`;
- optional `output`;
- `stream: true` for streaming commands.

Rules:

- command groups are not command IDs;
- aliases are not command IDs;
- mounted CLI commands are flattened;
- missing output schema maps to `unknown`;
- streaming `output` is the chunk type;
- generated files export `Commands`;
- generated files augment both `incur` and `incur/client`;
- generated command properties include JSDoc;
- optional properties include `| undefined`;
- invalid object keys and command keys are escaped;
- unsupported schemas fail with a clear typegen error.

Schema support:

- primitives, literals, enums, unions, arrays;
- records and enum-key records;
- tuples and rest tuples;
- nested objects;
- catchall/index signatures;
- non-object top-level outputs;
- void, undefined, never, and unknown fallbacks.

Tests:

- typegen command ID output;
- stream marker output;
- outputless command typing;
- mounted command typing;
- alias exclusion;
- exported `Commands` shape;
- module augmentation shape;
- exact optional property output;
- non-object output schemas;
- records and enum-key records;
- tuples and rest tuples;
- escaped keys;
- catchall output;
- unsupported schema errors;
- OpenAPI-mounted command output.

### 9. Add Public Error Types

Expose public client error types from `incur/client`:

```ts
ClientError
ClientRpcEnvelope
ClientRpcError
ClientRpcErrorEnvelope
ClientRpcMeta
isClientRpcError
isClientRpcErrorEnvelope
```

Tests:

- `ClientError` fields;
- narrowing `ClientError.error` with `isClientRpcError`;
- narrowing `ClientError.data` with `isClientRpcErrorEnvelope`;
- `ClientError.data`;
- `ClientError.error`;
- `ClientError.status`;
- `ClientError.meta`;
- `ClientError.code`;
- `ClientError.retryable`;
- `ClientError.fieldErrors`;
- malformed response errors preserve diagnostic `data`;
- wrapped fetch failures preserve `cause`;
- failed RPC envelopes preserve error payloads and status.

### 10. Package Export

Expose the client subpath.

Add or update package exports so this works:

```ts
import { createHttpClient } from 'incur/client'
```

Ensure generated declarations and runtime files are emitted for the subpath.

Do not export client creation APIs from the root `incur` module.

### 11. Documentation And Example

Finalize:

- `docs/typed-client-spec.md`;
- `docs/api_example.ts`;
- public README/API docs as needed.

The example should show:

- `createHttpClient`;
- equivalent `createClient({ transport: httpTransport(...) })`;
- `createMemoryClient`;
- equivalent `createClient({ transport: memoryTransport(...) })`;
- run actions;
- output controls;
- CTAs;
- streaming;
- discovery actions;
- memory-only local actions.

### 12. PR 2 Non-Goals

Do not add shell completions to TS clients.

Do not expose local actions over HTTP, RPC, or MCP.

Do not add config default loading to TS clients.

Do not add a data-only run API.

Do not introduce additional transports beyond HTTP and memory.
