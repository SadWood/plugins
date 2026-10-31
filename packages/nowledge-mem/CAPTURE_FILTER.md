# Capture filtering

Filtering changes only the text exported to Mem by `capture`. It does not change
model requests, replies, tools, recall, Context Bundle, authentication or Space
routing. It is deterministic, requires no model call and creates no background
worker. These options are available in the plugin's advanced **Options** editor.
Merge them into the existing connection options rather than replacing the Server
URL, API key or Space configuration.

```json
{
  "capture": true,
  "captureFilter": "human",
  "captureCindyAgents": []
}
```

## Modes

- `captureFilter: "off"` is the default. It preserves the existing capture
  projection and `captureTools` behavior, including its treatment of mixed
  assistant text/tool-call messages.
- `captureFilter: "human"` exports user/assistant text and omits tool messages,
  regardless of `captureTools`. It retains commentary accompanying a tool call,
  captions, complete long messages and code indentation. It does not invent
  attachment placeholders, tool transcripts, missing skill commands or human
  authorship. Protocol-native reasoning and non-text blocks stay excluded by
  the existing conversation parser.

Completion and tool-pair validation happen before filtering. A pending tool loop,
truncated reply or unsuccessful completion does not become capturable just
because its tools would be omitted. The existing credential scan also runs
**before** filtering: a credential in an excluded tool result, tool argument or
Cindy note still blocks the entire import. Filtering is not secret redaction.

The 512 KiB serialized import budget, origin checks (`local` / `magpie-key`),
explicit `capture` opt-in, import acknowledgements and replay suppression remain
unchanged. An over-budget dialogue is skipped, not silently truncated.

## Cindy: explicit per-agent opt-in

`captureCindyAgents` defaults to `[]`. It is an exact, case-sensitive list of
Magpie `ctx.agent` values, not a wildcard, Mem `agentId`, hostname or credential.
It is used only with `captureFilter: "human"`. For example, **after verifying**
that the intended Cindy-managed runtime appears as `pi` in Magpie:

```json
{
  "capture": true,
  "captureFilter": "human",
  "captureCindyAgents": ["pi"]
}
```

The gateway cannot read Cindy's launcher environment. Its own process environment
would not establish which client sent a request. An explicit list therefore
replaces the native Pi connector's launcher check; there is no automatic detection
from a marker in user text. When Cindy and ordinary Pi share the same `ctx.agent`,
this option cannot distinguish them. Leave it empty or separate those routes when
that distinction matters. Agent names and recognized text are not authenticated
proof of human authorship.

For an opted-in agent, only complete, known **leading user-text** templates from
Cindy 0.1.121 are removed: language/client/channel notices, directory grants,
Side Chat notes and explicitly delimited handoff/rebuild/fork context. Stacked
notes are handled; incomplete, unknown, quoted, fenced, indented or embedded
examples are retained. A scan is limited to 64 prefixes; larger stacks are left
unchanged rather than partly cleaned. An exact unquoted template placed at the
start of a real user message is indistinguishable from injected text on this wire;
this is why the option is not enabled globally.

Group/non-owner messages retain a short speaker label and `metadata.cindy_origin`
(channel kind, display names and explicit ownership when supplied). Transport
chat/user/device identifiers are omitted from recognized headers, not scrubbed
from actual user text. Assistant text is never cleaned. No remaining user text
means no import. A new filtered Thread's title comes from the surviving user text.

## Identity and existing data

Filtering does not derive a new Thread ID or renumber messages. Each exported
`external_id` still uses its original position and original trimmed text, so
turning the filter on/off does not assign a second identity to the same source
message. Repeated identical messages at different positions remain different
occurrences. Session casing and Space boundaries are preserved.

This is not a migration. Previously saved noise is not deleted, rewritten or
re-distilled. A server may keep an existing message/title instead of replacing
its text when an already-known identity is reimported. Use a fresh session to
inspect the new projection. Do not assume a switch will clean old Threads.

## Gateway limits

This is not a replacement for every native capture contract. A model API request
does not reliably carry OMP attribution, the original `/skill` draft, Pi session
creation timestamps, Cindy parent-session boundaries or selected-Thread
continuation authorization. Unknown ordinary text is preserved. A Side Chat note
is cleaned when explicitly enabled, but **does not authorize cutting inherited
history, guessing a parent Thread or rebinding a child**. Native #785's precise
fork scoping still requires native session data.

The gateway callback remains best-effort, not a durable lifecycle queue. It cannot
recover messages missing from the model request after compaction or intercept
native exit/switch events. Mem's downstream distillation is a separate stage:
an accepted Thread import is not proof that a memory has been generated.

## Tests and provenance

Run the focused dependency-free regressions, then the package's Bun suite:

```sh
node --test packages/nowledge-mem/capture-filter.test.mjs
bun test packages/nowledge-mem
```

The focused tests execute the real gateway callbacks and protocol parser with a
mock import receiver. They use synthetic data only and make no real Mem or model
requests. They establish projection, request immutability and import-payload
contracts, not live server persistence, native-host behavior or Bun parity on a
machine where only Node was run.

Scenarios adapted from the user's native fixes, rather than copying host-specific
lifecycle tests into a gateway harness:

| Source | Gateway regression / boundary |
| --- | --- |
| [OMP #782](https://github.com/nowledge-co/community/pull/782) | Human dialogue reference, tool-adjacent commentary, captions, full long text, repeated occurrences and stable identities. No fabricated native attribution or original skill draft. |
| [Pi/Cindy #785](https://github.com/nowledge-co/community/pull/785), fixture revision `594b1520fb7a187f1deddc660a4602665d85ff3b` | Synthetic complete/stacked templates, negative examples, code indentation, speaker provenance and conservative retention of inherited history when native fork metadata is absent. |
| [#391](https://github.com/nowledge-co/community/issues/391), [#711](https://github.com/nowledge-co/community/issues/711) | Prospective capture noise reduction; no assistant-to-user recasting, invented execution evidence or deletion of quoted examples. Does not implement UI pruning or audit existing memories. |
| [#621](https://github.com/nowledge-co/community/issues/621) | Case-preserving Thread IDs, original-position message IDs, replay, append and mode-switch identity invariants. Does not change the OpenCode history importer. |
| [#362](https://github.com/nowledge-co/community/issues/362) | Benign `task-brief` / `risk-check` words still pass; credentials in content being removed still block import. Does not change the skill-import scanner. |
| [#755](https://github.com/nowledge-co/community/issues/755) | Filtering is independent of recall/context; injected recall is not learned again and model-visible requests stay unchanged. |
| [#756](https://github.com/nowledge-co/community/issues/756) | Bounded template stacks and existing oversized-import rejection; no transcript file scan or worker added. Not a reproduction of Claude worker RSS/lease failures. |

Backend distillation/scheduling reports such as #731, #744 and #784 are outside
this change. No validator relaxation, new distillation endpoint or retry loop is
introduced. The regressions above are analogous safeguards, not a claim to close
all the source issues.

## Returning from a development fork

Keep only one gateway Nowledge Mem package active. After the upstream PR is merged
**and an upstream installable version contains it**, record the current connection
options, switch the package source back to upstream and retain the chosen filter
options. Check a fresh synthetic exchange before resuming normal capture. A merge
alone is not proof of publication. This PR does not install, publish, migrate or
change any user's running Magpie configuration.
