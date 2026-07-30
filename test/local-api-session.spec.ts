import { ExecutionContext } from '@nestjs/common';
import { Request, Response } from 'express';
import { RootController } from '../src/local-api/root.controller';
import { SessionGuard, SESSION_COOKIE } from '../src/local-api/session.guard';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

interface ReqInit {
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

function req(init: ReqInit = {}): Request {
  return {
    path: init.path ?? '/',
    query: init.query ?? {},
    headers: init.headers ?? {},
  } as unknown as Request;
}

function res(): { minted: string[]; response: Response } {
  const minted: string[] = [];
  const response = {
    cookie: (name: string, value: string) => {
      if (name === SESSION_COOKIE) minted.push(value);
    },
  } as unknown as Response;
  return { minted, response };
}

describe('local-api session', () => {
  const controller = new RootController();
  const guard = new SessionGuard();
  const prev = process.env.VOPS_SESSION;

  beforeEach(() => {
    process.env.VOPS_SESSION = TOKEN;
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.VOPS_SESSION;
    else process.env.VOPS_SESSION = prev;
  });

  it('serves the shell without minting a cookie for a request with no proof of the token', () => {
    const { minted, response } = res();
    expect(controller.root(req(), response)).toContain('<html');
    expect(minted).toEqual([]);
    expect(guard.canActivate(ctx(req({ path: '/api/providers' })))).toBe(false);
  });

  it('does not mint for a wrong query token or a stale cookie', () => {
    const bad = res();
    controller.root(req({ query: { session: 'not-the-token' } }), bad.response);
    expect(bad.minted).toEqual([]);

    const stale = res();
    controller.root(req({ headers: { cookie: `${SESSION_COOKIE}=stale-token` } }), stale.response);
    expect(stale.minted).toEqual([]);
  });

  it('mints for the printed `?session=` URL, and the cookie then opens /api', () => {
    const { minted, response } = res();
    controller.root(req({ query: { session: TOKEN } }), response);
    expect(minted).toEqual([TOKEN]);

    const api = req({ path: '/api/providers', headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` } });
    expect(guard.canActivate(ctx(api))).toBe(true);
  });

  it('refreshes the cookie for the installed app, whose start_url carries no token', () => {
    const { minted, response } = res();
    controller.root(req({ headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` } }), response);
    expect(minted).toEqual([TOKEN]);
  });
});

function ctx(request: Request): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
