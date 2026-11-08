// Bedrock vision adapter (CAP-39) with the Bedrock and S3 clients mocked — never the network. Spec: ADR-004 step 2,
// ADR-008 §7 (prompt = EXCHANGE_INSTRUCTIONS + EXCHANGE_FIELD_SCHEMA + known; the model returns `response` only),
// shared exchange.ts (parseExchangeUpload → normaliseResponseFields), data-model.md § Scan (tokens, cost).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import type { GetObjectCommand, GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { EXCHANGE_FIELD_SCHEMA, EXCHANGE_INSTRUCTIONS, Scan, emptyExchangeResponse } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/lib/config.js';
import { ValidationError } from '../src/lib/http.js';
import { newId } from '../src/lib/ids.js';
import { createMemoryRepositories } from '../src/lib/repo/memory.js';
import { analyse } from '../src/lib/scans.js';
import { StubVisionAdapter, createVisionAdapter, setVisionAdapter } from '../src/lib/vision/adapter.js';
import { MIN_BRAND_CONFIDENCE, parseAnswer, stripFences, suggestionsFrom } from '../src/lib/vision/answer.js';
import {
  BEDROCK_TIMEOUT_MS,
  BedrockVisionAdapter,
  MAX_TOKENS,
  type BedrockAdapterOptions,
} from '../src/lib/vision/bedrock.js';
import { FAKE_FIXTURES_DIR, FakeVisionAdapter } from '../src/lib/vision/fake.js';
import { PRICE_TABLE, costUsd, priceFor } from '../src/lib/vision/prices.js';
import { useAwsTestEnv } from './support/aws-env.js';

const UID = 'apple-sub-1';
const MODEL = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const BUCKET = 'cap-dev-images';
const TOP_KEY = `${UID}/${newId()}/top.webp`;
const UNDER_KEY = `${UID}/${newId()}/underside.webp`;
const TOP_BYTES = new Uint8Array([1, 2, 3]);
const UNDER_BYTES = new Uint8Array([4, 5, 6]);

useAwsTestEnv();
afterEach(() => setVisionAdapter(undefined));

const answer = (fields: Record<string, unknown>, confidence: Record<string, unknown> = { brand: 0.9 }) =>
  JSON.stringify({ provider: null, model: null, fields, confidence, notes: null });

const converseOut = (text: string, usage = { inputTokens: 1200, outputTokens: 150 }) =>
  ({ output: { message: { role: 'assistant', content: [{ text }] } }, usage }) as unknown as ConverseCommandOutput;

/** A Bedrock mock answering each call with the next reply (an Error is thrown), plus an S3 mock over two objects. */
function setup(replies: (string | Error | ConverseCommandOutput)[], over: Partial<BedrockAdapterOptions> = {}) {
  const calls: { command: ConverseCommand; signal?: AbortSignal }[] = [];
  const bedrock = {
    send: vi.fn(async (command: ConverseCommand, opts?: { abortSignal?: AbortSignal }) => {
      calls.push({ command, ...(opts?.abortSignal ? { signal: opts.abortSignal } : {}) });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      if (r instanceof Error) throw r;
      return typeof r === 'string' ? converseOut(r) : r;
    }),
  };
  const objects: Record<string, Uint8Array> = { [TOP_KEY]: TOP_BYTES, [UNDER_KEY]: UNDER_BYTES };
  const s3 = {
    send: vi.fn(async (c: GetObjectCommand) => {
      const bytes = objects[c.input.Key!];
      if (!bytes) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      return { Body: { transformToByteArray: async () => bytes } } as unknown as GetObjectCommandOutput;
    }),
  };
  const log = vi.fn<(e: Record<string, unknown>) => void>();
  const adapter = new BedrockVisionAdapter({ bedrock, s3, bucket: BUCKET, modelId: MODEL, log, ...over });
  return { adapter, calls, bedrock, s3, log };
}

const awsError = (name: string, httpStatusCode?: number) =>
  Object.assign(new Error(name), { name, ...(httpStatusCode ? { $metadata: { httpStatusCode } } : {}) });

