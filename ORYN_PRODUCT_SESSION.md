# ORYN product session: workspace states, accessibility and customer wording

Date 2026-10-17, branch `feat/oryn-pilot-hardening` (local only). This
follows the pilot-hardening work recorded at the top of
`ORYN_AUDIT_AND_ROADMAP.md`. ORYN-WEBSITE was not modified. The public
website pages under `web/src/app/(marketing)` and `(auth)` were not changed.

## Phase 1: baseline

- Started at commit `cc46d412`. The only uncommitted change was yours in
  `web/next.config.ts` (`ORYN_DEV_ORIGINS`). It is preserved and still
  uncommitted.
- Before this phase, all suites passed:
  - web unit: 350 passed;
  - integration: 124 passed;
  - e2e: 26 passed;
  - engine: 7,707 passed, 0 failed.
- Servers ran on loopback only: engine on 127.0.0.1:5180, web on
  127.0.0.1:3000. No tunnel.

## Phase 2: product trace (RUN)

Method: every workspace page was opened as an organization administrator of
the synthetic Sample Farms organization, at 1440×900 and 390×844. axe-core
4.10.2 checked WCAG 2.0/2.1 A and AA in the browser; it was loaded from cdnjs
into the test browser only, never into ORYN. The trace also recorded
horizontal overflow and page or console errors. Missing records and
permission-gated pages were probed as an administrator and as a viewer.

| Finding | Evidence | Who it affects |
| --- | --- | --- |
| Opening a report, alert or area that does not exist returned **HTTP 500** ("A server error occurred") and dropped the navigation. This included a mistyped link, a deleted record, or another organization's id. | Probe: 4 of 4 record URLs returned 500. The services throw a 404 `DomainError` that pages did not translate. | Everyone who follows an old link or email |
| The workspace had no error or loading boundary. Any server failure replaced the whole shell, and navigation showed no progress. | No `error.tsx` or `loading.tsx` under `app/(platform)` | Everyone |
| **154 elements failing serious axe rules** across the 13 workspace pages. Most are low-contrast secondary text (bone-50 at 40–45% is 3.5–4.2:1, below 4.5:1) and table headers. On phones, 4 tables scrolled sideways but could not be reached from the keyboard. | axe run, before the change | Government and municipal buyers: WCAG 2.1 AA is commonly required in public-sector procurement (US Section 508, EU EN 301 549, and the 2024 ADA Title II rule for state and local government web content). Also anyone reading on a phone outdoors. |
| Wording for organization kinds was decided separately on each page. Business (`enterprise`) organizations saw "Change review" in the navigation but "Inspection queue" on the page. Public-sector bodies were called "Municipal". | Code: `layout.tsx` and `detections/page.tsx` used different conditions | Businesses, real estate, public sector |
| Pages a role cannot use (audit, processing, settings) already explain themselves inside the shell, and non-members get a plain 404. No overflow at phone width, no page errors. | Probe as viewer; trace | — |
| The Intelligence globe requests two engine routes ORYN never forwards: local receivers and voice debug log. Both return 404 and the engine degrades as designed. | Network capture | Console noise only |

## Phase 3: upstream assessment

See `ORYN_UPSTREAM_ASSESSMENT.md`. Results for the 14 named projects:

- **None ships in ORYN now.**
- CesiumJS stays (in use). Cesium ion is restricted and is now recorded in
  the licence review; its token was already cleared.
- deck.gl: direct integration in the Map workspace, but only when data
  volumes need it.
- ExifTool and LangGraph.js: optional adapters for future features (photo
  provenance; a multi-step assistant).
- LightRAG, WeKnora, the techniques list, AgML and BovHEAT: reference only.
- sn0int, Onyx, Swarms and Frigate: excluded.
- Osiris and AgroVision Precision need exact URLs.

## Phase 4: direction

The improvement had to help all four customer types, rest on measured gaps,
and need no new data, paid service, dependency or upstream code. These four
findings above meet that bar:

- the record 500s;
- the missing boundaries;
- the WCAG failures;
- the kind-specific wording.

Feature ideas from the upstream review would need new dependencies, untrusted
input handling or validation data. They are left as documented options.

## Phase 5: plan (as built)

