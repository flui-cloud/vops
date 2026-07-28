/** The GitHub Actions workflow vops writes into the user's repository. vops never builds — a 1 GB
 * VPS is a deployment target, not a build machine — so the image builds on GitHub-hosted runners
 * and is pushed to GHCR; kept close to flui.api's hosted workflow so both produce the same artifact. */

export const WORKFLOW_PATH = '.github/workflows/vops-build.yml';
/** Marker vops looks for before overwriting a file it did not write. */
export const MANAGED_MARKER = '# vops-managed';

export interface WorkflowParams {
  owner: string;
  repo: string;
  /** Branch a push to which triggers a build. */
  branch: string;
  /** Dockerfile path relative to the build context. */
  dockerfile: string;
  /** Build context relative to the repository root. */
  context: string;
  /** Docker build ARGs from the manifest — env-independent, baked into the image. */
  buildArgs?: Record<string, string>;
}

/** `ghcr.io/<owner>/<repo>` — lowercased, because GHCR rejects uppercase paths. */
export function imageName(owner: string, repo: string): string {
  return `ghcr.io/${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** The immutable tag a given commit produces: the short SHA, as the workflow tags it. */
export function imageTagForSha(sha: string): string {
  return sha.slice(0, 7);
}

export function renderWorkflow(p: WorkflowParams): string {
  const args = Object.entries(p.buildArgs ?? {});
  const argLines = args.map(([k, v]) => `            ${k}=${v}`).join('\n');
  const buildArgsBlock = args.length ? `\n          build-args: |\n${argLines}` : '';

  return `${MANAGED_MARKER} — regenerate with: vops build setup
name: vops build

on:
  push:
    branches: [${p.branch}]
  workflow_dispatch:

env:
  IMAGE_NAME: ${imageName(p.owner, p.repo)}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: \${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix=,format=short
            type=raw,value=latest
          labels: |
            org.opencontainers.image.source=https://github.com/\${{ github.repository }}
            org.opencontainers.image.revision=\${{ github.sha }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ${p.context}
          file: ${p.dockerfile}
          push: true
          tags: \${{ steps.meta.outputs.tags }}
          labels: \${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max${buildArgsBlock}

      - name: Image reference
        run: echo "\${{ env.IMAGE_NAME }}:$(echo \${{ github.sha }} | cut -c1-7)" >> "$GITHUB_STEP_SUMMARY"
`;
}

/** `owner/repo` from any GitHub remote URL form (ssh, https, with or without .git). */
export function parseRepoSlug(remote: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}
