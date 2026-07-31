# Product model

vOps is a local control plane. Coding agents connect locally; target VPS hosts do
not run vOps or an agent. A capability is a semantic operation with a schema and
risk class. A session is short-lived authority scoped to one repository,
environment and optional targets. A plan is immutable input for one or more
capabilities. An approval belongs to one exact plan. An operation records
execution and verification.

The capability registry returned by `vops_list_capabilities` is authoritative. An
unlisted or unavailable capability must not be simulated.
