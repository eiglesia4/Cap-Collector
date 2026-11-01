/**
 * The single DynamoDB table as plain data (data-model.md, Agreed 2026-10-31): one definition read by the CDK stack
 * (collectors-data-stack.ts) and by the local `npm run db:create` script (local-db.ts), so the table in AWS and the
 * one in DynamoDB Local cannot drift (CAP-13). Attribute and index names come from `@capcollector/shared` — infra
 * never spells a key name of its own.
 */
import { GSI_PROJECTION, INDEXES, TABLE_ATTRIBUTES } from '@capcollector/shared';
import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';

export interface GsiDefinition {
  readonly indexName: string;
  readonly partitionKey: string;
  readonly sortKey: string;
  /** Projection = keys + these (data-model.md § Indexes). */
  readonly nonKeyAttributes: readonly string[];
}

export interface TableDefinition {
  readonly partitionKey: string;
  readonly sortKey: string;
  readonly globalSecondaryIndexes: readonly GsiDefinition[];
  readonly timeToLiveAttribute: string;
}

/** Every key attribute is a string; `ttl` is a number but is not a key, so it is never declared. */
export const TABLE_DEFINITION: TableDefinition = {
  partitionKey: TABLE_ATTRIBUTES.pk,
  sortKey: TABLE_ATTRIBUTES.sk,
  globalSecondaryIndexes: [
    {
      indexName: INDEXES.location,
      partitionKey: TABLE_ATTRIBUTES.gsi1pk,
      sortKey: TABLE_ATTRIBUTES.gsi1sk,
      nonKeyAttributes: GSI_PROJECTION,
    },
    {
      indexName: INDEXES.brand,
      partitionKey: TABLE_ATTRIBUTES.gsi2pk,
      sortKey: TABLE_ATTRIBUTES.gsi2sk,
      nonKeyAttributes: GSI_PROJECTION,
    },
  ],
  timeToLiveAttribute: TABLE_ATTRIBUTES.ttl,
};

/** `CreateTable` input for DynamoDB Local: on-demand, same keys and GSIs as the CDK table. */
export function toCreateTableInput(
  tableName: string,
  def: TableDefinition = TABLE_DEFINITION,
): CreateTableCommandInput {
  const keyAttributes = [
    def.partitionKey,
    def.sortKey,
    ...def.globalSecondaryIndexes.flatMap((g) => [g.partitionKey, g.sortKey]),
  ];
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: keyAttributes.map((name) => ({ AttributeName: name, AttributeType: 'S' })),
    KeySchema: [
      { AttributeName: def.partitionKey, KeyType: 'HASH' },
      { AttributeName: def.sortKey, KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: def.globalSecondaryIndexes.map((g) => ({
      IndexName: g.indexName,
      KeySchema: [
        { AttributeName: g.partitionKey, KeyType: 'HASH' },
        { AttributeName: g.sortKey, KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: [...g.nonKeyAttributes] },
    })),
  };
}
