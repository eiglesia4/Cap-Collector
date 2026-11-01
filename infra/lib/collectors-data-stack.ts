/**
 * CollectorsData (ADR-002, CAP-13): the images bucket, the static web bucket and the single DynamoDB table of
 * data-model.md. Everything is on-demand / pay-per-use: no VPC, no NAT, no always-on compute (CONVENTIONS § Cost).
 * The table comes from table-definition.ts, the same definition `npm run db:create` uses locally.
 * Removal policy: DESTROY only for stage `dev`; any other stage RETAINs data (story: RETAIN for prod).
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  ObjectOwnership,
  StorageClass,
} from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

import { type Deployment, type InstallationConfig, resourceName } from './config.js';
import { TABLE_DEFINITION } from './table-definition.js';

export type CollectorsDataStackProps = StackProps & {
  readonly deployment: Deployment;
  readonly config: InstallationConfig;
};

/** Only the throwaway stage may be deleted with its data. */
export const isDisposableStage = (deployment: Deployment): boolean => deployment.stage === 'dev';

/** Images move to Standard-IA after this many days (story CAP-13). */
export const IMAGES_IA_AFTER_DAYS = 90;

const str = (name: string) => ({ name, type: AttributeType.STRING });

export class CollectorsDataStack extends Stack {
  readonly table: Table;
  readonly imagesBucket: Bucket;
  readonly webBucket: Bucket;

  constructor(scope: Construct, id: string, props: CollectorsDataStackProps) {
    super(scope, id, props);
    const { deployment, config } = props;
    const disposable = isDisposableStage(deployment);
    const removalPolicy = disposable ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // Static web for the Mac (ADR-001). V1: plain S3 website hosting, public read; CloudFront + private bucket later.
    // No enforceSSL: the S3 website endpoint is HTTP only and would be denied by a SecureTransport policy.
    this.webBucket = new Bucket(this, 'Web', {
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: new BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: BucketEncryption.S3_MANAGED,
      removalPolicy,
      autoDeleteObjects: disposable,
    });

    // Cap photos (WebP ≤ 1024 px, uploaded with presigned PUT from the app). Private, versioned, IA after 90 days.
    // SPEC-GAP CAP-13: the web domain is not chosen yet (ADR-008), so CORS allows the origins declared in
    // infra/config/<installation>.<stage>.json plus this stack's own website endpoint.
    this.imagesBucket = new Bucket(this, 'Images', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          id: 'images-to-ia',
          transitions: [
            { storageClass: StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(IMAGES_IA_AFTER_DAYS) },
          ],
          noncurrentVersionTransitions: [
            { storageClass: StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(IMAGES_IA_AFTER_DAYS) },
          ],
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
      cors: [
        {
          allowedMethods: [HttpMethods.PUT, HttpMethods.GET, HttpMethods.HEAD],
          allowedOrigins: [...config.app_origins, this.webBucket.bucketWebsiteUrl],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      removalPolicy,
      autoDeleteObjects: disposable,
    });

    // The single table (data-model.md): on-demand, PITR, TTL on `ttl`, GSI1 location + GSI2 brand.
    const def = TABLE_DEFINITION;
    this.table = new Table(this, 'Table', {
      tableName: resourceName(deployment, 'table'),
      partitionKey: str(def.partitionKey),
      sortKey: str(def.sortKey),
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: def.timeToLiveAttribute,
      deletionProtection: !disposable,
      removalPolicy,
    });
    for (const gsi of def.globalSecondaryIndexes) {
      this.table.addGlobalSecondaryIndex({
        indexName: gsi.indexName,
        partitionKey: str(gsi.partitionKey),
        sortKey: str(gsi.sortKey),
        projectionType: ProjectionType.INCLUDE,
        nonKeyAttributes: [...gsi.nonKeyAttributes],
      });
    }

    // Exported for CollectorsApi (and for Edu's console checks after deploy).
    const out = (key: string, value: string, description: string) =>
      new CfnOutput(this, key, { value, description, exportName: `${resourceName(deployment, 'data')}-${key}` });
    out('TableName', this.table.tableName, 'DynamoDB single table');
    out('TableArn', this.table.tableArn, 'DynamoDB single table ARN');
    out('ImagesBucketName', this.imagesBucket.bucketName, 'S3 bucket for cap images (presigned PUT/GET)');
    out('WebBucketName', this.webBucket.bucketName, 'S3 bucket for the static web build');
    out('WebsiteUrl', this.webBucket.bucketWebsiteUrl, 'S3 website endpoint of the web build');
  }
}
