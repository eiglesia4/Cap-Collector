// Contract tests for @capcollector/shared (CAP-12): fixtures round-trip, exchange v1 upload matrix, location codes,
// DynamoDB keys against data-model.md, and the OpenAPI document. IDs T-shared-001…005 (method.md § Tests).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  Album,
  AnalyseRequest,
  AnalyseResponse,
  Cap,
  CapHistory,
  CapInput,
  EXCHANGE_FIELD_SCHEMA,
  ExchangeDocumentV1,
  Location,
  Scan,
  brandGsi2,
  capSk,
  cellToPocket,
  emptyExchangeResponse,
  exchangeSk,
  exchangeTtl,
  formatLocationCode,
  historySk,
  locationGsi1,
  lockSk,
  normaliseBrand,
  normaliseResponseFields,
  parseExchangeUpload,
  parseLocationCode,
  pocketToCell,
  scanSk,
  userPk,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

describe('shared contracts', () => {
  it('[T-shared-001] every entity schema round-trips its fixture and rejects a broken one', () => {
    const cap = Cap.parse(fixture('cap.json'));
    expect(Cap.parse(cap)).toEqual(cap);
    expect(cap.location).toEqual({ kind: 'album', album: 'A', sheet: 3, pocket: 17 });

    // forTrade > quantity and self-variant are contract violations (cap.ts refinements)
    expect(Cap.safeParse({ ...cap, forTrade: 4 }).success).toBe(false);
    expect(Cap.safeParse({ ...cap, variantOf: cap.capId }).success).toBe(false);

    // CapInput is strict: an unknown key is rejected, defaults fill quantity/tags/source
    const input = CapInput.parse({ brand: 'Alhambra', images: cap.images });
    expect(input).toMatchObject({ brand: 'Alhambra', quantity: 1, forTrade: 0, tags: [], source: 'manual' });
    expect(CapInput.safeParse({ brand: 'x', images: cap.images, bogus: 1 }).success).toBe(false);

    const hist = CapHistory.parse({
      capId: cap.capId,
      ts: cap.updatedAt,
      source: 'manual',
      action: 'updated',
      changes: [{ field: 'year', from: null, to: 2023 }],
    });
    expect(hist.changes).toHaveLength(1);

    const scan = Scan.parse({
      scanId: cap.capId,
      ts: cap.createdAt,
      dhash: cap.dhash,
      outcome: 'duplicate',
      threshold: 10,
      aiCalled: false,
      match: { capId: cap.capId, hammingDistance: 3, by: 'dhash' },
    });
    expect(scan.aiCalled).toBe(false);
    expect(AnalyseRequest.parse({ scanId: cap.capId, dhash: cap.dhash, imageKeys: { top: 'k' } }).useAi).toBe(true);
    expect(AnalyseResponse.parse({ scanId: cap.capId, outcome: 'unidentified' }).suggestions).toEqual([]);

    const album = Album.parse({
      albumId: cap.capId,
      letter: 'A',
      name: 'GRANDE',
      kind: 'album',
      sheets: 10,
      cols: 6,
      rows: 7,
      pocketMm: 36,
      pitchMm: 40,
      createdAt: cap.createdAt,
      updatedAt: cap.updatedAt,
    });
    expect(album.cols).toBe(6);
    expect(Album.safeParse({ ...album, sheets: undefined }).success).toBe(false); // album kind needs geometry
    expect(Album.safeParse({ ...album, pitchMm: 30 }).success).toBe(false); // pitch < pocket
  });

  it('[T-shared-002] exchange v1: full document, bare response and batch are accepted; unknown format/version rejected; fields normalised', () => {
    const doc = ExchangeDocumentV1.parse(fixture('exchange-request.json'));
    expect(doc.schema).toEqual(EXCHANGE_FIELD_SCHEMA);
    expect(doc.response).toEqual(emptyExchangeResponse());

    expect(parseExchangeUpload(doc).kind).toBe('document');
    expect(parseExchangeUpload([doc, doc]).kind).toBe('batch');
    const bare = parseExchangeUpload(fixture('exchange-response-bare.json'));
    expect(bare.kind).toBe('response');

    expect(() => parseExchangeUpload({ ...doc, format: 'other.format' })).toThrow(/unknown exchange format/);
    expect(() => parseExchangeUpload({ ...doc, version: 2 })).toThrow(/unsupported exchange version/);

    if (bare.kind !== 'response') throw new Error('unreachable');
    const n = normaliseResponseFields(bare.response.fields);
    expect(n.fields).toEqual({
      brand: 'Asahi',
      variant: 'Super Dry',
      producer: 'Asahi Breweries',
      country: 'JP',
      type: 'beer',
      material: 'aluminium',
      closure: 'pry-off',
      year: 2019,
      description: 'Silver cap with black Asahi wordmark',
      textOnCap: 'ASAHI SUPER DRY',
    });
    expect(n.ignored).toEqual(['price']);
    expect(n.problems).toEqual([]);

    const bad = normaliseResponseFields({ brand: 'X', country: 'Atlantis', year: 'unknown', type: 'kombucha' });
    expect(bad.fields).toEqual({ brand: 'X' });
    expect(bad.problems).toEqual(expect.arrayContaining(['country: Atlantis', 'year: unknown', 'type: kombucha']));
  });

  it('[T-shared-003] location codes: format A·3·17, parse lenient separators, row-major cell maths', () => {
    const loc = Location.parse({ kind: 'album', album: 'A', sheet: 3, pocket: 17 });
    expect(formatLocationCode(loc)).toBe('A·3·17');
    expect(formatLocationCode({ kind: 'box', album: 'B' })).toBe('B');

    for (const text of ['A·3·17', 'a-3-17', 'A.3.17', 'A 3 17', ' A/3/17 '])
      expect(parseLocationCode(text)).toEqual(loc);
    expect(parseLocationCode('B')).toEqual({ kind: 'box', album: 'B' });
    expect(parseLocationCode('B', 'frame')).toEqual({ kind: 'frame', album: 'B' });
    for (const text of ['', 'AB·3·17', 'A·0·1', 'A·3', 'Mahou']) expect(parseLocationCode(text)).toBeNull();

    expect(Location.safeParse({ kind: 'album', album: 'A' }).success).toBe(false); // album needs sheet+pocket
    expect(Location.safeParse({ kind: 'box', album: 'a' }).success).toBe(false); // lower-case letter

    expect(pocketToCell(17, 6)).toEqual({ row: 3, col: 5 });
    expect(cellToPocket(3, 5, 6)).toBe(17);
    expect(pocketToCell(42, 6)).toEqual({ row: 7, col: 6 });
  });

  it('[T-shared-004] DynamoDB keys follow data-model.md (PK/SK per entity, GSI1 location, GSI2 brand, TTL)', () => {
    expect(userPk('u1')).toBe('USER#u1');
    expect(capSk('01A')).toBe('CAP#01A');
    expect(historySk('2026-10-31T10:00:00.000Z')).toBe('HIST#2026-10-31T10:00:00.000Z');
    expect(scanSk('2026-10-31T10:00:00.000Z', 'S1')).toBe('SCAN#2026-10-31T10:00:00.000Z#S1');
    expect(exchangeSk('R1')).toBe('EXCHANGE#R1');
    expect(lockSk('ALB1', { kind: 'album', album: 'A', sheet: 3, pocket: 7 })).toBe('LOCK#ALB1#3#7');

    expect(locationGsi1('ALB1', { kind: 'album', album: 'A', sheet: 3, pocket: 7 })).toEqual({
      gsi1pk: 'LOC#ALB1#3',
      gsi1sk: 'POCKET#07',
    });

    expect(normaliseBrand('Estrella Galicia 1906')).toBe('estrellagalicia1906');
    expect(normaliseBrand('Mahou Clásica')).toBe(normaliseBrand('MAHOU clasica'));
    expect(brandGsi2('Mahou', 'Clásica', 'C1')).toEqual({ gsi2pk: 'BRAND#mahou', gsi2sk: 'VAR#clasica#CAP#C1' });
    expect(brandGsi2('Mahou', undefined, 'C1').gsi2sk).toBe('VAR#_#CAP#C1');

    expect(exchangeTtl(Date.UTC(2026, 9, 31)) - Math.floor(Date.UTC(2026, 9, 31) / 1000)).toBe(30 * 86400);
  });

  it('[T-shared-005] openapi.yaml parses, declares every v0.1 route and references only schemas it defines', () => {
    const api = parseYaml(readFileSync(join(here, '..', '..', 'doc', 'spec', 'openapi.yaml'), 'utf8')) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(api.openapi).toBe('3.1.0');
    const expected = [
      '/healthz',
      '/auth/apple',
      '/auth/refresh',
      '/uploads',
      '/caps',
      '/caps/{capId}',
      '/caps/{capId}/history',
      '/caps/{capId}/location',
      '/scans/analyse',
      '/scans',
      '/albums',
      '/albums/{albumId}',
      '/albums/{albumId}/sheets/{sheet}',
      '/albums/{albumId}/next-free',
      '/exchange/requests',
      '/exchange/requests/{requestId}',
    ];
    expect(Object.keys(api.paths).sort()).toEqual(expected.sort());

    const text = JSON.stringify(api);
    const refs = [...text.matchAll(/#\/components\/schemas\/([A-Za-z]+)/g)].map((m) => m[1]!);
    const defined = new Set(Object.keys(api.components.schemas));
    for (const r of new Set(refs)) expect(defined, `schema ${r} referenced but not defined`).toContain(r);
  });
});