1. **Record pages.** `getPageRecord()` in `web/src/server/authz/next.ts`
   turns a missing, out-of-scope or forbidden record into the org's
   not-found page. Applied to alert, area and report pages.
2. **Workspace boundaries.** Under `app/(platform)/app/[org]/`:
   - `not-found.tsx` renders inside the shell and does not say whether the
     record exists;
   - `error.tsx` keeps the shell and shows only Next's digest as a reference,
     never server details, with Try again;
   - `loading.tsx` adds a status skeleton.
3. **Contrast.**
   - Workspace secondary text goes from bone-50 at 40–45% to 55%, and table
     headers to 60%.
   - Placeholders go from 30% to 50%.
   - Exempt by WCAG: one decorative glyph, and labels of disabled controls.
   - The website's original globe file (unused) is untouched.
4. **Tables.** Each `Table` is a named, keyboard-focusable scroll region. All
   21 tables have names.
5. **Wording.** `web/src/lib/org-profile.ts` is the one source for
   per-kind labels and starting choices:
   - Agriculture and municipal wording is unchanged.
   - Businesses get "Sites & areas" and "Change review" everywhere.
   - Public-sector and infrastructure bodies are no longer called municipal.

**Trade-off.** With a loading boundary, pages stream. A missing record inside
a member's org therefore returns status 200 with a `noindex` tag and the
not-found page, not a 404. Previously it returned a 500. Non-members still
get a real 404, because membership is checked in the layout before streaming.

6. **Found while verifying.** The municipal upload e2e test failed once: a
   file chosen before the upload form hydrated was never read, because the
   change event fired before React attached its handler. Streaming from the
   new loading boundary makes that window more likely on slow devices.
   `UploadImport` now reads a file that is already selected when it
   hydrates, once.

## Phase 7: verification (RUN, 2026-10-17)

| Check | Result |
| --- | --- |
| axe-core WCAG 2.0/2.1 A+AA, 15 workspace pages × 1440 and 390 px, plus the map with an area and a season-comparison finding open, plus the Intelligence globe | **0 violations**, down from 154 failing elements. No horizontal overflow, no page errors. The globe page logs the two expected 404s noted above. |
| Missing report, malformed alert id, another org's area id (as a member) | "This record isn't available" inside the shell (was HTTP 500 without the shell) |
| Non-member opening another org's record | HTTP 404, site page, no shell (unchanged) |
| Viewer on audit, processing and settings pages | Explanatory notices inside the shell (unchanged) |
| `web` unit (`npm test`) | 361 passed, 9 skipped |
| `web` integration (`npm run test:integration`, tenant isolation) | 124 passed, 4 skipped |
| `web` e2e (`npx playwright test`, own `oryn_e2e` database) | 29 passed |
| `web` typecheck (`tsc --noEmit`), lint (`eslint .`) | pass |
| New tests failing before the change | Contrast source scan: HEAD had 143 sub-50% text classes and 21 unnamed tables. Early-file e2e: fails with the fix disabled, passes with it. Record pages: `getPageRecord` did not exist (the probe showed 500s). |
| Municipal upload test repeated 5× in one seeded database | The upload and preview step passed 5/5. Repeats 2–5 then fail at the final link check because each repeat adds another "Permit 2026-114" area (the test is not written to repeat); full runs re-seed and pass. |

The engine was not changed in this phase. Its last full run on this branch
(7,707 passed, 0 failed) and the licence-clean build check stand.

## Not done, and why

- **Engine requests to `/api/local-receivers/aircraft` and
  `/api/realtime/debug-log`.** These return 404 under ORYN, and the engine
  degrades as designed. Silencing them means threading host options through
  two engine subsystems; left for a dedicated engine change.
- **New agriculture areas still default to Open-Meteo**, which the licence
  gate turns off by default. The AOI form shows it as unavailable. Deciding
  whether to drop it from the defaults is a product decision.
- **A true 404 status for missing records inside a member's org.** It would
  require removing the loading boundary (see the trade-off above).
- **Upstream features** (deck.gl hexbins, ExifTool photo provenance, an
  assistant): each needs a decision and, for ExifTool, a sandbox. See
  `ORYN_UPSTREAM_ASSESSMENT.md`.
