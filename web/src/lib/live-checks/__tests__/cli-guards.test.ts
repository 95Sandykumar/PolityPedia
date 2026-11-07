/**
 * The three tools' guard rails (issue 42-h3-live-check-tools).
 *
 * The tools themselves live in `web/jobs/live-checks/`, outside `src/`,
 * because they read `process.argv`, `process.env` and the disk. This file
 * reaches across to them on purpose: what it proves is the behaviour the issue
 * asks for and the behaviour that is easy to get wrong.
 *
 *  1. A missing key gives ONE line and a NON-ZERO exit, never a stack trace.
 *  2. No key VALUE is ever printed.
 *  3. The probe turns a 400 into a result instead of throwing.
 *
 * `fetch` is faked and `process.exit` is stubbed, so nothing here reaches
 * api.anthropic.com, nothing holds a real key and nothing stops the run
 * (web/CLAUDE.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flagNumber,
  readArgs,
  requireEnv,
  requireUuid,
} from '../../../../jobs/live-checks/shared';
import { probe } from '../../../../jobs/live-checks/search-probe';

/** What a stubbed `process.exit` throws, so the test can catch the stop. */
const EXITED = 'EXITED';

let exit: ReturnType<typeof vi.spyOn>;
let errors: string[];

beforeEach(() => {
  errors = [];
  exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`${EXITED}:${code}`);
  }) as never);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requireEnv', () => {
  const KEY = 'ANTHROPIC_API_KEY';
  const SERVICE = 'SUPABASE_SERVICE_ROLE_KEY';
  const SECRET = 'service-role-secret-value';

  it('stops with one line and exit code 1 when a key is missing', () => {
    const saved = { key: process.env[KEY], service: process.env[SERVICE] };
    delete process.env[KEY];
    process.env[SERVICE] = SECRET;

    try {
      expect(() => requireEnv([KEY, SERVICE])).toThrow(`${EXITED}:1`);
      expect(exit).toHaveBeenCalledWith(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].split('\n')).toHaveLength(1);
      expect(errors[0]).toContain(KEY);
      expect(errors[0]).toContain('web/.env.local');
      // The one thing that must never happen.
      expect(errors[0]).not.toContain(SECRET);
    } finally {
      if (saved.key === undefined) delete process.env[KEY];
      else process.env[KEY] = saved.key;
      if (saved.service === undefined) delete process.env[SERVICE];
      else process.env[SERVICE] = saved.service;
    }
  });

  it('says nothing and does not exit when every key is set', () => {
    const saved = process.env[KEY];
    process.env[KEY] = 'sk-ant-not-a-real-key';
    try {
      expect(() => requireEnv([KEY])).not.toThrow();
      expect(exit).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });
});

describe('readArgs', () => {
  it('splits positionals from flags, with a bare flag as true', () => {
    const args = readArgs(['paper.pdf', '--paper', 'abc', '--help']);
    expect(args.positional).toEqual(['paper.pdf']);
    expect(args.flags).toEqual({ paper: 'abc', help: true });
  });
});

describe('flagNumber', () => {
  it('takes a number in range and falls back when the flag is absent', () => {
    expect(flagNumber(readArgs(['--runs', '3']), 'runs', 1, 1, 5)).toBe(3);
    expect(flagNumber(readArgs([]), 'runs', 1, 1, 5)).toBe(1);
  });

  it('stops with exit code 1 on a number out of range', () => {
    expect(() => flagNumber(readArgs(['--runs', '99']), 'runs', 1, 1, 5)).toThrow(`${EXITED}:1`);
    expect(errors[0]).toContain('--runs');
  });
});

describe('requireUuid', () => {
  it('stops with one line on anything that is not a uuid', () => {
    expect(() => requireUuid('not-a-uuid', 'the paper id')).toThrow(`${EXITED}:1`);
    expect(errors[0]).toContain('the paper id');
    expect(errors[0].split('\n')).toHaveLength(1);
  });

  it('passes a uuid straight through', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(requireUuid(id, 'the paper id')).toBe(id);
  });
});

describe('probe', () => {
  const KEY = 'sk-ant-not-a-real-key';

  it('reads a 400 as a rejection and keeps the API error text', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 400,
          text: async () => 'tools.0.type: web_search_20260209 is not supported',
        }) as unknown as Response,
    );

    const attempt = await probe({ toolType: 'web_search_20260209', apiKey: KEY, fetchImpl });

    expect(attempt.accepted).toBe(false);
    expect(attempt.status).toBe(400);
    expect(attempt.error).toContain('not supported');
    // The request carried the key in a header, and the result does not.
    expect(JSON.stringify(attempt)).not.toContain(KEY);
  });

  it('reads a 200 as accepted, with no error text', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    const attempt = await probe({ toolType: 'web_search_20250305', apiKey: KEY, fetchImpl });
    expect(attempt).toEqual({
      toolType: 'web_search_20250305',
      status: 200,
      accepted: true,
      error: null,
    });
  });

  it('turns a dead network into a result, not a throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.anthropic.com');
    });
    const attempt = await probe({ toolType: 'web_search_20260209', apiKey: KEY, fetchImpl });
    expect(attempt.accepted).toBe(false);
    expect(attempt.status).toBe(0);
    expect(attempt.error).toContain('ENOTFOUND');
  });

  it('sends the key in a header and the tool type in the body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return { ok: true, status: 200 } as unknown as Response;
    });

    await probe({ toolType: 'web_search_20260209', apiKey: KEY, fetchImpl });

    const [call] = calls;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    // In a header, never in the URL: a URL ends up in logs and proxies.
    expect(call.url).not.toContain(KEY);
    expect((call.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);

    const body = JSON.parse(String(call.init.body)) as {
      model: string;
      tools: { type: string; name: string; max_uses: number }[];
    };
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }]);
  });
});
