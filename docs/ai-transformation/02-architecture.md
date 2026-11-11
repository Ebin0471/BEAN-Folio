# BEAN Folio — Target Architecture: BEAN Intelligence (existing vs proposed)

Companion to `01-repository-audit.md`. This document defines the transformation architecture. Implementation proceeds in small verifiable phases; each phase lands with tests and honest status.

---

## 1. Existing architecture (as audited)

```
                        ┌──────────────────────────── Browser (SPA at /) ────────────────────────────┐
                        │  SiteShell → IntelligenceView (RIISHE chat JSON)                            │
                        │            → LaxiiView → LaxiiStudio (image/banner/avatar/resume)          │
                        │            → WebsiteBuilderView → CodeGiftzPanel (plan/approve/execute)     │
                        └──────────────┬───────────────────────────────┬─────────────────────────────┘
                                       │ fetch /api/* (same origin)    │
   ┌───────────────────────────────────▼─────────────┐   ┌─────────────▼──────────────────────────┐
   │ Text gateway  src/lib/ai.ts                     │   │ LAXII engine  src/lib/laxii/router.ts  │
   │  aiComplete / aiStream / aiVision               │   │  4-provider registry + capability gate │
   │  aiGate (consent, 6/min, 30/day) → AiUsage      │   │  validate → deterministic post-process │
   │  provider: z-ai-web-dev-sdk (single, hardcoded) │   │  providers: managed|gemini|openai|…    │
   └───────────────┬─────────────────────────────────┘   └─────────────┬──────────────────────────┘
                   │                                                   │
   ┌───────────────▼───────────────────────────────────────────────────▼──────────────────────────┐
   │ Code Giftz pipeline src/lib/ai-design/** (plan/tools/digest/execute/verify/jobs)              │
   │  jobs: IN-MEMORY ONLY (lost on restart) — tools: validated SiteConfig mutations              │
   └───────────────────────────────────────────────────────────────────────────────────────────────┘
   Prisma 36 models · custom scrypt sessions · local/S3 storage · AuditEvent append-only log
```

Defects to remove (from the audit): no circuit breaker/health/retry/fallback in the text gateway; two RIISHE personas; in-memory Code Giftz job store; no cross-agent task protocol; external provider names in user-facing UI; duplicated context assembly.

## 2. Proposed architecture

**Principle: one gateway, three agents, zero provider branding.** The gateway owns provider/model selection, health, retries, usage and cost. Agents own persona, permission boundary and tool registry. The UI sees only LAXII / RIISHE / CODE GIFTZ.

```
                     ┌──────────────────── User-facing identities only ────────────────────┐
                     │   RIISHE (Personal Intelligence) · LAXII (Creative) · CODE GIFTZ    │
                     └──────────────┬──────────────────────────────────────────────────────┘
                                    │  /api/ai/** · /api/laxii/** · /api/agent/**
   ┌────────────────────────────────▼───────────────────────────────────────────────────────┐
   │                    BEAN INTELLIGENCE GATEWAY  src/lib/intelligence/**                   │
   │  registry.ts    provider/model registry per capability (text·vision·image·embedding·code)│
   │                 real documented ids only · env-driven availability · no Ollama          │
   │  circuit.ts     health checks · timeouts · retry policy · circuit breaker (per provider) │
   │  routing        capability-based primary → fallback (same capability only, never        │
   │                 silently changes the task contract) · honest failure otherwise           │
   │  gateway.ts     complete()/stream()/vision()/image() · user-context isolation ·         │
   │                 usage + cost ledger · structured JSON logging (no prompts, no secrets)   │
   │  personas.ts    single source of agent identities + system-prompt cores                  │
   │  context.ts     portfolio context builder (authorized data only, shared by chat routes)  │
   │  delegation.ts  intent → cross-agent task creation (RIISHE → LAXII / Code Giftz)         │
   └───────┬───────────────────────┬──────────────────────────────────┬──────────────────────┘
           │                       │                                  │
   ┌───────▼────────┐   ┌──────────▼─────────┐          ┌───────────▼────────────────────┐
   │ RIISHE routes  │   │ LAXII engine       │          │ Code Giftz pipeline            │
   │ chat(+stream), │   │ (unchanged core;   │          │ plan/execute/verify            │
   │ improve,       │   │ labels rebranded,  │          │ + durable AgentTask store      │
   │ suggest,       │   │ usage via gateway) │          │ (Phase 4+; approval-gated)     │
   │ delegation     │   └────────────────────┘          └────────────────────────────────┘
   └────────────────┘
   New Prisma models (additive only): AgentTask (durable cross-agent tasks, steps JSON, audit)
```

