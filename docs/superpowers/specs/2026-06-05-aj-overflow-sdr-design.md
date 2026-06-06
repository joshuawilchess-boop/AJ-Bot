# AJ → Overflow Revive Autonomous SDR — Design Spec

**Date:** 2026-06-05
**Status:** Approved design, pre-implementation
**Owner:** Josh
**Repo:** joshuawilchess-boop/AJ-Bot (`feature/overflow-sdr`)

---

## 1. Purpose & North Star

Make AJ genuinely **agentic** — holding a goal, breaking it into steps, running tool-use loops on its own, and following up over days — in service of one concrete job: **acting as an autonomous SDR for Overflow Revive.**

Priority ranking that frames every decision:

1. **Operator / COO (primary)** — AJ does real autonomous revenue work for Josh's businesses.
2. **X personality (secondary)** — the real work becomes build-in-public content.
3. **Product (tertiary)** — the capability becomes sellable later.

We design for #1. #2 and #3 are downstream beneficiaries, addressed only by a thin optional hook.

**Today's AJ is reactive + scheduled** (answers Telegram, posts on approval, scans mentions every 30 min, morning briefing). That is *automation*. This spec moves AJ toward *agentic*: goal-directed, multi-step, self-deciding, persistent.

### Overflow Revive context

AI-powered, done-for-you **revenue recovery** service. Performance-based (% of recovered revenue). ICP: **e-commerce / SaaS businesses doing $50k–$500k/month.** Has a customer-facing **dashboard/app** (relevant later, see §9). The e-commerce side is the primary target for v1.

---

## 2. Scope

### In scope (v1)
Autonomous **cold-email** SDR pipeline: source → qualify → research → draft → QA → human-approve → send → reply-watch → follow-up, with niche sales craft (objection handling, per-business tailoring, anti-spam quality gate).

### Out of scope (deferred)
- Live integration with the Overflow dashboard/app (see §9 — knowledge first, integration later).
- Autonomous sending without human approval (trust boundary is approve-each, §4).
- X DM / LinkedIn / multi-channel outreach (email only for v1).
- Closing / call handling beyond booking intent.

---

## 3. Key Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| North star | Operator/COO first | Real substance feeds personality + product |
| Top job | Sales pipeline for Overflow Revive | Highest-value, revenue-generating |
| Trust boundary | **Draft + queue, Josh approves each** | Low risk; reuses existing X-post approval flow |
| Lead entry | **AJ sources from an ICP** | Most agentic; AJ fills the pipeline |
| Channel | **Cold email** | B2B standard; existing Outlook/Gmail via Make.com |
| Architecture | **Approach C: state-machine skeleton + LLM judgment per node** | Reliability of a state machine + intelligence where it matters |
| Overflow integration | **Knowledge first, live integration deferred** | Outbound doesn't need live product data |
| Sourcing stack | **Validate cheap first** (free preview + generic emails), swappable adapters | Prove outreach quality before spending |
| Sales craft | **Encoded playbook + QA gate** | Pro SDR, not generic spam |

---

## 4. Trust Boundary

AJ does **all** research and drafting autonomously, then **queues each outreach email for one-tap approval in Telegram** (yes / no / edit) — identical UX to the existing X-post approval flow. Josh is the send button. On *yes*, AJ sends via the existing Make.com email rail. Replies are surfaced to Josh, never auto-answered without approval (follow-ups are also drafted-and-queued).

---

## 5. Architecture — Approach C

Deterministic, observable **state machine**; **LLM judgment inside each node** for the work that needs intelligence. Each lead advances one stage per tick. State lives in a `leads` table (§6). The whole pipeline is visible on the dashboard (§8).

### Stages

```
sourced → qualified → researched → drafted → (QA) → queued → sent → replied → followup → won / lost
```

### Nodes