describe('vision: Bedrock adapter', () => {
  it('[T-api-058] request shape: Converse with system = EXCHANGE_INSTRUCTIONS, top then underside WebP bytes from S3, schema + known + empty response; 600 tokens, temperature 0, 8 s abort', async () => {
    const { adapter, calls, s3 } = setup([answer({ brand: 'Mahou' })]);
    const known = { brand: 'Mahou', country: 'ES' as const };
    await adapter.identify({ imageKeys: { top: TOP_KEY, underside: UNDER_KEY }, known });

    expect(s3.send.mock.calls.map(([c]) => c.input)).toEqual([
      { Bucket: BUCKET, Key: TOP_KEY },
      { Bucket: BUCKET, Key: UNDER_KEY },
    ]);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.command.input;
    expect(input.modelId).toBe(MODEL);
    expect(input.system).toEqual([{ text: EXCHANGE_INSTRUCTIONS }]);
    expect(input.inferenceConfig).toEqual({ maxTokens: MAX_TOKENS, temperature: 0 });
    expect(MAX_TOKENS).toBe(600);
    const [msg] = input.messages!;
    expect(msg!.role).toBe('user');
    const [top, under, text] = msg!.content!;
    expect(top).toEqual({ image: { format: 'webp', source: { bytes: TOP_BYTES } } });
    expect(under).toEqual({ image: { format: 'webp', source: { bytes: UNDER_BYTES } } });
    expect(msg!.content).toHaveLength(3);
    expect(text!.text).toContain('Photos attached in this order: top, underside.');
    expect(text!.text).toContain(JSON.stringify(EXCHANGE_FIELD_SCHEMA));
    expect(text!.text).toContain(`Already known, do not contradict (\`known\`): ${JSON.stringify(known)}`);
    expect(text!.text).toContain(JSON.stringify(emptyExchangeResponse()));
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(BEDROCK_TIMEOUT_MS).toBe(8000);

    // Top only, no known fields: one image, `known` = {}.
    const one = setup([answer({ brand: 'Mahou' })]);
    await one.adapter.identify({ imageKeys: { top: TOP_KEY } });
    const content = one.calls[0]!.command.input.messages![0]!.content!;
    expect(content).toHaveLength(2);
    expect(content[1]!.text).toContain('Photos attached in this order: top.');
    expect(content[1]!.text).toContain('(`known`): {}');

    // A key that was never uploaded is the client's mistake (422), and Bedrock is not called.
    const missing = setup([answer({ brand: 'Mahou' })]);
    await expect(missing.adapter.identify({ imageKeys: { top: `${UID}/${newId()}/top.webp` } })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(missing.bedrock.send).not.toHaveBeenCalled();
    const s3Down = setup([answer({ brand: 'Mahou' })]);
    s3Down.s3.send.mockRejectedValueOnce(awsError('InternalError', 500));
    await expect(s3Down.adapter.identify({ imageKeys: { top: TOP_KEY } })).rejects.toThrow('InternalError');
  });

  it('[T-api-059] fenced JSON + unknown field → parsed through the exchange path (normalised, `ignored` reported); missing provider/model tolerated; a full document is read too', async () => {
    const fenced =
      '```json\n' +
      JSON.stringify({
        fields: {
          brand: ' Estrella Galicia ',
          variant: null,
          country: 'Spain',
          type: 'lager',
          material: 'aluminum',
          closure: 'crown',
          year: '1906',
          textOnCap: 'ESTRELLA GALICIA 1906',
          colour: 'red',
        },
        confidence: { brand: 0.88, country: 0.7, year: null },
      }) +
      '\n```';
    const { adapter, log } = setup([fenced]);
    const r = await adapter.identify({ imageKeys: { top: TOP_KEY } });
    expect(r).toEqual({
      status: 'identified',
      aiModel: MODEL,
      fields: {
        brand: 'Estrella Galicia',
        country: 'ES',
        type: 'beer',
        material: 'aluminium',
        closure: 'pry-off',
        year: 1906,
        textOnCap: 'ESTRELLA GALICIA 1906',
      },
      confidence: { brand: 0.88, country: 0.7 },
      aiConfidence: 0.88,
      ignored: ['colour'],
      problems: [],
      usage: { inputTokens: 1200, outputTokens: 150, costEstimateUsd: 0.00195 },
    });
    expect(log).toHaveBeenCalledWith({
      level: 'warn',
      event: 'vision.normalise',
      status: 'identified',
      ignored: ['colour'],
      problems: [],
    });

    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('  {"a":1} ')).toBe('{"a":1}');
    const doc = parseAnswer(
      JSON.stringify({
        format: 'capcollector.exchange',
        version: 1,
        kind: 'request',
        requestId: newId(),
        createdAt: '2026-11-08T10:00:00.000Z',
        photos: [{ file: 'top.webp', side: 'top', dhash: 'a3f0c81e7b2d9f44' }],
        instructions: EXCHANGE_INSTRUCTIONS,
        schema: EXCHANGE_FIELD_SCHEMA,
        response: { provider: 'x', model: null, fields: { brand: 'Mahou' }, confidence: { brand: 1 } },
      }),
    );
    expect(doc).toMatchObject({ ok: true, normalised: { fields: { brand: 'Mahou' } } });
    expect(parseAnswer('[]')).toEqual({ ok: false, problem: 'answer is a batch, expected one response' });
    expect(parseAnswer('"text"')).toEqual({ ok: false, problem: 'answer is not a JSON object' });
    expect(parseAnswer('{"format":"other"}')).toEqual({
      ok: false,
      problem: 'answer does not match the response schema: unknown format or version',
    });
    expect(parseAnswer('{"fields": 3}')).toEqual({
      ok: false,
      problem: 'answer does not match the response schema: fields',
    });
  });

  it('[T-api-060] brand confidence < 0.4 or no brand → unidentified with up to 5 distinct brand-like suggestions from textOnCap', async () => {
    expect(MIN_BRAND_CONFIDENCE).toBe(0.4);
    const low = setup([
      answer(
        { brand: 'Ambar', textOnCap: '...AMBAR — Zaragoza 1900 ambar, Cerveza Especial, La Zaragozana S.A., Since' },
        { brand: 0.39 },
      ),
    ]);
    expect(await low.adapter.identify({ imageKeys: { top: TOP_KEY } })).toMatchObject({
      status: 'unidentified',
      aiModel: MODEL,
      suggestions: ['AMBAR', 'Zaragoza', 'Cerveza', 'Especial', 'Zaragozana'],
      aiConfidence: 0.39,
      usage: { inputTokens: 1200, outputTokens: 150 },
    });

    // Exactly 0.4 is enough.
    const edge = setup([answer({ brand: 'Ambar' }, { brand: 0.4 })]);
    expect(await edge.adapter.identify({ imageKeys: { top: TOP_KEY } })).toMatchObject({ status: 'identified' });

    // No brand at all (null): aiConfidence 0, suggestions still read from the text; no text → none.
    const none = setup([answer({ brand: null, textOnCap: 'Cruzcampo' }, { brand: null })]);
    expect(await none.adapter.identify({ imageKeys: { top: TOP_KEY } })).toMatchObject({
      status: 'unidentified',
      suggestions: ['Cruzcampo'],
      aiConfidence: 0,
    });
    const blank = setup([answer({ brand: 'X-Brand' }, {})]);
    expect(await blank.adapter.identify({ imageKeys: { top: TOP_KEY } })).toMatchObject({
      status: 'unidentified',
      suggestions: [],
      aiConfidence: 0,
    });

    expect(suggestionsFrom('33 cl · 5,4% · 1906')).toEqual([]);
    expect(suggestionsFrom("Mahou mahou MAHOU 'Five-Star' Ål")).toEqual(['Mahou', 'Five-Star']);
    expect(suggestionsFrom(undefined)).toEqual([]);
  });

  it('[T-api-061] throttling, 5xx, the 8 s timeout and misconfiguration → unavailable (503 path); malformed JSON gets one retry, then unidentified with problems logged at warn (no answer text)', async () => {
    for (const e of [awsError('ThrottlingException', 429), awsError('ModelTimeoutException'), awsError('Boom', 503)]) {
      const { adapter, log } = setup([e]);
      expect(await adapter.identify({ imageKeys: { top: TOP_KEY } })).toEqual({
        status: 'unavailable',
        reason: `bedrock ${e.name}`,
      });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', event: 'vision.unavailable' }));
    }
    const denied = setup([awsError('AccessDeniedException', 403)]);
    expect(await denied.adapter.identify({ imageKeys: { top: TOP_KEY } })).toEqual({
      status: 'unavailable',
      reason: 'bedrock misconfigured: AccessDeniedException',
    });
    expect(denied.log).toHaveBeenCalledWith({
      level: 'error',
      event: 'vision.unavailable',
      error: 'AccessDeniedException',
      httpStatus: 403,
    });
    const odd = setup(['unused']);
    odd.bedrock.send.mockRejectedValueOnce('not an error');
    expect(await odd.adapter.identify({ imageKeys: { top: TOP_KEY } })).toMatchObject({ status: 'unavailable' });

    // The real abort signal: a call that never answers is cut at the timeout.
    const hang = setup([], { timeoutMs: 20 });
    hang.bedrock.send.mockImplementationOnce(
      (_c, opts) =>
        new Promise((_, reject) =>
          opts!.abortSignal!.addEventListener('abort', () => reject(opts!.abortSignal!.reason as Error)),
        ),
    );
    expect(await hang.adapter.identify({ imageKeys: { top: TOP_KEY } })).toEqual({
      status: 'unavailable',
      reason: 'bedrock TimeoutError',
    });

    // Malformed twice: two calls, tokens of both, unidentified with the problem; logs never carry the answer text.
    const secret = 'Sure! Here is the cap: MAHOU';
    const bad = setup([secret, converseOut('{"fields":', { inputTokens: 1000, outputTokens: 20 })]);
    const r = await bad.adapter.identify({ imageKeys: { top: TOP_KEY } });
    expect(bad.bedrock.send).toHaveBeenCalledTimes(2);
    expect(r).toEqual({
      status: 'unidentified',
      aiModel: MODEL,
      suggestions: [],
      aiConfidence: 0,
      problems: ['answer is not JSON'],
      usage: { inputTokens: 2200, outputTokens: 170, costEstimateUsd: 0.00305 },
    });
    expect(bad.log.mock.calls.map(([e]) => [e.event, e.attempt])).toEqual([
      ['vision.malformed', 1],
      ['vision.malformed', 2],
      ['vision.normalise', undefined],
    ]);
    expect(JSON.stringify(bad.log.mock.calls)).not.toContain('MAHOU');

    // Malformed once, then fine: identified on the retry.
    const retry = setup(['oops', answer({ brand: 'Mahou' })]);
    expect(await retry.adapter.identify({ imageKeys: { top: TOP_KEY } })).toMatchObject({
      status: 'identified',
      fields: { brand: 'Mahou' },
      usage: { inputTokens: 2400, outputTokens: 300 },
    });
    expect(retry.bedrock.send).toHaveBeenCalledTimes(2);

    // An answer with no text blocks or usage counts as malformed with zero tokens.
    const empty = setup([
      { output: { message: { role: 'assistant', content: [] } } } as unknown as ConverseCommandOutput,
    ]);
    expect(await empty.adapter.identify({ imageKeys: { top: TOP_KEY } })).toMatchObject({
      status: 'unidentified',
      usage: { inputTokens: 0, outputTokens: 0, costEstimateUsd: 0 },
    });
  });

  it('[T-api-062] tokens → cost from the price table (inference-profile prefix stripped, config override); unknown model → no cost; the Scan stores tokens and cost', async () => {
    expect(priceFor(MODEL)).toEqual(PRICE_TABLE['anthropic.claude-haiku-4-5-20251001-v1:0']);
    expect(priceFor('anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual({ inPer1k: 0.001, outPer1k: 0.005 });
    expect(priceFor('us.anthropic.claude-3-haiku-20240307-v1:0')).toEqual({ inPer1k: 0.00025, outPer1k: 0.00125 });
    expect(priceFor('mistral.pixtral-large-2502-v1:0')).toBeUndefined();
    expect(priceFor('mistral.pixtral-large-2502-v1:0', { inPer1k: 0.002, outPer1k: 0.006 })).toEqual({
      inPer1k: 0.002,
      outPer1k: 0.006,
    });
    expect(costUsd({ inPer1k: 0.001, outPer1k: 0.005 }, 1200, 150)).toBe(0.00195);
    expect(costUsd(undefined, 1200, 150)).toBeUndefined();

    const unknown = setup([answer({ brand: 'Mahou' })], { modelId: 'mistral.pixtral-large-2502-v1:0' });
    const r = await unknown.adapter.identify({ imageKeys: { top: TOP_KEY } });
    expect(r).toMatchObject({ status: 'identified', usage: { inputTokens: 1200, outputTokens: 150 } });
    expect(r.status !== 'unavailable' && r.usage).not.toHaveProperty('costEstimateUsd');
    const priced = setup([answer({ brand: 'Mahou' })], { price: { inPer1k: 0.01, outPer1k: 0.1 } });
    expect(await priced.adapter.identify({ imageKeys: { top: TOP_KEY } })).toMatchObject({
      usage: { costEstimateUsd: 0.027 },
    });

    // Through CAP-37's pipeline: a new cap → identified, and its Scan row carries model, confidence, tokens and cost.
    const repos = createMemoryRepositories();
    const { adapter } = setup([answer({ brand: 'Mahou', country: 'ES' }, { brand: 0.93, country: 0.8 })]);
    const res = await analyse({ repos, vision: adapter, threshold: 10 }, UID, {
      scanId: newId(),
      dhash: 'a3f0c81e7b2d9f44',
      imageKeys: { top: TOP_KEY },
      useAi: true,
    });
    expect(res).toMatchObject({ outcome: 'identified', fields: { brand: 'Mahou', country: 'ES' }, aiModel: MODEL });
    const [scan] = (await repos.scans.list(UID)).items;
    expect(Scan.parse(scan)).toMatchObject({
      outcome: 'identified',
      aiCalled: true,
      aiModel: MODEL,
      aiConfidence: 0.93,
      inputTokens: 1200,
      outputTokens: 150,
      costEstimateUsd: 0.00195,
    });
  });

  it('[T-api-063] CAP_VISION picks the adapter (bedrock default needs CAP_BEDROCK_MODEL_ID; fake; off); price override needs both variables', () => {
    const ENV = { CAP_TABLE_NAME: 'cap-dev-table', CAP_IMAGES_BUCKET: BUCKET, CAP_STAGE: 'dev' };
    expect(loadConfig(ENV).vision).toBe('bedrock');
    expect(loadConfig({ ...ENV, CAP_VISION: 'fake' }).vision).toBe('fake');
    expect(() => loadConfig({ ...ENV, CAP_VISION: 'openai' })).toThrow(/CAP_VISION/);
    expect(loadConfig(ENV)).not.toHaveProperty('bedrockPrice');
    expect(loadConfig({ ...ENV, CAP_BEDROCK_PRICE_IN: '0.001', CAP_BEDROCK_PRICE_OUT: '0.005' }).bedrockPrice).toEqual({
      inPer1k: 0.001,
      outPer1k: 0.005,
    });
    expect(() => loadConfig({ ...ENV, CAP_BEDROCK_PRICE_IN: '0.001' })).toThrow(/CAP_BEDROCK_PRICE_IN/);
    expect(() => loadConfig({ ...ENV, CAP_BEDROCK_PRICE_IN: '-1', CAP_BEDROCK_PRICE_OUT: '1' })).toThrow(
      /CAP_BEDROCK_PRICE_IN/,
    );

    expect(createVisionAdapter(loadConfig({ ...ENV, CAP_VISION: 'off' }))).toBeInstanceOf(StubVisionAdapter);
    expect(createVisionAdapter(loadConfig({ ...ENV, CAP_VISION: 'fake' }))).toBeInstanceOf(FakeVisionAdapter);
    expect(() => createVisionAdapter(loadConfig(ENV))).toThrow(/CAP_BEDROCK_MODEL_ID is required/);
    const priced = loadConfig({
      ...ENV,
      CAP_BEDROCK_MODEL_ID: MODEL,
      CAP_BEDROCK_PRICE_IN: '0.001',
      CAP_BEDROCK_PRICE_OUT: '0.005',
    });
    expect(createVisionAdapter(priced)).toBeInstanceOf(BedrockVisionAdapter);
    expect(createVisionAdapter(loadConfig({ ...ENV, CAP_BEDROCK_MODEL_ID: MODEL }))).toBeInstanceOf(
      BedrockVisionAdapter,
    );
  });

  it('[T-api-064] CAP_VISION=fake answers from api/test/fixtures/vision through the same parser, stable per image; every fixture is a valid answer', async () => {
    const fake = new FakeVisionAdapter();
    const outcomes = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const key = `${UID}/${newId()}/top.webp`;
      const r = await fake.identify({ imageKeys: { top: key } });
      expect(r.status).not.toBe('unavailable');
      expect(await fake.identify({ imageKeys: { top: key } })).toEqual(r);
      outcomes.add(r.status);
      if (r.status !== 'unavailable') expect(r.problems ?? []).toEqual([]);
    }
    expect([...outcomes].sort()).toEqual(['identified', 'unidentified']);
    expect(FAKE_FIXTURES_DIR).toMatch(/test\/fixtures\/vision\/$/);
    expect(() => new FakeVisionAdapter(`${mkdtempSync(join(tmpdir(), 'cap-vision-'))}/`)).toThrow(/no vision fixtures/);
  });
});
