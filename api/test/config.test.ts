// Config, ids, clock and repository wiring (CAP-17).
import { afterEach, describe, expect, it } from 'vitest';

import { getConfig, loadConfig, resetConfig } from '../src/lib/config.js';
import { newId } from '../src/lib/ids.js';
import { getRepositories, setRepositories } from '../src/lib/repo/index.js';
import { DynamoCapRepository } from '../src/lib/repo/dynamo.js';
import { createMemoryRepositories } from '../src/lib/repo/memory.js';
import { now } from '../src/lib/time.js';

const ENV = { CAP_TABLE_NAME: 'cap-dev-table', CAP_IMAGES_BUCKET: 'cap-dev-images', CAP_STAGE: 'dev' };
const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  resetConfig();
  setRepositories(undefined);
});

describe('config', () => {
  it('[T-api-014] env is validated at load: valid → typed config; invalid → one error naming every bad variable, no values', () => {
    expect(loadConfig(ENV)).toEqual({ tableName: 'cap-dev-table', imagesBucket: 'cap-dev-images', stage: 'dev' });
    expect(loadConfig({ ...ENV, CAP_DYNAMODB_ENDPOINT: 'http://localhost:8000' }).dynamodbEndpoint).toBe(
      'http://localhost:8000',
    );
    expect(loadConfig({ ...ENV, CAP_DYNAMODB_ENDPOINT: '' })).not.toHaveProperty('dynamodbEndpoint');

    let msg = '';
    try {
      loadConfig({ CAP_IMAGES_BUCKET: 'Bad_Bucket!!', CAP_STAGE: 'dev', CAP_DYNAMODB_ENDPOINT: 'not a url' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^Invalid API configuration: /);
    for (const v of ['CAP_TABLE_NAME', 'CAP_IMAGES_BUCKET', 'CAP_DYNAMODB_ENDPOINT']) expect(msg).toContain(v);
    expect(msg).not.toContain('Bad_Bucket');
    expect(msg).not.toContain('CAP_STAGE');
  });

  it('[T-api-015] getConfig and getRepositories are memoised per cold start and build DynamoDB repositories from env', () => {
    Object.assign(process.env, ENV, { CAP_DYNAMODB_ENDPOINT: 'http://localhost:8000' });
    const c = getConfig();
    expect(getConfig()).toBe(c);
    const repos = getRepositories();
    expect(repos.caps).toBeInstanceOf(DynamoCapRepository);
    expect(getRepositories()).toBe(repos);
    const mem = createMemoryRepositories();
    setRepositories(mem);
    expect(getRepositories()).toBe(mem);
    delete process.env.CAP_TABLE_NAME;
    resetConfig();
    setRepositories(undefined);
    expect(() => getRepositories()).toThrow('CAP_TABLE_NAME');
  });

  it('[T-api-016] newId mints sortable unique ULIDs; now() is an ISO instant from an injectable clock', () => {
    const ids = Array.from({ length: 50 }, () => newId());
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new Set(ids).size).toBe(50);
    expect([...ids].sort()).toEqual(ids);
    expect(now(() => Date.parse('2026-11-01T10:00:00Z'))).toBe('2026-11-01T10:00:00.000Z');
    expect(Date.parse(now())).not.toBeNaN();
  });
});
