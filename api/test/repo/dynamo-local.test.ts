// DynamoDB repository against DynamoDB Local (CAP-17): the same contract suite as the in-memory fake (T-api-003).
// Runs only when CAP_DYNAMODB_ENDPOINT is set (docker compose -f deploy/docker-compose.yaml up -d && npm run db:create);
// tests never touch the cloud (CLAUDE.md § Tests), so CI without the container skips it.
import { describe, it } from 'vitest';

import { createDocumentClient, DynamoCapRepository } from '../../src/lib/repo/dynamo.js';
import { runCapRepositoryContract } from './cap-contract.js';

const endpoint = process.env.CAP_DYNAMODB_ENDPOINT;
const isLocal = !!endpoint && !/amazonaws\.com/.test(endpoint);
const table = process.env.CAP_TABLE_NAME || 'cap-local-table';

describe('DynamoDB repositories (DynamoDB Local)', () => {
  it('[T-api-005] DynamoCapRepository passes the same contract suite on DynamoDB Local (skipped without CAP_DYNAMODB_ENDPOINT)', async (ctx) => {
    // Runtime skip (not it.skipIf) so the test stays in the TEST.md catalog.
    if (!isLocal) ctx.skip('CAP_DYNAMODB_ENDPOINT is not set to a local endpoint');
    const doc = createDocumentClient({ dynamodbEndpoint: endpoint! });
    await runCapRepositoryContract(new DynamoCapRepository(doc, table));
  }, 30_000);
});
