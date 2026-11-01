/**
 * CollectorsData (ADR-002, CAP-13): the images bucket, the static web bucket and the single DynamoDB table of
 * data-model.md. Everything is on-demand / pay-per-use: no VPC, no NAT, no always-on compute (CONVENTIONS § Cost).
 * The table comes from table-definition.ts, the same definition `npm run db:create` uses locally.
 * Removal policy: DESTROY only for stage `dev`; any other stage RETAINs data (story: RETAIN for prod).
 * The web build is served by CloudFront over HTTPS (CAP-16): Sign in with Apple needs an HTTPS return URL.
 * CloudFront lives here, not in a stack of its own, because the images bucket CORS needs the distribution's domain
 * and the distribution needs the web bucket — two stacks would reference each other.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HttpVersion,
  PriceClass,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  type IBucket,
  ObjectOwnership,
  StorageClass,
} from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { type Deployment, type InstallationConfig, resourceName } from './config.js';
import { SECRET_ENV, type SecretName } from './routes.js';
import { TABLE_DEFINITION } from './table-definition.js';

export type CollectorsDataStackProps = StackProps & {
  readonly deployment: Deployment;
  readonly config: InstallationConfig;
};

/** Only the throwaway stage may be deleted with its data. */
export const isDisposableStage = (deployment: Deployment): boolean => deployment.stage === 'dev';

/** SPA routing (CAP-16): S3 answers 403 (no ListBucket for OAC) or 404 for a deep path; CloudFront serves the app. */
export const SPA_FALLBACK_STATUSES = [403, 404] as const;

/** Images move to Standard-IA after this many days (story CAP-13). */
export const IMAGES_IA_AFTER_DAYS = 90;

const str = (name: string) => ({ name, type: AttributeType.STRING });

/** Value the stack writes once; Edu overwrites it (`aws ssm put-parameter --overwrite`). The API must refuse it. */
export const UNSET_PARAMETER_VALUE = 'unset';

/** `/cap/<installation>/<stage>/<setting>`, e.g. `/cap/naeva/dev/session-secret`. */
export const settingParameterName = (deployment: Deployment, name: SecretName): string =>
  `/cap/${deployment.installation}/${deployment.stage}/${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

export class CollectorsDataStack extends Stack {
  readonly table: Table;
  readonly imagesBucket: Bucket;
  readonly webBucket: Bucket;
  readonly settings: Readonly<Record<SecretName, StringParameter>>;
  readonly distribution: Distribution;
  /** `https://<id>.cloudfront.net` — the web origin until the real domain exists (ADR-008 §5, EP-09). */
  readonly webUrl: string;

  constructor(scope: Construct, id: string, props: CollectorsDataStackProps) {
    super(scope, id, props);
    const { deployment, config } = props;
    const disposable = isDisposableStage(deployment);
    const removalPolicy = disposable ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // Static web for the Mac (ADR-001, ADR-008 §3): a private bucket read only by CloudFront through Origin Access
    // Control (CAP-16). No website hosting, no public policy.
    this.webBucket = new Bucket(this, 'Web', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: disposable,
    });

    // HTTPS on the default *.cloudfront.net domain; price class 100 (EU + North America), compression, HTTP/2+3.
    // Deep paths (/cap/<id>) reach S3 as missing keys → the SPA's index.html with 200, so the client router decides.
    this.distribution = new Distribution(this, 'WebDistribution', {
      comment: `${resourceName(deployment, 'web')} — CapCollector web build`,
      defaultRootObject: 'index.html',
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        // CDK's IBucket declares `isWebsite?: boolean`, which exactOptionalPropertyTypes rejects for a concrete Bucket.
        origin: S3BucketOrigin.withOriginAccessControl(this.webBucket as IBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      errorResponses: SPA_FALLBACK_STATUSES.map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });
    this.webUrl = `https://${this.distribution.distributionDomainName}`;

    // Cap photos (WebP ≤ 1024 px, uploaded with presigned PUT from the app). Private, versioned, IA after 90 days.
    // SPEC-GAP CAP-13: the web domain is not chosen yet (ADR-008), so CORS allows the origins declared in
    // infra/config/<installation>.<stage>.json plus this stack's own CloudFront origin (CAP-16).
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
          allowedOrigins: [...config.app_origins, this.webUrl],
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

    // API settings filled by hand (CAP-15): created here, not in CollectorsApi, so they exist before the API stack
    // resolves them at deploy time. SPEC-GAP CAP-15: plain String parameters, because CloudFormation cannot create a
    // SecureString and Lambda env cannot resolve one; the values end up in the functions' (encrypted) environment.
    const setting = (name: SecretName) =>
      new StringParameter(this, `Setting${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`, {
        parameterName: settingParameterName(deployment, name),
        stringValue: UNSET_PARAMETER_VALUE,
        description: `CapCollector ${SECRET_ENV[name]} — filled by Edu, never committed`,
      });
    this.settings = {
      allowedAppleSubs: setting('allowedAppleSubs'),
      appleClientIds: setting('appleClientIds'),
      sessionSecret: setting('sessionSecret'),
    };

    // Exported for CollectorsApi (and for Edu's console checks after deploy).
    const out = (key: string, value: string, description: string) =>
      new CfnOutput(this, key, { value, description, exportName: `${resourceName(deployment, 'data')}-${key}` });
    out('TableName', this.table.tableName, 'DynamoDB single table');
    out('TableArn', this.table.tableArn, 'DynamoDB single table ARN');
    out('ImagesBucketName', this.imagesBucket.bucketName, 'S3 bucket for cap images (presigned PUT/GET)');
    out('WebBucketName', this.webBucket.bucketName, 'S3 bucket for the static web build');
    out('WebUrl', this.webUrl, 'HTTPS URL of the web build (app_origins, Apple return URL until EP-09)');
    out('DistributionId', this.distribution.distributionId, 'CloudFront distribution of the web build');
  }
}
