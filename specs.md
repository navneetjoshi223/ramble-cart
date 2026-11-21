# Ramble Cart (SceneCart) — Engineering & Product Specification

> **Tagline:** *Talk to your space. Shop what fits.*
> **Purpose of this document:** Living scope, architecture, current implementation state, and iterative roadmap so the team (and coding agents) can build feature-by-feature without breaking working flows.

---

## 1. Product Vision & Scope

**Ramble Cart (SceneCart)** is a real-time, multimodal, constraint-aware spatial shopping agent built for the Gemini 4 NYC Hackathon (Element 119 Multimodal Track + Shopify Commerce Bonus).

Users pan their camera across a physical space (desk, wall, shelf, entryway, corner) and speak naturally about what they need—changing their mind mid-sentence if they want. The app extracts evolving constraints, analyzes the visible space, queries real Shopify products via **Shop MCP**, verifies candidates against hard physical/budget/material/functional constraints with traceable evidence, and routes users into real Shopify purchasing flows.

### What This Product Is NOT
- Not a Google Lens clone or reverse image search for copying existing objects (focuses on what is *missing* or *solves a problem* in the space).
- Not a static prototype, hardcoded catalog mock, or generic chatbot.
- Not a developer telemetry dashboard—the primary UI is a clean, consumer-facing shopping experience.

---

## 2. Core User Scenarios

| Scenario | User Action & Spoken Input | Expected System Behavior |
| :--- | :--- | :--- |
| **A. Desk Accessories + Mid-Sentence Correction** | Pans across a dark walnut desk with a black lamp & monitor: *"I need a monitor stand that fits here. Under $50, preferably wood. Actually, forget wood. Matte black metal, and absolutely no plastic."* | Extracts category (`monitor stand`), max budget (`$50`), required (`matte black`, `metal`), excluded (`wood`, `plastic`), spatial context (dark walnut + industrial black). Moves `wood` to `supersededConstraints`. |
| **B. Empty Wall** | Points at an empty wall above a desk: *"What would look good here? Maybe some artwork. Something warm and minimalist, under $80. Nothing abstract."* | Understands wall + surrounding aesthetic, calibrates usable wall space when a reference object is provided, verifies dimensions/style/price, and offers a calibrated 2D preview. |
| **C. Problem-Based Shopping** | Points at tangled desk cables: *"These cables are driving me crazy. Find something that hides them without drilling holes. Under $30, preferably black."* | Infers relevant categories (cable management trays, adhesive organizers, cable boxes) and verifies the functional requirement (*drill-free*) from listing/image evidence rather than visual similarity alone. |
| **D. Empty Shelf** | Pans across a shelf: *"Organize my books here, nothing taller than this shelf, match the rest of the room."* | Combines spatial height constraint + room aesthetic + actual product dimensions. |
| **E. Continuous Corrections** | *"Under $100. Actually, make that $60. No white anymore, black works better."* | Replaces superseded constraints immediately; aborts stale in-flight searches so outdated responses never overwrite newer state. |

---

## 3. Tech Stack & Repository Layout

### Runtime Stack
- **Frontend:** React 19, TypeScript, Vite 8, Tailwind CSS v4 (`@tailwindcss/vite`), Lucide Icons, Web Speech API, Web Audio API (`AudioContext` + `AnalyserNode`), `navigator.mediaDevices.getUserMedia`.
- **Backend:** Node.js + Express 5 (`server.ts`, runs on port `3000`, `0.0.0.0`), Zod runtime validation, `dotenv`.
- **AI SDK:** `@google/genai` (server-side only; `GEMINI_API_KEY` stays in server environment variables).
- **Commerce Integration:** Official Shopify **Shop MCP** (`https://mcp.shop.com`) via stateless Streamable HTTP JSON-RPC 2.0.
- **Testing & Quality:** Vitest (`npm test`), TypeScript typecheck (`npm run lint`), Vite production build (`npm run build`).