| Node | Type | What it does |
|---|---|---|
| **Hunt** | cron + adapter | `LeadSource.search(ICP)` → real e-comm stores in the revenue band → insert as `sourced`. |
| **Qualify** | LLM | Score each `sourced` lead against the ICP rubric → `icp_score` (0–100) + `qualification_notes`. Drop lows; promote to `qualified`. |
| **Research** | LLM + fetch | Deep-dive the store (site, socials, revenue-leak signals). **Must extract a true, specific personalization hook + a revenue-leak hypothesis** for *that* store → `research_json`, stage `researched`. |
| **Draft** | LLM | Write a personalized cold email grounded in research + Sales Playbook. Framework-structured, <120 words, no links on first touch → `draft`, stage `drafted`. |
| **QA / Critique** | LLM | Skeptical second pass role-playing the busy founder (see §7.3). Pass → `queued`; fail → one rewrite back to Draft. **The anti-generic safeguard.** |
| **Queue** | Telegram | yes / no / edit (reuses `pending_x_posts` pattern). On *yes* → send via Make.com → `sent`. |
| **Reply-watch** | inbound + LLM | Existing email→Make.com inbound classifies replies (interested / objection / not-now / no) → `replied`, ping Josh. |
| **Follow-up** | LLM | For non-replies, decide cadence + draft next touch (objection-aware) → back to Queue. |

---

## 6. Data Model

New table `leads`:

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `company` | text | |
| `domain` | text | unique-ish; dedupe key |
| `contact_name` | text | nullable |
| `contact_email` | text | from EmailFinder adapter |
| `email_status` | text | `generic` / `verified` / `unknown` |
| `source` | text | adapter name (e.g. `storeleads`) |
| `icp_score` | int | 0–100 from Qualify |
| `qualification_notes` | text | LLM reasoning |
| `stage` | text | enum per §5 |
| `research_json` | jsonb | hook, revenue-leak hypothesis, signals |
| `draft` | text | current outreach draft |
| `last_action_at` | timestamptz | |
| `next_action_at` | timestamptz | drives follow-up cadence |
| `reply_text` | text | latest inbound reply |
| `airtable_id` | text | sync to Airtable (existing pattern) |

Reuses existing patterns: `pending_x_posts`-style approval queue, Airtable sync, cron checker.

---

## 7. Pro-SDR Sales Craft

The differentiator: AJ is an experienced SDR, not a mail-merge. Three mechanisms.

### 7.1 Overflow Sales Playbook (expansion of the "Overflow Brain")

A structured KB record (`category='overflow_brain'`) holding everything AJ reasons against:

- **Offer & mechanism** — what Overflow does, how it recovers revenue, performance-based model.
- **ICP & qualification rubric** — who's a fit, scoring criteria.
- **Dashboard walkthrough** — text + screenshots of the customer app (so AJ pitches credibly: "here's exactly what you'd get").
- **Proof bank** — case studies / numbers, deployed *selectively* by prospect.
- **Niche objection matrix** — pre-built, tailored responses to objections these e-comm founders actually raise:
  - *"We already run abandoned-cart / email flows"* → you're still leaving recoverable revenue your current setup misses; we only touch the gap.
  - *"We have an in-house team / agency"* → we complement, paid only on incremental recovery.
  - *"Performance-based — what's the catch?"* → aligned incentives, we lose if you lose; here's the mechanics.
  - *"We don't have a revenue problem"* → here's the specific leak we spotted on your store (ties to research).
  - *"Just send info"* → offer a 2-line teardown specific to them, not a deck.
  - *"No budget / not interested"* → zero upfront is the whole point; soft de-risk.
- **Cold/warm email frameworks** — Observation → specific problem → relevant proof → one soft CTA. <120 words. No links on first touch (deliverability).
- **Voice rules** — founder-to-founder, sharp, specific. Banned buzzwords/superlatives. No "I hope this finds you well."
- **Spam-avoidance checklist** — deliverability (no spam-trigger words, minimal links first touch, plain text, proper unsubscribe) + "feels-human" (must reference something true & specific to this business; no mail-merge vibes).

### 7.2 Research-anchored personalization

The Research node **must** output a true, specific hook and a revenue-leak hypothesis unique to that store (e.g. "no post-purchase upsell," "no win-back flow," "checkout friction"). The Draft node anchors the email on it. An email that could be sent to any store fails QA.

### 7.3 QA / Critique gate

A skeptical LLM pass role-playing a busy founder who gets 20 pitches/day, scoring the draft on:

1. **Would I reply?**
2. **Is this specific to me, or could it be sent to anyone?** (mail-merge detector)
3. **Any spam triggers?** (deliverability + feel)
4. **Is the ask one clear, low-friction step?**

Below threshold → bounce to Draft for exactly one rewrite, then re-QA. Only survivors reach Josh's approval queue.

