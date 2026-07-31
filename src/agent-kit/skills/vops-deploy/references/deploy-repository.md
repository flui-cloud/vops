# Deploy a repository

1. Inspect the repository and read or generate `flui.yaml`.
2. Validate the specification.
3. Inspect candidate targets and current application state.
4. Create an `application.plan_deploy` plan with explicit success criteria.
5. Present effects, exclusions and rollback limitations.
6. Wait for local approval when requested.
7. Execute `application.deploy`, then check application status and health.

Do not embed application secret values in the plan. Refer only to declared secret
names and let vOps resolve values through its local credential boundary.
