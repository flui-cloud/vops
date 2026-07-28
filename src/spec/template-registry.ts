/** The framework templates vops can generate a base `flui.yaml` from. Every entry is derived from
 * the matching public `flui-cloud/flui-template-*` repo (port, health path, runtime read off its
 * own `flui.yaml`/`Dockerfile`, not guessed); `sourceRepo` lets it be re-verified against its origin. */

export type TemplateRuntime = 'node' | 'python' | 'java' | 'dotnet' | 'static';

export interface FrameworkTemplate {
  /** Stable id used by `vops spec generate --template <id>`. */
  id: string;
  /** Revision of the vops-side template, bumped when the generated shape changes. */
  version: string;
  name: string;
  framework: string;
  runtime: TemplateRuntime;
  description: string;
  /** Container port the template's Dockerfile serves on. */
  port: number;
  /** Health endpoint the template's own app exposes. */
  healthPath: string;
  /** Dockerfile path relative to the build context. */
  dockerfile: string;
  /** Base images the reference Dockerfile uses, for the agent to match against the repo. */
  baseImages: string[];
  /** Things this template does NOT solve — surfaced by `templates describe`. */
  limitations: string[];
  /** Public repository the template was derived from. */
  sourceRepo: string;
}

/** Bumped when a field is added to the descriptor shape itself. */
export const TEMPLATE_CATALOG_VERSION = '1.0.0';

const NGINX_STATIC_LIMITS = [
  'Serves a pre-built static bundle through nginx — there is no server-side runtime, so server env vars are not readable at runtime.',
  'Values the browser must see have to be baked at build time via build.args, not deploy.env.',
];