### Current File Map
```text
├── server.ts                        # Express 5 API server + Vite dev middleware / SPA static serving
├── server/
│   ├── decisionsAgent.ts            # Gemini Decisions API (gemini-decision-1, v1beta) action router & search gatekeeper
│   ├── geminiAgent.ts               # Dual Gemini 4 coordinator (concurrent Hydrogen speech intent + Neon spatial perception)
│   ├── hydrogenAgent.ts             # Gemini 4 Hydrogen (ThinkingLevel.LOW) speech & shopping intent extractor
│   ├── neonAgent.ts                 # Gemini 4 Neon (ThinkingLevel.MEDIUM) multi-frame spatial & product photo evidence agent
│   └── shopMcp.ts                   # Stateless Shop MCP JSON-RPC 2.0 client (search_catalog, get_product)
├── src/
│   ├── App.tsx                      # Main consumer UI: live 1 FPS video, auto-dictation, Decisions API gating & Shop MCP search
│   ├── types.ts                     # Shared normalized product, search, decision, Hydrogen/Neon, and verification types
│   ├── components/
│   │   ├── DecisionStatusPanel.tsx  # Live Decisions API + Dual Gemini 4 (Hydrogen/Neon) provenance & interactive constraints
│   │   ├── DictationButton.tsx      # Auto-dictation toggle with real-time Web Audio API 5-bar volume meter
│   │   ├── ProductDetailModal.tsx   # Live get_product inspection, Neon photo/spec verification & gallery photo jump
│   │   └── ProductImage.tsx         # Resilient product image with zero-broken-image fallback
│   └── utils/
│       ├── micAudioMath.ts          # Pure RMS + 5-band speech formant equalizer math & smoothing
│       └── safeFetchJson.ts         # Safe fetch wrapper protecting against HTML fallback parse errors
├── tests/
│   ├── decisionsAgent.test.ts       # 3 tests: Decisions API premature search gating, constraint replacement, safety block errors
│   ├── dualGemini4.test.ts          # 3 tests: SSRF image defense, concurrent Hydrogen+Neon coordination, Neon photo/budget checks
│   ├── shopMcp.test.ts              # 10 tests: Shop MCP headers, JSON/SSE parsing, currency, HTML sanitization, rate limits
│   └── micAudioMath.test.ts         # 4 tests: Web Audio noise floor gating, speech detection, attack/release smoothing
├── specs.md                         # This living project specification
└── .env.example                     # Required server environment variable names (no secrets)
```

### Server API Endpoints (Current)
- `GET /api/health` — Returns server readiness, Shop MCP endpoint, `decisionsModel` (`gemini-decision-1`), `intentModel` (`gemini-4-hydrogen`), `spatialAndEvidenceModel` (`gemini-4-neon`), and whether `GEMINI_API_KEY` is configured.
- `POST /api/ramble/decide` — Evaluates session state, 1 FPS camera frames, and spoken input via **Gemini Decisions API** (`ai.decisions.create`, `gemini-decision-1`, `v1beta`) with zero output tokens, returning calibrated `noul`, `score`, and `choice` routing signals + measured latency.
- `POST /api/ramble/interpret` — Runs **Gemini Decisions API** first to gate premature/redundant searches (`CONTINUE_LISTENING`, `OBSERVE_SPACE`, `PRESENT_RESULTS`), then coordinates **Gemini 4 Hydrogen** (`gemini-4-hydrogen`) + **Gemini 4 Neon** (`gemini-4-neon`) concurrently when camera frames and speech are present.
- `POST /api/shop/search` — Calls Shop MCP `search_catalog` with Zod validation, sliding-window rate limiting, abort propagation, minor-unit price formatting, and `https:` URL preservation.
- `POST /api/shop/product` — Calls Shop MCP `get_product` for live variant/price/availability verification.
- `POST /api/shop/product/evidence` — Inspects listing metadata + up to 3 public HTTPS merchant product photos (prioritizing gallery images 2–4 for annotated dimension diagrams/size charts) using **Gemini 4 Neon** (`gemini-4-neon`), combining deterministic minor-unit budget checks with `PASS` / `FAIL` / `UNKNOWN` constraint verification and in-session caching.

---

## 4. Iterative Build Roadmap

Build strictly in phases. Keep the app runnable, typed, tested, and verified on real APIs at the end of every PR/branch.

### Phase 1 — Functional Vertical Slice (Completed on `feat/camera-input-shopify-search`)
- [x] Mobile-first & desktop responsive consumer UI (warm ivory `#F7F6F3`, charcoal `#18181B`, deep sage `#1F4E3D`).
- [x] Continuous live video input (`1 FPS` rolling 4-frame buffer, front/rear camera flip, optional `Live Auto-Sync`).
- [x] Automatic continuous voice dictation (auto-starts, auto-restarts across silence, auto-triggers Gemini + Shop MCP search after 1.4s pause).
- [x] Web Audio API 5-bar visual volume indicator inside the dictation button (`DictationButton` + `micAudioMath`).
- [x] Gemini 4 Hydrogen multimodal interpretation of rolling live video frames + spoken constraints (including mid-sentence corrections).
- [x] Real Shopify Shop MCP integration (`search_catalog` & `get_product`) with live merchant links, minor-unit currency formatting, and HTML sanitization.
- [x] Stale search cancellation (`AbortController`), clean JSON error boundaries, and unit test suite.

