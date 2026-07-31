# Diagnose a deployment

Start with read-only evidence: application status, recent bounded logs and health
check. Correlate timestamps and report the smallest supported cause. A restart is
a mutation and needs an approved plan. Do not open an interactive shell or run
arbitrary SSH commands through the agent surface.
