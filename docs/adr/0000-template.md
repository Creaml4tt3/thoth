# ADR-NNNN: Title

- **Status:** Proposed | Accepted | Superseded by ADR-xxx
- **Date:** YYYY-MM-DD
- **Deciders:** (names or roles; optional)

## Context

What problem is being solved, what forces apply (product principles, locked
decisions in spec section 2, security, portability), and what constraints exist.
State facts; mark assumptions as assumptions.

## Decision

The decision, stated in the present tense ("Thoth stores...", "The server
returns..."). Use numbered or bulleted rules that can be tested. Do not include
decisions that have not been made; put them under Open questions.

## Consequences

- Positive: what becomes easier or safer.
- Negative: costs, limitations, accepted risks.
- Follow-up work this decision creates (packages, tests, other ADRs).

## Alternatives considered

Each alternative with a one-to-three line reason it was not chosen (or, for
Proposed ADRs, what would make it preferable).

## Spec references

Sections of the architecture handoff (`Thoth --- Architecture & MVP
Implementation Handoff`, v0.2) that this ADR implements or constrains, e.g.
"section 2 (locked decisions), section 6.2".

## Open questions

Unresolved items, each with what it blocks (a package, a phase, a release). Write
"None." if there are none.

---

### Template notes

- File name: `NNNN-kebab-case-title.md`, numbered in order of creation.
- Status values: `Proposed` (under discussion or not yet implemented),
  `Accepted` (baseline for implementation), `Superseded by ADR-xxx`.
  A status line may be qualified with a scope, for example "Accepted for X;
  Proposed for Y".
- An accepted ADR is not rewritten to change its decision. Write a new ADR and
  mark the old one "Superseded by ADR-xxx". Typos, link fixes, status changes
  and resolved open questions may be edited in place (note the change in the
  Open questions section).
- Any change to a locked decision in spec section 2 requires an ADR that
  explains the trade-off.