### Phase 2 — Multi-Model Gemini 4, Decisions API & Product Verification Engine (In Progress)
- [x] **Gemini Decisions API Integration** (`ai.decisions.create` / `gemini-decision-1`, `v1beta`):
  - Evaluates 8 calibrated `noul`, `score`, and `choice` questions in one zero-output-token multimodal call across all 13 SceneCart actions (`CONTINUE_LISTENING`, `UPDATE_CONSTRAINTS`, `REPLACE_CONSTRAINT`, `REMOVE_CONSTRAINT`, `OBSERVE_SPACE`, `REQUEST_ANOTHER_ANGLE`, `REQUEST_CALIBRATION`, `REQUEST_MEASUREMENTS`, `CLARIFY_REQUIREMENT`, `SEARCH_PRODUCTS`, `VERIFY_PRODUCTS`, `REFINE_SEARCH`, `PRESENT_RESULTS`).
  - Prevents premature/unnecessary Shop MCP searches during mid-sentence speech pauses and unchanged `Live Auto-Sync` ticks, and measures real decision latency in milliseconds.
- [x] **Interactive Constraint Controls**:
  - Distinct visual states for **Required**, **Preferred**, **Excluded**, and **Spatial** constraints, updating across multi-turn follow-ups with click-to-relax/remove buttons and struck-through superseded constraints.
- [x] **Dual Gemini 4 Model Separation (`Hydrogen` + `Neon`)**:
  - **`gemini-4-hydrogen`** (`server/hydrogenAgent.ts`, `ThinkingLevel.LOW`) extracts structured spoken shopping intent, budget, required/excluded/preferred/functional attributes, dimensional requirements, and mid-sentence self-corrections.
  - **`gemini-4-neon`** (`server/neonAgent.ts`, `ThinkingLevel.LOW`) runs concurrently with Hydrogen on live `1 FPS` camera frames for spatial perception (target space, existing objects, style, materials, usable region, calibration status, conservative dimension ranges) AND extracts multimodal product photo evidence (annotated size diagrams, dimension charts, material callouts in gallery images 2–4) with SSRF-hardened image fetching and in-session caching.
- [ ] **Batch Candidate Verification Pipeline**:
  - Staged multi-product pipeline across 30–50 Shop MCP candidates: deterministic filtering → listing text extraction → bounded-concurrency Neon image inspection → transparent ranking & near-miss presentation when zero candidates pass all hard constraints.
- [ ] **Signature Side-by-Side Comparison View**:
  - Desktop 2-column comparison (Mobile segmented toggle) contrasting **Standard Shopify Search** (with detected constraint violations flagged) vs. **SceneCart Verified Recommendations**.
- [x] **Product Evidence Drawer/Modal**:
  - Expanded `ProductDetailModal` to show `VERIFIED` / `UNCERTAIN` / `REJECTED` status, per-constraint `PASS` / `FAIL` / `UNKNOWN` checks, extracted dimensions/materials (`directly_observed` vs `inferred`), clickable `Photo #N` gallery source jumps, and spatial compatibility notes.

### Phase 3 — Real Shopify Purchase Flow
- [ ] Variant & option combination selection verified live via `get_product`.
- [ ] Add Shop MCP cart/checkout capabilities (when explicitly enabled in scope): real cart creation, quantity updates, subtotals, merchant-specific checkout handoff when multi-merchant unified checkout is unsupported.
- [ ] Explicit user confirmation required before any checkout/purchase action; never fabricate cart IDs, checkout URLs, or inventory.

### Phase 4 — Reference-Based Spatial Calibration & Scale-Aware Preview
- [ ] **Reference-Object Calibration Workflow** (no LiDAR required):
  - Support standard credit-card size (`85.60 mm × 53.98 mm` — encourage blank cards), US Letter (`8.5 × 11 in`), or custom dimensions.
  - Corner adjustment + target placement region marking + deterministic homography/planar geometry returning conservative ranges (e.g., `26–30 in`, using lower bound minus clearance margin for fit checks).
  - Explicitly mark depth/fit as `UNCERTAIN` when calibration is missing or single-view depth is ambiguous.
