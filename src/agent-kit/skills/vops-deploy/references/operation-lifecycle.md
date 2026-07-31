# Operation lifecycle

The normal flow is:

`proposed → awaiting_approval → approved → queued → running → verifying → succeeded`

Read-only or low-risk plans can skip approval. A failed operation contains a
stable error code and whether retry may help. Cancellation is cooperative.
Rollback is a distinct operation and is never implied by a failed deploy.

Approval is bound to a plan hash. If input changes, create and approve a new plan.
Never continue after `approval_required`, `denied`, `expired`, `paused` or
`revoked`.
