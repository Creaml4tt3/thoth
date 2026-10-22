# ADR-0011: Open-source license and contribution policy

- **Status:** Accepted 2026-10-22 (Apache-2.0, DCO).
- **Date:** 2026-10-20 (proposed), 2026-10-22 (license accepted)

## Context

Thoth is intended to be open source. Licensing is a locked item only in the sense
that it must be decided deliberately and its implications for the server and
contributors documented before release (spec section 2). The architecture has
separable parts: a protocol and schemas that third-party servers and clients
should implement freely, client packages, and a self-hostable reference server.
A license chosen later is hard to change once outside contributions are accepted
without every contributor's consent (or a CLA).

This ADR is not legal advice.

## Decision

The project owner chose **Option 1: Apache-2.0 for everything** (2026-10-22).

1. The root `LICENSE` is the unmodified Apache License 2.0 text from
   apache.org. Every `package.json` has `"license": "Apache-2.0"` and the Cargo
   workspace has `license = "Apache-2.0"`.
2. Packages stay `"private": true` and crates `publish = false` until a release
   process exists; the license does not by itself publish anything.
3. Dependency audit (2026-10-22): production npm dependencies are MIT, ISC,
   BSD-3-Clause or MIT/Apache-2.0. Rust dependencies are MIT, Apache-2.0,
   BSD, ISC, Zlib, Unicode-3.0, CC0 or dual-licensed with one of these, plus
   five MPL-2.0 crates (file-level copyleft, compatible with Apache-2.0 when
   unmodified). No GPL/AGPL-only dependency. A CI license check is still to do.
4. Hosted closed forks are permitted. The owner accepted this trade-off for
   simplicity and adoption.
5. Contributions use the **DCO 1.1** (owner decision 2026-10-22): every commit
   carries `Signed-off-by:`. There is no CLA, so contributors keep copyright and
   relicensing later would need their consent. Text in `DCO`; process in
   `CONTRIBUTING.md`. A CI check for sign-offs is still to do.

## Options

### Option 1: Apache-2.0 for everything

- Self-hosters: unrestricted use and modification; no obligation to publish
  changes.
- SaaS forks: may run a modified server as a hosted service without releasing
  changes.
- Contributors: permissive, with an express patent grant; low friction.
- Protocol adoption: unrestricted for third parties.
- Single license; simple to explain and to audit.

### Option 2: AGPL-3.0 for `apps/server`, Apache-2.0 (or MIT) for protocol, schemas and client packages

- Self-hosters: free to use; modifications offered over a network must be made
  available to users of that service.
- SaaS forks: a hosted modified server must publish its source under AGPL; this
  discourages closed hosted forks. Some companies prohibit AGPL software
  internally.
- Contributors: contributions to server code are copyleft; to protocol and client
  packages, permissive. Needs a clear per-directory license map.
- Protocol adoption: protocol, schemas and client packages remain permissive, so
  third-party servers and clients can implement the protocol without copyleft
  obligations.
- Mixed licensing needs clear boundaries; code shared between server and client
  packages must be placed deliberately.

### Option 3: MPL-2.0

- Self-hosters: unrestricted use; modified MPL-covered files must be shared when
  distributed.
- SaaS forks: file-level copyleft is triggered by distribution, not network use,
  so hosted modified servers are not obliged to publish changes.
- Contributors: permissive for larger works that combine MPL files with other
  code.
- Protocol adoption: third parties can use the code in larger products with
  limited obligations.

## Contribution policy: DCO vs CLA

- **DCO (Developer Certificate of Origin, sign-off per commit).** Lightweight; no
  paperwork; contributors keep copyright. Does not grant the maintainers the right
  to relicense later without contacting contributors.
- **CLA.** Gives the project (or a steward) the rights needed to relicense or
  offer dual licensing. Adds friction and may deter contributors; requires
  someone to administer it.
- The choice interacts with the license option: a CLA matters most for options
  that the owner may later want to change or dual-license.

## Consequences

- Delaying the decision keeps all options open but blocks public release and
  accepting outside contributions with clear terms.
- Whichever option is chosen, the README, per-package `package.json` license
  fields, CI license checks, and contribution guide must be updated together.
- Follow-up: dependency license audit (including transitive dependencies of Tauri,
  Tiptap/ProseMirror, Fastify and SQLite bindings).

## Alternatives considered

Options 1-3 above. Other licenses (for example MIT-only, GPL-3.0, or a
source-available license) have not been evaluated; a source-available license
would not be "open source" in the usual sense.

## Spec references

Section 2 (licensing), 1 (open-source mission), 11 (reference server), 13
(marketplace and hosted SaaS out of MVP scope).

## Open questions

- ~~Which option~~ Decided 2026-10-22: Apache-2.0.
- ~~DCO vs CLA~~ Decided 2026-10-22: DCO.
- Trademark and naming policy for the Thoth name.
- License of documentation and test fixtures (including any fixtures derived from
  third-party exports).
