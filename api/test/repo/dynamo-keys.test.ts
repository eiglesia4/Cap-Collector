// DynamoCapRepository requests, recorded without a network (CAP-17): every key it emits is exactly what
// @capcollector/shared keys.ts builds (data-model.md: "a key written any other way is a contract violation").
import {
  type AlbumLocation,
  INDEXES,
  SK_PREFIX,
  albumSk,
  brandGsi2,
  capPk,
  capSk,
  exchangeSk,
  historySk,
  locationGsi1,
  lockSk,
  scanSk,
  userPk,
} from '@capcollector/shared';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import { Conflict } from '../../src/lib/errors.js';
import { encodeCursor } from '../../src/lib/repo/items.js';
import {
  DynamoAlbumRepository,
  DynamoCapRepository,
  DynamoExchangeRepository,
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

  it('[T-api-071] albums: USER#/ALBUM#<albumId> keys from shared, list follows pages, create conditioned on a new id and a free letter, update on updatedAt; GSI1 sheet drops tombstones', async () => {
    const album = {
      albumId: ALBUM_ID,
      letter: 'A',
      name: 'Leuchtturm GRANDE 1',
      kind: 'album' as const,
      sheets: 10,
      cols: 6,
      rows: 7,
      createdAt: '2026-11-08T10:00:00.000Z',
      updatedAt: '2026-11-08T10:00:00.000Z',
    };
    const key = { pk: userPk(UID), sk: albumSk(ALBUM_ID) };
    const other = { ...album, albumId: '01JBF6Z3Q8K2M4N6P8R0S2OTHR', letter: 'B' };
    const sent: Cmd[] = [];
    let page = 0;
    const doc: DocSender = {
      send: async (c) => {
        sent.push(c);
        if (c instanceof GetCommand) return { Item: { ...album, ...key } };
        if (c instanceof QueryCommand) {
          page++;
          return page % 2 === 1
            ? { Items: [{ ...album, ...key }], LastEvaluatedKey: key }
            : { Items: [{ ...other, pk: key.pk, sk: albumSk(other.albumId) }] };
        }
        return {};
      },
    };
    const repos = createDynamoRepositories(doc, TABLE);
    expect(createDynamoRepositories(createDocumentClient({}), TABLE).albums).toBeInstanceOf(DynamoAlbumRepository);
    expect(repos.caps).toBeInstanceOf(DynamoCapRepository);
    expect(repos.scans).toBeInstanceOf(DynamoScanRepository);
    expect(repos.exchange).toBeInstanceOf(DynamoExchangeRepository);
    const repo = repos.albums;

    expect(await repo.get(UID, ALBUM_ID)).toEqual(album);
    expect((sent[0] as GetCommand).input).toEqual({ TableName: TABLE, Key: key });

    expect(await repo.list(UID)).toEqual([album, other]);
    const q1 = (sent[1] as QueryCommand).input;
    expect(q1).toEqual({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(UID), ':prefix': SK_PREFIX.album },
    });
    expect((sent[2] as QueryCommand).input.ExclusiveStartKey).toEqual(key);
    expect(await repo.byLetter(UID, 'B')).toEqual(other);

    await repo.put(UID, album);
    expect((sent.at(-1) as PutCommand).input).toEqual({ TableName: TABLE, Item: { ...album, ...key } });

    // Letter taken by another album → Conflict before any write; a free letter → put conditioned on a new id.
    const before = sent.length;
    await expect(repo.create(UID, { ...album, albumId: '01JBF6Z3Q8K2M4N6P8R0S2NEW0' })).rejects.toBeInstanceOf(
      Conflict,
    );
    expect(sent.slice(before).some((c) => c instanceof PutCommand)).toBe(false);
    await repo.create(UID, { ...album, letter: 'C' });
    expect((sent.at(-1) as PutCommand).input).toEqual({
      TableName: TABLE,
      Item: { ...album, letter: 'C', ...key },
      ConditionExpression: 'attribute_not_exists(pk)',
    });

    const next = { ...album, name: 'Renamed', updatedAt: '2026-11-08T11:00:00.000Z' };
    await repo.update(UID, next, album.updatedAt);
    expect((sent.at(-1) as PutCommand).input).toEqual({
      TableName: TABLE,
      Item: { ...next, ...key },
      ConditionExpression: 'updatedAt = :prev',
      ExpressionAttributeValues: { ':prev': album.updatedAt },
    });
    await expect(repo.update(UID, { ...next, letter: 'B' }, album.updatedAt)).rejects.toBeInstanceOf(Conflict);

    const stale = Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
    const failing = new DynamoAlbumRepository(
      { send: async (c) => (c instanceof QueryCommand ? { Items: [] } : Promise.reject(stale)) },
      TABLE,
    );
    await expect(failing.update(UID, next, album.updatedAt)).rejects.toBeInstanceOf(Conflict);
    await expect(failing.create(UID, album)).rejects.toBeInstanceOf(Conflict);
    const broken = new DynamoAlbumRepository(
      {
        send: async (c) =>
          c instanceof QueryCommand ? { Items: [] } : Promise.reject(Object.assign(new Error('down'), { name: 'X' })),
      },
      TABLE,
    );
    await expect(broken.create(UID, album)).rejects.toThrow('down');

    // GSI1: a tombstoned row with a stale index key is dropped from the sheet.
    const gsi = recorder(() => ({
      Items: [
        { ...FIXTURE_CAP, gsi1sk: 'POCKET#17' },
        { ...FIXTURE_CAP, capId: 'gone', gsi1sk: 'POCKET#18', deletedAt: '2026-11-08T10:00:00.000Z' },
      ],
    }));
    expect((await gsi.repo.listGsi1(ALBUM_ID, 3)).map((e) => e.pocket)).toEqual([17]);
  });

  it('[T-api-080] swap: one TransactWrite with both caps on updatedAt, both HIST#, the target LOCK# handed over on capId and the vacated one too; occupant reads the LOCK# key', async () => {
    const { sent, repo } = recorder((c) => (c instanceof GetCommand ? { Item: { capId: 'holder' } } : {}));
    const at = (s: number, p: number) => ({ ...(pocket(s, p) as AlbumLocation), albumId: ALBUM_ID });
    const a = { ...FIXTURE_CAP, capId: '01JBF6Z3Q8K2M4N6P8R0S2AAAA', location: at(1, 2) };
    const b = { ...FIXTURE_CAP, capId: '01JBF6Z3Q8K2M4N6P8R0S2BBBB', location: at(1, 1) };
    const aNext = { ...a, location: at(1, 1), updatedAt: '2026-11-08T10:00:00.000Z' };
    const bNext = { ...b, location: at(1, 2), updatedAt: '2026-11-08T10:00:00.001Z' };
    const ha = { ...makeHistory(a.capId, 'swapped'), ts: aNext.updatedAt };
    const hb = { ...makeHistory(b.capId, 'swapped'), ts: bNext.updatedAt };
    await repo.swap(
      UID,
      { prev: { cap: a, albumId: ALBUM_ID }, write: { cap: aNext, albumId: ALBUM_ID, history: ha } },
      { prev: { cap: b, albumId: ALBUM_ID }, write: { cap: bNext, albumId: ALBUM_ID, history: hb } },
    );
    const items = transactItems(sent[0]);
    expect(items).toHaveLength(6);
    expect(items[0]?.Put).toMatchObject({
      Item: { pk: userPk(UID), sk: capSk(a.capId), ...locationGsi1(ALBUM_ID, at(1, 1)) },
      ConditionExpression: 'updatedAt = :prevUpdatedAt',
      ExpressionAttributeValues: { ':prevUpdatedAt': a.updatedAt },
    });
    expect(items[1]?.Put?.Item).toMatchObject({ pk: capPk(a.capId), sk: historySk(ha.ts) });
    expect(items[2]?.Put).toMatchObject({ Item: { sk: capSk(b.capId), ...locationGsi1(ALBUM_ID, at(1, 2)) } });
    expect(items[3]?.Put?.Item).toMatchObject({ pk: capPk(b.capId), sk: historySk(hb.ts) });
    expect(items[4]?.Put).toEqual({
      TableName: TABLE,
      Item: { pk: userPk(UID), sk: lockSk(ALBUM_ID, at(1, 1)), capId: a.capId },
      ConditionExpression: 'capId = :capId',
      ExpressionAttributeValues: { ':capId': b.capId },
    });
    expect(items[5]?.Put).toEqual({
      TableName: TABLE,
      Item: { pk: userPk(UID), sk: lockSk(ALBUM_ID, at(1, 2)), capId: b.capId },
      ConditionExpression: 'capId = :capId',
      ExpressionAttributeValues: { ':capId': a.capId },
    });

    expect(await repo.occupant(UID, ALBUM_ID, 1, 1)).toBe('holder');
    expect((sent[1] as GetCommand).input).toEqual({
      TableName: TABLE,
      Key: { pk: userPk(UID), sk: lockSk(ALBUM_ID, at(1, 1)) },
    });
    const empty = recorder(() => ({})).repo;
    expect(await empty.occupant(UID, ALBUM_ID, 1, 1)).toBeUndefined();

    // A plan that does not describe a swap is a programming error, never a write.
    await expect(
      repo.swap(
        UID,
        { prev: { cap: a, albumId: ALBUM_ID }, write: { cap: aNext, albumId: ALBUM_ID, history: ha } },
        {
          prev: { cap: aNext, albumId: ALBUM_ID },
          write: { cap: { ...bNext, location: at(2, 2) }, albumId: ALBUM_ID, history: hb },
        },
      ),
    ).rejects.toThrow("a swap gives b exactly a's previous location");
    await expect(
      repo.swap(
        UID,
        { prev: { cap: a, albumId: ALBUM_ID }, write: { cap: aNext, albumId: ALBUM_ID, history: ha } },
        { prev: { cap: bNext, albumId: ALBUM_ID }, write: { cap: bNext, albumId: ALBUM_ID, history: hb } },
      ),
    ).rejects.toThrow('a swap moves a into the pocket b occupies');
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

  it('[T-api-051] exchange: USER#/EXCHANGE#<requestId> keys from shared, scan link in the same transaction, status-conditioned update, list follows pages', async () => {
    const item = {
      requestId: '01JBF6Z3Q8K2M4N6P8R0S2EXCH',
      createdAt: '2026-11-08T10:00:00.000Z',
      status: 'waiting' as const,
      dhash: 'a3f0c81e7b2d9f44',
      scanId: '01JBF6Z3Q8K2M4N6P8R0S2SCAN',
      ttl: 1765188000,
    };
    const scan = {
      scanId: item.scanId,
      ts: '2026-11-08T09:59:00.000Z',
      dhash: item.dhash,
      outcome: 'unidentified' as const,
      threshold: 10,
      aiCalled: true,
    };
    const page2 = { pk: userPk(UID), sk: exchangeSk('01JBF6Z3Q8K2M4N6P8R0S2EXC2') };
    const sent: Cmd[] = [];
    const doc: DocSender = {
      send: async (c) => {
        sent.push(c);
        if (c instanceof GetCommand) return { Item: { ...item, pk: userPk(UID), sk: exchangeSk(item.requestId) } };
        if (c instanceof QueryCommand)
          return c.input.ExclusiveStartKey
            ? { Items: [{ ...item, requestId: '01JBF6Z3Q8K2M4N6P8R0S2EXC2', ...page2 }] }
            : { Items: [{ ...item, pk: userPk(UID), sk: exchangeSk(item.requestId) }], LastEvaluatedKey: page2 };
        return {};
      },
    };
    const repo = new DynamoExchangeRepository(doc, TABLE);

    await repo.create(UID, item, scan);
    const [put, link] = transactItems(sent[0]);
    expect(put?.Put).toEqual({
      TableName: TABLE,
      Item: { ...item, pk: userPk(UID), sk: exchangeSk(item.requestId) },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(link?.Update).toMatchObject({
      TableName: TABLE,
      Key: { pk: userPk(UID), sk: scanSk(scan.ts, scan.scanId) },
      UpdateExpression: 'SET exchangeRequestId = :rid',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':rid': item.requestId },
    });
    await repo.create(UID, item);
    expect(transactItems(sent[1])).toHaveLength(1);

    expect(await repo.get(UID, item.requestId)).toEqual(item);
    expect((sent[2] as GetCommand).input.Key).toEqual({ pk: userPk(UID), sk: exchangeSk(item.requestId) });

    await repo.update(UID, { ...item, status: 'answered', provider: 'chatgpt' }, 'waiting');
    expect((sent[3] as PutCommand).input).toMatchObject({
      Item: { status: 'answered', provider: 'chatgpt', pk: userPk(UID), sk: exchangeSk(item.requestId) },
      ConditionExpression: '#status = :prev',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':prev': 'waiting' },
    });

    expect((await repo.list(UID)).map((r) => r.requestId)).toEqual([item.requestId, '01JBF6Z3Q8K2M4N6P8R0S2EXC2']);
    expect((sent[4] as QueryCommand).input.ExpressionAttributeValues).toEqual({
      ':pk': userPk(UID),
      ':prefix': SK_PREFIX.exchange,
    });
    expect((sent[5] as QueryCommand).input.ExclusiveStartKey).toEqual(page2);

    const fail = (name: string) => {
      const d: DocSender = { send: async () => Promise.reject(Object.assign(new Error(name), { name })) };
      return new DynamoExchangeRepository(d, TABLE);
    };
    await expect(fail('TransactionCanceledException').create(UID, item)).rejects.toBeInstanceOf(Conflict);
    await expect(fail('ConditionalCheckFailedException').update(UID, item, 'answered')).rejects.toBeInstanceOf(
      Conflict,
    );
    await expect(fail('ThrottlingException').create(UID, item)).rejects.toThrow('ThrottlingException');
    await expect(fail('ThrottlingException').update(UID, item, 'waiting')).rejects.toThrow('ThrottlingException');
    await expect(fail('ThrottlingException').get(UID, item.requestId)).rejects.toThrow('ThrottlingException');
    expect(
      await new DynamoExchangeRepository({ send: async () => ({}) }, TABLE).get(UID, item.requestId),
    ).toBeUndefined();
    expect(await new DynamoExchangeRepository({ send: async () => ({}) }, TABLE).list(UID)).toEqual([]);
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
