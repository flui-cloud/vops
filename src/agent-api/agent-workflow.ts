import { ApprovalClass } from '../safety/approval-gate';
import { NextAction } from './agent-envelope';

/** The stages of a vops deployment, as a coding agent should walk them — a map, not an engine.
 * Stages vops doesn't perform (repo analysis, template choice) are marked `owner: 'agent'` so the
 * boundary stays legible from the CLI itself. */

export type StageOwner = 'agent' | 'vops' | 'user';

export interface WorkflowStage {
  id: string;
  title: string;
  owner: StageOwner;
  approval: ApprovalClass;
  description: string;
  commands: string[];
}

export interface WorkflowDescriptor {
  id: string;
  title: string;
  description: string;
  stages: WorkflowStage[];
}

const CUSTOM_APP: WorkflowDescriptor = {
  id: 'custom-app',
  title: 'Deploy a custom application from this repository',
  description:
    'The agent understands the repository; vops supplies the infrastructure. ' +
    'Every command below takes --json and exits with a code you can branch on (0 ok, 2 bad input, 3 invalid spec, 4 missing prerequisite, 5 approval required, 7 auth).',
  stages: [
    {
      id: 'discover',
      title: 'Check what this vops can do',
      owner: 'agent',
      approval: 'A',
      description: 'Never assume a capability exists — this build may be older or newer than the skill.',
      commands: ['vops agent capabilities --json', 'vops --version'],
    },
    {
      id: 'init',
      title: 'Initialise the project',
      owner: 'vops',
      approval: 'A',
      description: 'Creates .vops/ for plans, reports and provenance. Changes nothing remote.',
      commands: ['vops agent init --json'],
    },
    {
      id: 'analyse',
      title: 'Analyse the repository',
      owner: 'agent',
      approval: 'A',
      description:
        'Framework, build and start commands, ports, health endpoint, env and secrets, databases, volumes, migrations. ' +
        'vops does not do this and must not be asked to.',
      commands: [],
    },
    {
      id: 'template',
      title: 'Pick a template and building blocks',
      owner: 'agent',
      approval: 'A',
      description: 'vops lists the options; choosing the one that matches the repository is your call.',
      commands: [
        'vops spec templates --json',
        'vops spec templates describe <template-id> --json',
        'vops catalog blocks --json',
      ],
    },
    {
      id: 'generate',
      title: 'Generate the base flui.yaml',
      owner: 'vops',
      approval: 'A',
      description: 'Deterministic: the same inputs produce the same bytes. Never writes a secret value.',
      commands: ['vops spec generate --template <template-id> --name <app> --output-file flui.yaml --json'],
    },
    {
      id: 'contextualise',
      title: 'Adapt flui.yaml to the repository',
      owner: 'agent',
      approval: 'A',
      description:
        'Port, health path, start command, env declarations, volumes, resource limits. ' +
        'Secret VALUES never go in the file — declare them and pass them at deploy with --set.',
      commands: ['vops spec validate flui.yaml --json'],
    },
    {
      id: 'image',
      title: 'Get an image to deploy',
      owner: 'user',
      approval: 'B',
      description:
        'vops never builds. Either point at an image that already exists, or set up the GitHub Actions build ' +
        '(vops writes the workflow; you commit and push it, then the run publishes to GHCR).',
      commands: [
        'vops build setup --spec flui.yaml --json',
        'vops build run --wait --json',
        'vops build status --json',
      ],
    },
    {
      id: 'host',
      title: 'Choose or provision the server',
      owner: 'user',
      approval: 'C',
      description: 'Creating a server costs money and needs explicit approval. An existing host can be imported instead.',
      commands: ['vops host list --json', 'vops compare --json', 'vops servers create --help', 'vops host import --help'],
    },
    {
      id: 'plan',
      title: 'Create an immutable deployment plan',
      owner: 'vops',
      approval: 'A',
      description:
        'Writes .vops/plans/<id>.json with a content hash. Summarise it for the user and ask before applying — ' +
        'the plan is re-derived at apply time and refuses to run if anything changed.',
      commands: ['vops deploy plan --spec flui.yaml --host <host> --image <ref> --json'],
    },
    {
      id: 'apply',
      title: 'Deploy the approved plan',
      owner: 'user',
      approval: 'C',
      description:
        'Persistent change. Runs only the plan the user approved. Rolls back on a failed unit or a failed smoke test.',
      commands: ['vops deploy apply --plan <plan-id> --yes --json'],
    },
    {
      id: 'harden',
      title: 'Harden the server',
      owner: 'user',
      approval: 'C',
      description: 'Can lock you out. Plan first, explain the recovery path, apply only on explicit approval.',
      commands: ['vops host status <host> --json', 'vops host harden <host> --help', 'vops host ssh-harden <host> --help'],
    },
    {
      id: 'verify',
      title: 'Verify the deployment',
      owner: 'vops',
      approval: 'A',
      description:
        'Do not report success because the deploy command exited 0. Check containers, health, the public URL, DNS and TLS.',
      commands: ['vops deploy verify --app <name> --json', 'vops app status <name> --json', 'vops app logs <name> --json'],
    },
  ],
};

/** A separate workflow because "what is running and is it healthy" isn't a deployment — walking
 * the deploy stages to answer it would waste turns. Every command here is read-only. */
const FLEET: WorkflowDescriptor = {
  id: 'fleet',
  title: 'Inspect what is deployed and whether it is healthy',
  description:
    'Read-only. Nothing here changes state, costs money, or prompts for a passphrase. ' +
    'Findings travel in the envelope `warnings[]`, so read those and not only `data`.',
  stages: [
    {
      id: 'inventory',
      title: 'What exists',
      owner: 'vops',
      approval: 'A',
      description: 'Hosts vops knows about, and everything deployed on them.',
      commands: ['vops host list --json', 'vops app list --json'],
    },
    {
      id: 'health',
      title: 'Whether it is healthy',
      owner: 'vops',
      approval: 'A',
      description:
        'In --json a sick host still exits 0: the probe succeeded and the findings are the answer. ' +
        'Human output exits non-zero so shell scripts can gate on it.',
      commands: [
        'vops host status <host> --json',
        'vops app status <name> --json',
        'vops ingress status <host> --json',
        'vops backup status <host> --json',
      ],
    },
    {
      id: 'diagnose',
      title: 'Why something is down',
      owner: 'agent',
      approval: 'A',
      description: 'Read the logs and the host readiness before proposing any change.',
      commands: ['vops app logs <name> --json', 'vops app preflight <host> --json'],
    },
  ],
};

export const WORKFLOWS: WorkflowDescriptor[] = [CUSTOM_APP, FLEET];

export function findWorkflow(id: string): WorkflowDescriptor | null {
  return WORKFLOWS.find((w) => w.id === id) ?? null;
}

/** The stage commands as envelope `nextActions`. */
export function stageActions(stage: WorkflowStage): NextAction[] {
  return stage.commands.map((command) => ({ command, description: stage.title }));
}
