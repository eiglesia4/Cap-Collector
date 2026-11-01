/**
 * `npm run db:create` — creates the single table (+ GSI1/GSI2, TTL) in DynamoDB Local from the same definition CDK
 * deploys (CAP-13). Start the containers first: `docker compose -f deploy/docker-compose.yaml up -d`.
 * Idempotent; refuses AWS endpoints (local-db.ts).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import { ensureLocalTable, localDbConfig } from '../lib/local-db.js';

const { endpoint, tableName } = localDbConfig();
// DynamoDB Local accepts any credentials and region; these are placeholders for the emulator, not AWS values.
const client = new DynamoDBClient({
  endpoint,
  region: 'local',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

try {
  const result = await ensureLocalTable(client, tableName);
  console.log(`db:create: table ${tableName} ${result === 'created' ? 'created' : 'already there'} at ${endpoint}`);
} catch (e) {
  console.error(`db:create: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  client.destroy();
}
