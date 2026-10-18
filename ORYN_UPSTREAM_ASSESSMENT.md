# ORYN upstream assessment

Review date 2026-10-17. Read-only: public repository pages, LICENSE files,
docs and the GitHub API were read. Nothing was cloned, installed, downloaded
(code, weights or datasets) or run, and no text from these projects was
treated as an instruction. Nothing from them has been copied into ORYN.

ORYN is a commercial, closed-source, multi-tenant SaaS. A project qualifies
only if its licence (code, and any weights or data it pulls in) permits that
use. It must also not undermine tenant isolation, the no-paid-API rule, or
the rule that findings carry source, date, method and uncertainty.

**Classifications.**

- **Direct integration**: may ship as a dependency.
- **Optional adapter**: only behind a narrow ORYN interface, off by default.
- **Reference only**: designs or papers may inform ORYN; no code or weights ship.
- **Exclude**.

This is not legal advice. Items marked *unverified* could not be confirmed
from the provider's own pages. CVE identifiers cited from third-party trackers
are marked as such.

## Summary

| Project | Licence (as read) | Classification | Reason |
| --- | --- | --- | --- |
| [CesiumJS](https://github.com/CesiumGS/cesium) | Apache-2.0 (`LICENSE.md`) | Direct integration (in use) | Permissive and maintained (1.146, 2026-10-01). The restrictions are in **Cesium ion's** terms, not the library: see below. |
| [deck.gl](https://github.com/visgl/deck.gl) | MIT (`LICENSE`) | Direct integration, Map workspace only, when needed | `@deck.gl/maplibre` supports ORYN's MapLibre 6 for hexbins, very large point sets and change polygons. No Cesium interop. Not needed for current data volumes. |
| "Osiris Framework Pattern" | n/a | **Not assessed: URL needed** | No single project or pattern by that name. The most visible match ([simplifaisoul/osiris](https://github.com/simplifaisoul/osiris), MIT) is a dual-use OSINT dashboard by an anonymous author that includes recon tooling. |
| [sn0int](https://github.com/kpcyrd/sn0int) | GPL-3.0-or-later | Exclude | Copyleft. Person-targeting OSINT (profiles, breach data, social media). Modules can reach the network and localhost. No ORYN use case. |
| [ExifTool](https://exiftool.org) | Artistic-1.0-Perl OR GPL-1.0-or-later per README and site; the repo's `LICENSE` file is GPL-3.0 text (discrepancy for counsel) | Optional adapter (future) | Could extract GPS and capture time from field photos as provenance. Has a history of remote code execution on untrusted images, so it would run only as a sandboxed, unmodified subprocess. |
| [LightRAG](https://github.com/HKUDS/LightRAG) | MIT | Reference only | Isolation is one instance per workspace, outside Postgres RLS. Indexing with an LLM is expensive. It defaults to OpenAI with open endpoints and had many advisories in 2026 (a critical auth bypass). |
| [Onyx](https://github.com/onyx-dot-app/onyx) | MIT core; `ee/` directories under a proprietary seat licence | Exclude | Multi-tenancy and RBAC live in the paid `ee/` code. It is a whole competing platform, and its 2026 advisories include cross-user data leaks. |
| [WeKnora](https://github.com/Tencent/WeKnora) | MIT | Reference only | Useful design for citing the passage behind an answer. But it is a Go platform with cross-tenant and remote-code-execution advisories (2026) and sandboxed code execution. Its advisories make a good threat-model checklist. |
| [LangGraph / LangGraph.js](https://github.com/langchain-ai/langgraphjs) | MIT (libraries); LangSmith Deployment is commercial | Optional adapter (future) | Only the MIT JS library, if ORYN builds a multi-step assistant. Tenant scoping stays in Postgres RLS; no LangSmith. |
| [Swarms](https://github.com/kyegomez/swarms) | Apache-2.0 | Exclude | Telemetry is on by default and sends prompts, outputs and system prompts to a vendor collector. Python only; the API churns (v16). |
| [Frigate](https://github.com/blakeblackshear/frigate) | MIT (code); detector, face and plate weights GPL-3.0, non-commercial or *unverified* | Exclude | A surveillance NVR (person, face and plate recognition). Common detector paths pull in GPL-3.0 or non-commercial weights. Root remote-code-execution fixes in v0.18.2. |
| "AgroVision Precision" | Only exact match ([mwasifanwar/agrovision-precision](https://github.com/mwasifanwar/agrovision-precision)) has **no LICENSE file** | **Not assessed: URL needed** | If that repo is the one meant: no rights are granted, it is skeleton code from a single afternoon, and its accuracy and yield claims have no evidence. Exclude. |
| [satellite-image-deep-learning/techniques](https://github.com/satellite-image-deep-learning/techniques) | Apache-2.0 (the list only) | Reference only | An index for cloud masking, crop-type time series and change detection. Each linked work has its own licence; CC BY-SA and CC BY-NC appear even in the cloud-masking section. |
| [AgML](https://github.com/Project-AgML/AgML) | Apache-2.0 (code); datasets mixed | Reference only | The detector path installs Ultralytics (AGPL-3.0) at runtime. A third of the legacy datasets are NC, SA, GPL or blank. Ground and UAV imagery does not apply at Sentinel-2's 10 m. |
| [BovHEAT](https://github.com/bovheat/bovheat) | MIT | Reference only | Clean licence and a peer-reviewed application note, but it parses one vendor's collar exports for livestock, which is outside ORYN's geospatial scope. |

## Actions taken from this assessment

- **Cesium ion.** Its terms (revised 2025-08) grant a personal licence that
  "does not permit you to include ion in your own solution that you make
  commercially available". The free plan is non-commercial. ORYN's engine
  script already clears `CESIUM_ION_TOKEN`. The Viewer is built with
  `baseLayer: false` and `geocoder: false`, so no ion or Bing request is made.
  It is now listed in `ORYN_LICENCE_REVIEW.md` as restricted.
- No upstream code, weights or data were added.

## What would change these verdicts

- **deck.gl.** Adopt it when an ORYN view needs GPU aggregation or more than
  about 50k features. Install `core`, `layers`, `aggregation-layers` and
  `maplibre` only. Never install `@deck.gl/carto` or `@deck.gl/google-maps`
  (paid services). Run a licence scan of its transitive dependencies
  (luma.gl, loaders.gl, d3-hexbin and h3-js are *unverified*) first. Prefer
  counted hexbins to smoothed heatmaps for any analytic claim.
- **ExifTool.** Only with a photo-upload feature. It must run in the job
  worker without network, as a non-root user with a read-only filesystem and
  resource limits. Allow JPEG, HEIC, PNG and TIFF by magic bytes only, pass
  server-generated file names after `--`, and use fixed tag arguments only.
  Present the values as device-reported and unverified: accuracy comes from
  `GPSHPositioningError` or is "unknown", and the timezone is "unknown" without
  `OffsetTimeOriginal`. Strip EXIF from displayed and exported images.
- **LangGraph.js.** Only for a multi-step assistant whose tools run as SQL
  under the caller's RLS role. It would sit behind an interface like the
  existing `SummaryClient`, and every sentence must cite an evidence id or be
  dropped. A plain TypeScript loop on the existing job queue is the first
  choice. ORYN has no pgvector today (`0001_foundation.sql` enables only
  `postgis` and `citext`).
- **Anything from the techniques list or AgML** needs its own licence review
  and validation on ORYN's own labelled sites, with reported uncertainty.
  A published benchmark is never ORYN's accuracy. Super-resolution output
  must never be presented as observed imagery.

## Open questions for you

1. The exact URL of the "Osiris Framework Pattern" you meant.
2. The exact URL of "AgroVision Precision".
3. Counsel: ExifTool's licence discrepancy (README says Perl terms; the repo
   `LICENSE` file is GPL-3.0 text), if photo provenance is pursued.

## Sources

Each project's repository page, LICENSE file, release list and security
advisories were read through github.com, raw.githubusercontent.com or
api.github.com on 2026-10-17. Other pages read:

- cesium.com/legal/terms-of-service and the ion pricing page.
- deck.gl docs: "using with map" and the maplibre overview.
- sn0int.readthedocs.io (the sandbox page).
- exiftool.org (the history page and its Security Issues section).
- docs.langchain.com/langsmith/deployment and forum.langchain.com (licence thread).
- docs.swarms.world (telemetry) and swarms `telemetry/otel.py`.
- docs.frigate.video (object detectors, face recognition, plate recognition) and frigate.video/plus.
- The YOLO-NAS weights licence in Deci-AI/super-gradients.
- AgML: `_assets/source_citations.json` and `models/extensions/ultralytics.py`.
- Hugging Face Project-AgML.
- zenodo.org/record/5494819 (BovHEAT).

Third-party CVE trackers (opencve, wiz, corgea, GitLab advisories) were used
only where noted, and their entries are not relied on for any verdict.