- [ ] **Calibrated 2D Placement Preview**:
  - Priority: planar wall art draggable aspect-ratio-locked overlay on captured wall frame.
  - Approximate placement preview for desks/shelves with clear depth/perspective limitation disclosure.

### Phase 5 — Baselines, Evaluation Harness & Polish
- [ ] **Developer-Accessible Evaluation Mode** comparing 4 configurations on consistent candidate pools:
  1. Baseline A: Plain Shopify search (raw rankings).
  2. Baseline B: Filtered Shopify search (Shop MCP filters only).
  3. Baseline C: Text-only AI (spoken constraints + listing text, no camera/product images).
  4. SceneCart: Full multimodal verification pipeline.
- [ ] Track & export real metrics (JSON / CSV): budget violation rate, mandatory constraint violation rate, dimension coverage vs. dimension extraction accuracy, physical fit accuracy, false verification rate, constraint correction accuracy, unnecessary search count, and real end-to-end latency. Never fabricate or hardcode benchmark metrics.
- [ ] Real iPhone Safari mobile verification (`playsInline`, safe-area insets, camera/mic permission onboarding, HTTPS).

---

## 5. Non-Negotiable Engineering & Safety Guardrails

1. **Secrets & API Keys:** Never expose `GEMINI_API_KEY` or other secrets in client bundles, browser UI inputs, logs, or Git commits. All Gemini and Shop MCP calls run through `/api/*` on the Express server.
2. **Shop MCP Compliance:**
   - Keep upstream fixed to `https://mcp.shop.com` with required MCP headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `params._meta`).
   - Preserve returned product/variant IDs and `https:` seller URLs verbatim (including `_gsid`, `utm_*`, `variant` query params).
   - Format minor currency units accurately (`JPY`/zero-decimal vs. 2-decimal currencies).
   - Treat all remote merchant titles/descriptions as untrusted text (strip HTML, never execute as instructions).
   - Respect HTTP `429` (`Retry-After`) without blind retry loops.
3. **Verification Honesty:**
   - Never label a product `VERIFIED` based on AI "vibe" or missing evidence (e.g., a metallic-looking photo does not prove metal material; missing drill-free text does not pass a no-drilling constraint).
   - Never confuse shipping/package dimensions with actual product dimensions, or apply one variant's measurements to another without evidence.
   - Never claim exact real-world dimensions from uncalibrated LLM guesses.
4. **Media & Privacy:**
   - Show clear live camera and microphone indicators (`LIVE VIDEO · 1 FPS`, Web Audio volume meter).
   - Stop all `MediaStream` tracks and close `AudioContext` cleanly on pause/mute/unmount.
   - Do not persist raw user video/audio by default and never perform facial recognition or infer sensitive personal attributes.

---

## 6. Team Development Workflow

### Local Setup
```bash
npm install
cp .env.example .env   # Add GEMINI_API_KEY=<your-key>
npm run dev            # Runs Express + Vite dev server on http://localhost:3000
```

### Verification Gate (Run Before Every Commit / Merge)
```bash
npm run lint           # TypeScript strict check (tsc --noEmit)
npm run build          # Production Vite bundle check
npm test               # Vitest unit tests
```
- Verify interactive camera, microphone, and Shop MCP search flows in a real browser (and iPhone Safari over HTTPS for mobile changes) with zero console errors.

### Branching Convention
- Create focused feature branches per iterative milestone (e.g., `feat/camera-input-shopify-search`, `feat/neon-verification-engine`, `feat/decisions-api-router`, `feat/spatial-calibration`).
- Update the phase checkboxes in `specs.md` whenever a milestone lands so the spec always reflects reality.

---

## 7. MVP Acceptance Criteria

The full hackathon MVP is complete when a user on iPhone Safari (or desktop) can:
1. Grant camera and microphone permissions and see active capture + live audio volume feedback.
2. Pan across an unfamiliar desk, shelf, or empty wall while speaking naturally.
3. Watch structured shopping constraints update live—and see superseded constraints replaced cleanly on mid-sentence corrections.
4. Calibrate approximate available space with a known-size reference object where applicable.
5. Retrieve real Shopify products and compare **Standard Shopify Search** side-by-side against **SceneCart Verified** results.
6. Inspect exact `PASS` / `FAIL` / `UNKNOWN` constraint checks, including evidence extracted from product photos when listing text omits specs.
7. Select a real product variant and initiate a genuine Shopify purchase/checkout flow.
8. Export real evaluation logs comparing baselines against SceneCart with honest failure-case reporting.