export const FRAMEWORK_TEMPLATES: FrameworkTemplate[] = [
  {
    id: 'nestjs-11',
    version: '1.0.0',
    name: 'NestJS 11',
    framework: 'nestjs',
    runtime: 'node',
    description: 'NestJS API served by Node, multi-stage build, health endpoint at /health.',
    port: 3000,
    healthPath: '/health',
    dockerfile: './Dockerfile',
    baseImages: ['node:24-alpine'],
    limitations: ['Database migrations are not run by vops — declare them as a postInstall step or run them yourself.'],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-nestjs-11',
  },
  {
    id: 'nextjs-16',
    version: '1.0.0',
    name: 'Next.js 16',
    framework: 'nextjs',
    runtime: 'node',
    description: 'Next.js in standalone output mode, health route at /api/health.',
    port: 3000,
    healthPath: '/api/health',
    dockerfile: './Dockerfile',
    baseImages: ['node:24-alpine'],
    limitations: [
      'NEXT_PUBLIC_* values are inlined at build time — pass them as build.args, not deploy.env.',
      'Requires `output: "standalone"` in next.config for the reference Dockerfile to work.',
    ],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-nextjs-16',
  },
  {
    id: 'nuxt-4',
    version: '1.0.0',
    name: 'Nuxt 4',
    framework: 'nuxt',
    runtime: 'node',
    description: 'Nuxt Nitro server bundle run by Node, health route at /api/health.',
    port: 3000,
    healthPath: '/api/health',
    dockerfile: './Dockerfile',
    baseImages: ['node:24-alpine'],
    limitations: ['Only the Node Nitro preset is covered; other presets need their own Dockerfile.'],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-nuxt-4',
  },
  {
    id: 'sveltekit-2',
    version: '1.0.0',
    name: 'SvelteKit 2',
    framework: 'sveltekit',
    runtime: 'node',
    description: 'SvelteKit built with adapter-node, health route at /api/health.',
    port: 3000,
    healthPath: '/api/health',
    dockerfile: './Dockerfile',
    baseImages: ['node:24-alpine'],
    limitations: ['Assumes @sveltejs/adapter-node; static or serverless adapters do not apply.'],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-sveltekit-2',
  },
  {
    id: 'astro-5',
    version: '1.0.0',
    name: 'Astro 5',
    framework: 'astro',
    runtime: 'static',
    description: 'Astro static build served by nginx on port 80.',
    port: 80,
    healthPath: '/health',
    dockerfile: './Dockerfile',
    baseImages: ['node:24-alpine', 'nginx:1.27-alpine'],
    limitations: [...NGINX_STATIC_LIMITS, 'Astro SSR output needs the Node runtime instead — start from the generic template.'],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-astro-5',
  },
  {
    id: 'angular-21',
    version: '1.0.0',
    name: 'Angular 21',
    framework: 'angular',
    runtime: 'static',
    description: 'Angular production bundle served by nginx on port 80.',
    port: 80,
    healthPath: '/health',
    dockerfile: './Dockerfile',
    baseImages: ['node:24-alpine', 'nginx:1.27-alpine'],
    limitations: [...NGINX_STATIC_LIMITS, 'Angular SSR (@angular/ssr) needs the Node runtime — start from the generic template.'],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-angular-21',
  },
  {
    id: 'vue-vite-3',
    version: '1.0.0',
    name: 'Vue 3 + Vite',
    framework: 'vue',
    runtime: 'static',
    description: 'Vue 3 Vite bundle served by nginx on port 80.',
    port: 80,
    healthPath: '/health',
    dockerfile: './Dockerfile',
    baseImages: ['node:24-alpine', 'nginx:1.27-alpine'],
    limitations: NGINX_STATIC_LIMITS,
    sourceRepo: 'https://github.com/flui-cloud/flui-template-vue-vite-3',
  },
  {
    id: 'vitepress-1',
    version: '1.0.0',
    name: 'VitePress 1',
    framework: 'vitepress',
    runtime: 'static',
    description: 'VitePress documentation site served by nginx on port 80.',
    port: 80,
    healthPath: '/health',
    dockerfile: './Dockerfile',
    baseImages: ['node:24-alpine', 'nginx:1.27-alpine'],
    limitations: NGINX_STATIC_LIMITS,
    sourceRepo: 'https://github.com/flui-cloud/flui-template-vitepress-1',
  },
  {
    id: 'django-5',
    version: '1.0.0',
    name: 'Django 5',
    framework: 'django',
    runtime: 'python',
    description: 'Django served by gunicorn, health endpoint at /health/.',
    port: 8000,
    healthPath: '/health/',
    dockerfile: './Dockerfile',
    baseImages: ['python:3.13-slim'],
    limitations: [
      'migrate / collectstatic are not run by vops — declare them as a postInstall step or run them yourself.',
      'ALLOWED_HOSTS must include the hostname the app is exposed on, or Django returns 400.',
    ],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-django-5',
  },
  {
    id: 'fastapi',
    version: '1.0.0',
    name: 'FastAPI',
    framework: 'fastapi',
    runtime: 'python',
    description: 'FastAPI served by uvicorn, health endpoint at /health.',
    port: 8000,
    healthPath: '/health',
    dockerfile: './Dockerfile',
    baseImages: ['python:3.13-slim'],
    limitations: ['Background workers are a second component — vops deploys one container per Application manifest.'],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-fastapi',
  },
  {
    id: 'spring-boot-3',
    version: '1.0.0',
    name: 'Spring Boot 3',
    framework: 'spring-boot',
    runtime: 'java',
    description: 'Spring Boot fat jar on a JRE base, actuator health at /actuator/health.',
    port: 8080,
    healthPath: '/actuator/health',
    dockerfile: './Dockerfile',
    baseImages: ['maven:3.9-eclipse-temurin-21', 'eclipse-temurin:21-jre-alpine'],
    limitations: [
      'The reference Dockerfile builds with Maven; a Gradle project needs its build stage swapped.',
      'The JVM needs headroom — a 1 GB host is tight for this runtime.',
    ],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-spring-boot-3',
  },
  {
    id: 'aspnet-core-10',
    version: '1.0.0',
    name: 'ASP.NET Core 10',
    framework: 'aspnet-core',
    runtime: 'dotnet',
    description: 'ASP.NET Core on the aspnet runtime image, health endpoint at /health.',
    port: 8080,
    healthPath: '/health',
    dockerfile: './Dockerfile',
    baseImages: ['mcr.microsoft.com/dotnet/sdk:10.0', 'mcr.microsoft.com/dotnet/aspnet:10.0'],
    limitations: ['ASPNETCORE_URLS must match deploy.port, or the container listens somewhere the health check does not look.'],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-aspnet-core-10',
  },
  {
    id: 'generic',
    version: '1.0.0',
    name: 'Generic Dockerfile',
    framework: 'generic',
    runtime: 'node',
    description: 'Any repository that already has (or will have) its own Dockerfile. Nothing framework-specific is assumed.',
    port: 3000,
    healthPath: '/health',
    dockerfile: './Dockerfile',
    baseImages: [],
    limitations: ['Nothing is inferred: port, health path and start command all have to be set for the repository.'],
    sourceRepo: 'https://github.com/flui-cloud/flui-template-generic',
  },
];

export function findTemplate(id: string): FrameworkTemplate | null {
  return FRAMEWORK_TEMPLATES.find((t) => t.id === id) ?? null;
}

export function templateIds(): string[] {
  return FRAMEWORK_TEMPLATES.map((t) => t.id);
}
