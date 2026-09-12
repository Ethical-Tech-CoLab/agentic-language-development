# Repository-Native Research Registration

Status: approved activation mechanism under `ALD-GOV-2026-09-12-01`  
Scope: synthetic, zero-spend experiments in this repository

## Purpose

The registration mechanism fixes each experiment's question, parameters, seeds,
analysis, models, host, scenario, exclusions, stopping rules, and evidence policy
before outcomes are collected. It uses immutable Git history and the deterministic
in-memory commitment transport; it requires no real funds, public chain, hosted
service, or private credential.

## Required sequence

1. Resolve all eleven canonical binding classes and compile the packet.
2. Commit the packet unchanged to Git before any eligible outcome is observed.
3. Create a binding with `registrationAuthority: "repository-native"`, the packet
   path, the 40-hex registration commit, its commit time, and the exact canonical
   `preRegistrationHash`.
4. Require the registration commit to be an ancestor of the execution commit.
5. Load the packet from `registrationCommit:path`, recompute its canonical hash, and
   require equality with the binding and `RunConfig`.
6. Commit the same hash through the deterministic in-memory transport before the run
   enters `running`; record the confirmed simulated receipt in the run manifest.
7. Execute from a clean tree and preserve the exact software commit, run manifest,
   all dispositions, and verifier reports.

Any protocol change creates a new packet, hash, registration commit, binding, and run
IDs. A registered packet is never overwritten. A packet registered after its outcomes
were observed is retrospective and ineligible for confirmatory claims.

## What the mechanism establishes

- exact registered bytes and canonical hash;
- immutable ancestry relative to the later execution commit;
- deterministic pre-run consumption and receipt replay;
- detectable packet, binding, receipt, ordering, and evidence mutations;
- a reproducible audit path using only repository history and local software.

## What it does not establish

Git commit metadata is controlled by the repository operator. This mechanism does
not establish an independently witnessed time, third-party custody, decentralized
persistence, public availability, economic finality, hosted branch enforcement,
independent human review, or independent replication. Reports must state those limits.
Third-party registration or archival timestamping can be added later as a stronger
publication artifact without changing the experiment's agent-language estimands.

## Example binding shape

```json
{
  "registrationClass": "confirmatory",
  "registrationAuthority": "repository-native",
  "preRegistrationHash": "sha256:<64 lowercase hex characters>",
  "repositoryRegistration": {
    "commit": "<40 lowercase hex characters>",
    "path": "protocols/<experiment>-registration.v1.json",
    "artifactSha256": "sha256:<same 64 lowercase hex characters>",
    "committedAt": "<ISO-8601 commit time>"
  },
  "preRunAnchor": {
    "anchorClass": "simulated",
    "network": "base-sepolia",
    "chainId": 84532,
    "transactionHash": "0x<64 lowercase hex characters>",
    "inputData": "0x<the registered 64-hex digest>",
    "blockNumber": 1,
    "status": "confirmed"
  },
  "label": "confirmatory: repository-registered before run start"
}
```

The network and chain ID are deterministic compatibility labels, not claims that a
public network was contacted. Every receipt remains explicitly `simulated`.
