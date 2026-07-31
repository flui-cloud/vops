# Targets and credentials

A target names a host already known to vOps. Discover it with target tools and
pass its identifier, never connection details invented from repository files.

Credentials are opaque local references. Agents may learn whether a required
credential exists, but cannot retrieve its value. Provider credentials stay in
the encrypted local vault; application secrets are supplied by the human or
generated on the host. Private SSH keys never enter plans or MCP responses.