### 2.1 Capability registry (Phase 1)

| Capability | Providers in priority order | Availability rule | Model identifiers |
|---|---|---|---|
| `text` | `bean-managed` (z-ai SDK) | always (server-side gateway) | gateway-resolved; **never fabricated** — recorded as `"gateway-resolved"` until the provider reports an id |
| `vision` | `bean-managed` (createVision) | always | same policy |
| `image` | bridged from LAXII registry: `managed` → `gemini` → `openai` → `diffusers` | credentials/config present | existing verified ids (`managed-image-1`, `gemini-nano-banana-2.1`, `gpt-image-2.5-sunburst`, `local-diffusers`) |
| `embedding` | **none configured** | honest empty | none — any request fails with "no embedding provider configured" (no fake vectors, ever) |
| `code` | `bean-managed` (text capability used for code reasoning) | always | same as text |

Fallback policy: primary → next provider **of the same capability** only, when the failure is transient (timeout/network/5xx) and the fallback declares the same capability contract. Capability-lowering fallback is forbidden (e.g. an image request may never fall back to text). Safety/auth (4xx) failures are **not** retried or fallen back — the error is surfaced honestly.

### 2.2 Health, retries, circuit breaker (Phase 1)

- Per-provider sliding failure window: open after 4 consecutive failures; half-open after 30 s cooldown; one probe request; success closes the circuit.
- Timeouts: text 60 s (deep reasoning 120 s), vision 60 s, image per-provider (managed 240 s, gemini 180 s, diffusers 600 s) — existing values preserved.
- Retries: transient errors only, max 2, exponential backoff (1.5 s / 4 s) — mirrors the existing LAXII `retry.ts` policy, now applied to text/vision too.
- Health is exposed server-side via `/api/ai/capabilities` (ids/labels/health only — no keys, no model internals beyond what the registry already publishes).

### 2.3 Usage, cost, observability (Phase 1)

- Text/vision/design/RIISHE quota: existing `AiUsage` 30/day + 6/min (preserved).
- LAXII image quota: existing `LaxiiUsage` 80/day + 6/min (preserved). Resume generation counts against the text pool only (defect from audit fixed).
- Cost control: registry carries documented per-call cost estimates (existing LAXII table + 0 for managed text); gateway accumulates per-user estimated daily spend and refuses new calls when `INTELLIGENCE_DAILY_COST_LIMIT_USD` (default 5.00) is exceeded. Estimates are labeled estimates, never billed amounts.
- Logging: `console.error/info` → structured single-line JSON (`ts, event, agent, capability, provider, outcome, durationMs, userId?`) — no prompt contents, no credentials. Provider/model names may appear in **server logs** (operators) but never in client payloads beyond what §7.1 of the audit allows.

### 2.4 Cross-agent tasks (Phase 5, built incrementally)

New additive Prisma model `AgentTask`: `id, userId, agent (RIISHE|LAXII|CODE_GIFTZ), kind, title, status (PENDING|RUNNING|AWAITING_APPROVAL|COMPLETED|FAILED|CANCELLED), parentTaskId?, stepsJson, resultJson, error, createdAt, updatedAt`. Durable, restart-safe, cancel/retry-aware, audit-logged. First real workflow: **RIISHE portfolio-aware banner delegation** — detect a banner/visual request in RIISHE chat → build design brief from authorized portfolio context → create a LAXII banner task (kind BANNER conversation) → user reviews/exports in LAXII Studio. No autonomous loops: every delegation is user-visible, approval-gated where it mutates, and one-hop only.

### 2.5 Non-goals / constraints honored

- No rebuild: all changes are additive modules + targeted edits; existing routes keep their contracts (same URLs, same response shapes) unless a defect requires a fix.
- No mock providers, no fabricated ids, no fake success; unavailable capability = honest failure.
- No Ollama; no new heavy dependencies (Phase 6 evaluates but the gateway is implemented with existing platform primitives only).
- Provider credentials only ever read server-side from env; never serialized to clients.