### 7.4 Objection-aware replies & follow-ups

Reply-watch classifies the objection type; Follow-up drafts a tailored, in-character response using the objection matrix — never canned.

---

## 8. Observability

New **"Pipeline"** card on the (already-working) dashboard: counts per stage, plus today's drafted / sent / replied. Reuses the existing `/api/dashboard` + array-of-strings dashboard pattern.

---

## 9. Overflow Integration Strategy

**Knowledge now, live integration deferred.** Overflow has a dashboard/app, but outbound SDR doesn't need live product data. AJ *understands* the dashboard via the walkthrough in the Sales Playbook (§7.1). Live API/data integration is a separate, well-bounded later phase — earns its keep when AJ moves downstream (reporting recovered-revenue, qualifying off real store metrics, client onboarding).

---

## 10. Sourcing Stack — Validate Cheap First

Built behind **swappable adapters** so upgrading is config, not a rewrite.

- **`LeadSource` interface** → `StoreLeadsAdapter`.
  - *Now:* Store Leads free/limited preview.
  - *Later:* Store Leads Pro API (~$250/mo; ~$450 Elite for all platforms). Best e-commerce fit — per-store estimated monthly revenue maps to the $50–500k band; has REST API **and** an MCP server.
  - Web/X demoted to enrichment/warming signal, not primary source. No scraping (ToS/fragility); API only.
- **`EmailFinder` interface** → `GenericEmailAdapter`.
  - *Now:* Store Leads' generic emails (`info@`, `support@`).
  - *Later:* `ProspeoAdapter` (~$39/mo, cheap, ~98% claimed) or `HunterAdapter` (mature) for find + verify.

**Validation path:** prove the loop produces high-quality, objection-aware, personalized drafts on the free tier first; flip to paid Store Leads + email-finder once quality is demonstrated.

### Open items to verify in a Store Leads trial before paying
1. Can you **filter by a revenue range** ($50k–$500k/mo) as a query, vs. only seeing it per-record?
2. **Email coverage/quality** on a sample of the target segment (generic-only; no published verification rate).

### Researched alternatives (for reference)
- **Apollo.io** — great for SaaS/B2B + verified emails + revenue-band filter, but **weak on small DTC Shopify stores**. Back-pocket if Overflow leans SaaS.
- **BuiltWith** (list-builder, no emails/revenue), **Clay** (UI-first, expensive, overkill for a code agent) — skipped for v1.

---

## 11. Unique Hook (optional, toggle-off)

On a milestone (first reply / call booked), AJ auto-**drafts** a build-in-public X post about it into the existing X approval queue. One function, reuses both queues, off by default. This is where Operator work (#1) starts generating personality content (#2).

---

## 12. Phasing

1. **Overflow Brain / Sales Playbook** (§7.1) — step 0, everything reasons against it.
2. **`leads` table + Pipeline dashboard card** (§6, §8).
3. **Swappable adapters on free tier** (§10).
4. **Core loop:** Qualify → Research → Draft → QA → Queue (§5, §7) — the core value.
5. **Reply-watch + Follow-up** (§5, §7.4).
6. **Prove quality, then flip to paid** Store Leads + email-finder (§10).
7. *(optional)* Build-in-public hook (§11).
8. *(later)* Live dashboard integration (§9).

---

## 13. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Auto-sourcing returns junk leads | Qualify node scores + drops; human approves every send |
| Emails feel generic / land as spam | Research-anchored personalization + QA gate (§7.2–7.3) |
| Generic emails hurt deliverability/reply rate | Validate-cheap proves quality before paid email-finder; spam checklist |
| Store Leads revenue-range filter unconfirmed | Verify in trial before paying (§10 open items) |
| LLM loops / runaway cost | State-machine bounds each tick to one stage per lead; no open-ended agent loop |
| Real prospects contacted in error | Approve-each trust boundary; nothing sends without Josh |

---

## 14. Success Criteria (v1)

- AJ autonomously fills the `leads` table with ICP-matched e-comm stores.
- Every queued email is research-anchored, framework-structured, objection-aware, and QA-passed.
- Josh approves/sends from Telegram with one tap; replies are classified and surfaced.
- Pipeline state is visible on the dashboard.
- Outreach quality is demonstrably non-generic *before* any paid tooling is switched on.
