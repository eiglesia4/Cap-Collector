// DynamoCapRepository requests, recorded without a network (CAP-17): every key it emits is exactly what
// @capcollector/shared keys.ts builds (data-model.md: "a key written any other way is a contract violation").
import {
  type AlbumLocation,
  INDEXES,
  SK_PREFIX,
  brandGsi2,
  capPk,
  capSk,
  historySk,
  locationGsi1,
  lockSk,
  scanSk,
  userPk,
} from '@capcollector/shared';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import { Conflict, NotImplemented } from '../../src/lib/errors.js';
import { encodeCursor } from '../../src/lib/repo/items.js';
import {
  DynamoCapRepository,
  DynamoRefreshTokenRepository,
  DynamoScanRepository,
  createDocumentClient,
  createDynamoRepositories,
  type DocSender,
} from '../../src/lib/repo/dynamo.js';
import { FIXTURE_CAP, makeHistory, nextTs, pocket } from '../support/fixtures.js';

const TABLE = 'cap-test-table';
const UID = 'apple-sub-1';
const ALBUM_ID = '01JBF6Z3Q8K2M4N6P8R0S2ALBM';

type Cmd = GetCommand | PutCommand | QueryCommand | TransactWriteCommand;

function recorder(reply: (c: Cmd) => unknown = () => ({})) {
  const sent: Cmd[] = [];
  const doc: DocSender = {
    send: async (c) => {
      sent.push(c);
      const r = reply(c);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { sent, doc, repo: new DynamoCapRepository(doc, TABLE) };
}

const transactItems = (c: Cmd | undefined) => (c as TransactWriteCommand).input.TransactItems ?? [];

describe('DynamoCapRepository keys', () => {
  it('[T-api-004] keys emitted for the fixture cap equal shared/keys.ts output (cap, GSI1, GSI2, HIST#, LOCK#)', async () => {
    const { sent, repo } = recorder();
    const loc = FIXTURE_CAP.location as AlbumLocation;
    const history = makeHistory(FIXTURE_CAP.capId, 'created', FIXTURE_CAP.createdAt);
    await repo.put(UID, { cap: FIXTURE_CAP, albumId: ALBUM_ID, history });

    const [capPut, histPut, lockPut] = transactItems(sent[0]);
    expect(capPut?.Put).toMatchObject({
      TableName: TABLE,
      ConditionExpression: 'attribute_not_exists(pk)',
      Item: {
        ...FIXTURE_CAP,
        pk: userPk(UID),
        sk: capSk(FIXTURE_CAP.capId),
        ...locationGsi1(ALBUM_ID, loc),
        ...brandGsi2(FIXTURE_CAP.brand, FIXTURE_CAP.variant, FIXTURE_CAP.capId),
      },
    });
    expect(capPut?.Put?.Item).toMatchObject({
      gsi1pk: 'LOC#01JBF6Z3Q8K2M4N6P8R0S2ALBM#3',
      gsi1sk: 'POCKET#17',
      gsi2pk: 'BRAND#mahou',
      gsi2sk: `VAR#clasica#CAP#${FIXTURE_CAP.capId}`,
    });
    expect(histPut?.Put?.Item).toMatchObject({ ...history, pk: capPk(FIXTURE_CAP.capId), sk: historySk(history.ts) });
    expect(lockPut?.Put?.Item).toEqual({ pk: userPk(UID), sk: lockSk(ALBUM_ID, loc), capId: FIXTURE_CAP.capId });

    // Move: replace conditioned on updatedAt, old lock deleted only if still ours, new lock put.
    const moved = { ...FIXTURE_CAP, location: pocket(5, 1), updatedAt: nextTs() };
    await repo.patch(
      UID,
      { cap: FIXTURE_CAP, albumId: ALBUM_ID },
      { cap: moved, albumId: ALBUM_ID, history: makeHistory(FIXTURE_CAP.capId, 'moved') },
    );
    const [replace, , delLock, newLock] = transactItems(sent[1]);
    expect(replace?.Put).toMatchObject({
      ConditionExpression: 'updatedAt = :prevUpdatedAt',
      ExpressionAttributeValues: { ':prevUpdatedAt': FIXTURE_CAP.updatedAt },
      Item: locationGsi1(ALBUM_ID, pocket(5, 1) as AlbumLocation),
    });
    expect(delLock?.Delete).toMatchObject({
      Key: { pk: userPk(UID), sk: lockSk(ALBUM_ID, loc) },
      ConditionExpression: 'capId = :capId',
      ExpressionAttributeValues: { ':capId': FIXTURE_CAP.capId },
    });
    expect(newLock?.Put?.Item).toMatchObject({ sk: lockSk(ALBUM_ID, pocket(5, 1) as AlbumLocation) });

    // Tombstone: no GSI attributes, lock released.
    const del = await repo.softDelete(
      UID,
      { cap: moved, albumId: ALBUM_ID },
      makeHistory(FIXTURE_CAP.capId, 'deleted'),
    );
    const [tomb, , freed] = transactItems(sent[2]);
    expect(tomb?.Put?.Item).toMatchObject({ deletedAt: del.deletedAt, pk: userPk(UID), sk: capSk(FIXTURE_CAP.capId) });
    for (const a of ['gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk']) expect(tomb?.Put?.Item).not.toHaveProperty(a);
    expect(freed?.Delete?.Key).toEqual({ pk: userPk(UID), sk: lockSk(ALBUM_ID, pocket(5, 1) as AlbumLocation) });
  });

  it('[T-api-010] reads use shared keys and index names; cursors round-trip LastEvaluatedKey; conflicts map to 409', async () => {
    const lek = { pk: userPk(UID), sk: capSk(FIXTURE_CAP.capId) };
    const stored = { ...FIXTURE_CAP, pk: userPk(UID), sk: capSk(FIXTURE_CAP.capId), gsi1pk: 'x', gsi1sk: 'POCKET#17' };
    let pages = 0;
    const { sent, repo } = recorder((c) => {
      if (c instanceof GetCommand) return { Item: stored };
      if (c instanceof QueryCommand) {
        // First call of a queryAll returns a LastEvaluatedKey once, to prove it follows pages.
        pages++;
        return pages === 1 ? { Items: [stored], LastEvaluatedKey: lek } : { Items: [stored] };
      }
      return {};
    });

    expect(await repo.get(UID, FIXTURE_CAP.capId)).toEqual(FIXTURE_CAP);
    expect((sent[0] as GetCommand).input).toEqual({ TableName: TABLE, Key: lek });

    const page = await repo.list(UID, { limit: 10 });
    expect(page.cursor).toBe(encodeCursor(lek));
    expect((sent[1] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(UID), ':prefix': SK_PREFIX.cap },
      Limit: 10,
      FilterExpression: 'attribute_not_exists(deletedAt)',
    });
    await repo.list(UID, { cursor: page.cursor!, includeDeleted: true });
    expect((sent[2] as QueryCommand).input.ExclusiveStartKey).toEqual(lek);
    expect((sent[2] as QueryCommand).input.FilterExpression).toBeUndefined();

    pages = 0;
    const sheet = await repo.listGsi1(ALBUM_ID, 3);
    expect(sheet).toHaveLength(2); // two pages followed
    expect(sheet[0]?.pocket).toBe(17);
    expect((sent[3] as QueryCommand).input).toMatchObject({
      IndexName: INDEXES.location,
      ExpressionAttributeValues: { ':pk': locationGsi1(ALBUM_ID, pocket(3, 1) as AlbumLocation).gsi1pk },
    });
    expect((sent[4] as QueryCommand).input.ExclusiveStartKey).toEqual(lek);

    pages = 1;
    await repo.listGsi2('Estrella Galicia', '1906');
    expect((sent[5] as QueryCommand).input).toMatchObject({
      IndexName: INDEXES.brand,
      ExpressionAttributeValues: { ':pk': 'BRAND#estrellagalicia', ':prefix': 'VAR#1906#CAP#' },
    });
    await repo.listGsi2('Mahou');
    expect((sent[6] as QueryCommand).input.ExpressionAttributeValues).toEqual({
      ':pk': brandGsi2('Mahou', undefined, '').gsi2pk,
    });

    pages = 1;
    await repo.hashes(UID);
    expect((sent[7] as QueryCommand).input).toMatchObject({ ProjectionExpression: 'capId, dhash, dhashUnderside' });
    pages = 1;
    expect(await repo.history(FIXTURE_CAP.capId)).toHaveLength(1);
    expect((sent[8] as QueryCommand).input.ExpressionAttributeValues).toEqual({ ':pk': capPk(FIXTURE_CAP.capId) });

    pages = 1;
    expect(await repo.listAll(UID)).toEqual([FIXTURE_CAP]);
    expect((sent[9] as QueryCommand).input).toMatchObject({
      ExpressionAttributeValues: { ':pk': userPk(UID), ':prefix': SK_PREFIX.cap },
      FilterExpression: 'attribute_not_exists(deletedAt)',
    });
    expect((sent[9] as QueryCommand).input.Limit).toBeUndefined();
    pages = 1;
    await repo.listAll(UID, { includeDeleted: true });
    expect((sent[10] as QueryCommand).input.FilterExpression).toBeUndefined();

    // Write errors: cancelled transaction → Conflict; anything else propagates.
    const cancelled = Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
    const failing = recorder(() => cancelled).repo;
    const h = makeHistory(FIXTURE_CAP.capId, 'created');
    await expect(failing.put(UID, { cap: FIXTURE_CAP, albumId: ALBUM_ID, history: h })).rejects.toBeInstanceOf(
      Conflict,
    );
    const throttled = recorder(() => Object.assign(new Error('slow down'), { name: 'ThrottlingException' })).repo;
    await expect(throttled.put(UID, { cap: FIXTURE_CAP, albumId: ALBUM_ID, history: h })).rejects.toThrow('slow down');
  });

  it('[T-api-011] album and exchange DynamoDB repositories are stubs that answer 501 until their stories (scans are real since CAP-37)', async () => {
    const repos = createDynamoRepositories(createDocumentClient({}), TABLE);
    expect(repos.caps).toBeInstanceOf(DynamoCapRepository);
    const calls = [
      repos.albums.get(UID, 'a'),
      repos.albums.byLetter(UID, 'A'),
      repos.albums.list(UID),
      repos.albums.put(UID, {} as never),
      repos.exchange.put(UID, {} as never),
      repos.exchange.get(UID, 'r'),
      repos.exchange.list(UID),
    ];
    for (const c of calls) await expect(c).rejects.toBeInstanceOf(NotImplemented);
    expect(repos.scans).toBeInstanceOf(DynamoScanRepository);
  });

  it('[T-api-048] scans: USER#/SCAN#<ts>#<scanId> keys from shared, newest first with cursor, get by id follows pages', async () => {
    const scan = {
      scanId: '01JBF6Z3Q8K2M4N6P8R0S2SCAN',
      ts: '2026-11-08T10:00:00.000Z',
      dhash: 'a3f0c81e7b2d9f44',
      outcome: 'duplicate' as const,
      threshold: 10,
      aiCalled: false,
    };
    const lastKey = { pk: userPk(UID), sk: scanSk(scan.ts, scan.scanId) };
    const sent: Cmd[] = [];
    let n = 0;
    const doc: DocSender = {
      send: async (c) => {
        sent.push(c);
        if (!(c instanceof QueryCommand)) return {};
        // get(): first page empty with a continuation, second page holds the item.
        if (c.input.FilterExpression)
          return n++ === 0 ? { Items: [], LastEvaluatedKey: lastKey } : { Items: [{ ...scan, ...lastKey }] };
        return { Items: [{ ...scan, ...lastKey }], LastEvaluatedKey: lastKey };
      },
    };
    const repo = new DynamoScanRepository(doc, TABLE);
    await repo.put(UID, scan);
    expect((sent[0] as PutCommand).input).toEqual({ TableName: TABLE, Item: { ...scan, ...lastKey } });

    const page = await repo.list(UID, { limit: 200 });
    expect(page.items).toEqual([scan]);
    expect(page.cursor).toBe(encodeCursor(lastKey));
    expect((sent[1] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(UID), ':prefix': SK_PREFIX.scan },
      ScanIndexForward: false,
      Limit: 200,
    });
    await repo.list(UID, { cursor: page.cursor! });
    expect((sent[2] as QueryCommand).input).toMatchObject({ ExclusiveStartKey: lastKey, Limit: 50 });
    await expect(repo.list(UID, { limit: 201 })).rejects.toThrow('limit must be 1–200');
    await expect(repo.list(UID, { cursor: encodeCursor({ pk: userPk('other'), sk: 'SCAN#x' }) })).rejects.toThrow(
      'Invalid cursor',
    );

    expect(await repo.get(UID, scan.scanId)).toEqual(scan);
    expect((sent[3] as QueryCommand).input).toMatchObject({
      FilterExpression: 'scanId = :scanId',
      ExpressionAttributeValues: { ':scanId': scan.scanId },
    });
    expect((sent[4] as QueryCommand).input.ExclusiveStartKey).toEqual(lastKey);
    expect(sent).toHaveLength(5); // invalid limit / cursor never reach DynamoDB
    const none = new DynamoScanRepository({ send: async () => ({}) }, TABLE);
    expect(await none.get(UID, scan.scanId)).toBeUndefined();
  });

  it('[T-api-032] refresh tokens: USER#/REFRESH#<hash> keys, single-use rotation conditioned on existence and ttl', async () => {
    const { sent, doc } = recorder();
    const repo = new DynamoRefreshTokenRepository(doc, TABLE);
    const item = { tokenHash: 'abc', createdAt: '2026-11-01T10:00:00.000Z', ttl: 2_000_000_000 };
    await repo.create(UID, item);
    expect(transactItems(sent[0])[0]?.Put).toEqual({
      TableName: TABLE,
      Item: { pk: userPk(UID), sk: 'REFRESH#abc', ...item },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(await repo.rotate(UID, 'abc', { ...item, tokenHash: 'def' }, 1_700_000_000)).toBe(true);
    const [del, put] = transactItems(sent[1]);
    expect(del?.Delete).toEqual({
      TableName: TABLE,
      Key: { pk: userPk(UID), sk: 'REFRESH#abc' },
      ConditionExpression: 'attribute_exists(pk) AND #ttl > :now',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': 1_700_000_000 },
    });
    expect(put?.Put?.Item).toMatchObject({ sk: 'REFRESH#def' });

    const cancelled = Object.assign(new Error('x'), { name: 'TransactionCanceledException' });
    const failing = new DynamoRefreshTokenRepository(recorder(() => cancelled).doc, TABLE);
    expect(await failing.rotate(UID, 'abc', item, 1)).toBe(false);
    await expect(failing.create(UID, item)).rejects.toBeInstanceOf(Conflict);
    const broken = new DynamoRefreshTokenRepository(
      recorder(() => Object.assign(new Error('down'), { name: 'InternalServerError' })).doc,
      TABLE,
    );
    await expect(broken.rotate(UID, 'abc', item, 1)).rejects.toThrow('down');
    await expect(broken.create(UID, item)).rejects.toThrow('down');
  });
});
