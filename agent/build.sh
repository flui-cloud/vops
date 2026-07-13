#!/bin/sh
# Cross-compile the vops metrics agent (static, CGO off) for linux amd64+arm64 and
# emit dist/manifest.json with per-arch sha256 — the same trust-anchor shape as the
# restic manifest. Run where a Go toolchain is available: `sh agent/build.sh`.
set -e
cd "$(dirname "$0")"
VERSION="${VERSION:-0.1.0}"
OUT=dist
mkdir -p "$OUT"

for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
    go build -trimpath -ldflags "-s -w -X main.Version=$VERSION" \
    -o "$OUT/vops-agent-linux-$arch" .
done

{
  printf '{\n  "version": "%s",\n  "binaries": {\n' "$VERSION"
  first=1
  for arch in amd64 arm64; do
    sha=$(shasum -a 256 "$OUT/vops-agent-linux-$arch" | awk '{print $1}')
    [ $first -eq 0 ] && printf ',\n'
    printf '    "%s": { "path": "vops-agent-linux-%s", "sha256": "%s" }' "$arch" "$arch" "$sha"
    first=0
  done
  printf '\n  }\n}\n'
} > "$OUT/manifest.json"

echo "built $OUT/vops-agent-linux-{amd64,arm64} + manifest.json (v$VERSION)"
