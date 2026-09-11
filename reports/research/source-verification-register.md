# Source Verification Register

Status: complete bounded audit for D01 on 2026-09-11 UTC  
Machine-readable record: `source-verification-register.json`  
Scope: the 50 references already cited by `RESEARCH.md`, plus a targeted 2024–2026
update search

## Decision

All 50 existing locators resolve to identifiable source records. The automated
network replay returned 41 HTTP 200 responses, two HTTP 202 responses from an
official publisher, and seven HTTP 403 responses after the DOI had successfully
resolved to a publisher access-control page. There were no unresolved citations.
Resolution is not treated as claim verification.

The machine-readable register records, for every reference, publication status,
inspection depth, the exact support retained by this project, the limiting caveat,
and an inclusion decision. Nine load-bearing sources were inspected in full:
[11], [14], [22], [26], [27], [42], [43], [49], and [50]. Source [15] was also
inspected in full because it was attached to an overstrong claim.

Two corrections are required and have been applied to the manuscript:

- [15] supports unsupervised learned discrete communication, partial
  interpretability, and novel-class generalization in its evaluated setting. It
  does not supply the causal symbol-intervention evidence previously attributed
  to it. Causal-listening motivation remains grounded in [11].
- [26]'s official record gives pages 116–140, not 116–143.

The review found no defensible basis for a first, only, or unique claim. The
project's candidate contribution must be expressed as a tested combination and
incremental-value question, not priority.

## Evidence-depth policy

| Label | What was actually checked | Permitted use |
|---|---|---|
| `metadata` | Primary repository, DOI, proceedings, or publisher bibliographic record | Existence, title, venue, year, and a narrow historical precedent only |
| `abstract` | Metadata plus the source abstract | The abstract's explicitly stated scope and high-level result only |
| `description` | Official description of a book or framework | Normative/contextual framing only |
| `full-text` | Searchable full paper or complete standard inspected at the relevant sections | Only the specific support and limitations recorded in JSON |

Venue prestige never upgrades evidence depth. Review articles are used for field
maps and discovery, not as replacements for primary experimental papers. Standards
define mechanisms; they do not demonstrate that this implementation is correct.
Institutional items [46] and [47] are process sources, not independent scientific
evidence. Preprint [48] motivates only an exploratory experiment and cannot support
a security claim.

## Query and retrieval log

This was a bounded update and citation audit, not a systematic review. One screener
performed it, no dual-screening agreement was measured, and no claim of exhaustive
coverage is made.

| Time (UTC) | Source surface | Exact query or operation | Outcome |
|---|---|---|---|
| 2026-09-11 19:29–19:31 | All 50 manuscript URLs | Concurrent GET, redirect enabled, 15-second timeout, descriptive user agent | 50/50 resolved to an identifiable source; response classes recorded in JSON |
| 2026-09-11 | Web search over primary repositories | `site:openreview.net emergent communication survey TMLR 2026 LGsed0QQVq` | Located the February 2026 TMLR survey S01 |
| 2026-09-11 | Web search over primary repositories | `site:openreview.net/forum emergent communication language agents TMLR 2025 2026` | Screened broad multi-agent communication results; retained S01 |
| 2026-09-11 | ACL Anthology | `site:aclanthology.org emergent communication large language models 2025` | Reconfirmed [27] and its official proceedings status |
| 2026-09-11 | PMLR | `site:proceedings.mlr.press emergent communication continuous setting 2024` | Retained S05 as a close channel/causal-bias comparator |
| 2026-09-11 | OpenReview/web index | `"emergent communication" "Survey Certification" TMLR 2026` | Reconfirmed S01's publication status and retrieved full text |
| 2026-09-11 | ACL Anthology | `site:aclanthology.org "Beyond Natural Language" "Alternative Formats"` | Retained S03 as a close prompted-carrier comparator |
| 2026-09-11 | Official journal and full-text archive | `"Towards Human-Like Emergent Communication via Utility, Informativeness, and Complexity"` | Retained S04 as a close learned-signal comparator |
| 2026-09-11 | Official proceedings | `"Shaping Shared Languages" emergent communication IJCAI 2025` | Retained S02 as a close pretrained/mixed-partner comparator |

The update window was 2024-01-01 through 2026-09-11. Candidate records were included
when an official publisher, proceedings, repository, or archival full-text record
showed direct relevance to at least one of: learned communication infrastructure,
causal listening, learned carriers, pretrained-language-model communication,
cross-partner transfer, reproducibility, or tamper-evident records. Records were
excluded when they merely used communication as a generic systems term, concerned
single-agent dialogue memory, lacked an identifiable primary record, duplicated an
included work, or had no direct bearing on the registered questions.

## Updated-search inclusions

| Key | Source and inspected scope | Why retained | Boundary |
|---|---|---|---|
| S01 | [The Five Ws of Multi-Agent Communication](https://openreview.net/forum?id=LGsed0QQVq), full text, TMLR 2026 | Current taxonomy across learned multi-agent communication, emergent language, and language-model systems | Survey, not primary evidence for a project result |
| S02 | [Shaping Shared Languages](https://www.ijcai.org/proceedings/2025/1144), abstract, IJCAI 2025 | Direct pretrained and mixed-partner artificial-language comparator | Human-involved study; outside this project's synthetic-only collection |
| S03 | [Beyond Natural Language](https://aclanthology.org/2024.findings-emnlp.623/), full text, Findings 2024 | Prompted language-model selection of alternative communication formats | Format selection from pretrained priors is not de-novo carrier learning |
| S04 | [Towards Human-Like Emergent Communication](https://pmc.ncbi.nlm.nih.gov/articles/PMC11984795/), full text, journal 2025 | Learned discrete signals in continuous space with explicit utility/informativeness/complexity pressures | Does not contain this project's evidence-ledger and audit design |
| S05 | [An Inductive Bias for Emergent Communication in a Continuous Setting](https://proceedings.mlr.press/v233/villanger24a.html), full text, NLDL 2024 | Explicit positive-signaling/listening biases for continuous and discrete channels | Two toy environments; no tamper-evident scientific record |

## Reproducibility and unresolved requirements

Run `pnpm audit:sources` with the Homebrew toolchain on `PATH` to check register
structure, exact [1]–[50]
coverage, the two manuscript corrections, and updated-search completeness. The
network replay is intentionally not part of the default build because live publisher
availability is nondeterministic.

D01 is complete as an internal, bounded audit. Submission still requires an
independent human to reopen every load-bearing source, inspect claim-level placement
in the frozen manuscript, and record disagreements. A systematic-review claim would
require a separately registered multi-database protocol, deduplication record,
dual screening, and exclusion flow; none is claimed here.
