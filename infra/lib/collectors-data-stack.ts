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
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
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
import type { SettingName } from './routes.js';
import { addTableBackup } from './backup.js';
import { retainProviderLogs } from './ops.js';
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

/** Overwritten or deleted photos (noncurrent versions) are expired after this many days (CAP-57). */
export const IMAGES_NONCURRENT_EXPIRY_DAYS = 90;

/** Multipart uploads never completed are aborted after this many days (CAP-13, kept by CAP-57). */
export const ABORT_MULTIPART_AFTER_DAYS = 7;

const str = (name: string) => ({ name, type: AttributeType.STRING });

/**
 * Placeholder `settings:bootstrap` writes in a missing setting (CAP-60); Edu overwrites it (`aws ssm put-parameter
 * --overwrite`). The API must refuse it.
 */
export const UNSET_PARAMETER_VALUE = 'unset';

/** CloudFormation export name of a CollectorsData output (CollectorsApi imports `WebUrl` for CORS, CAP-27). */
export const dataExportName = (deployment: Deployment, key: string): string =>
  `${resourceName(deployment, 'data')}-${key}`;

/** `/cap/<installation>/<stage>/<setting>`, e.g. `/cap/naeva/dev/session-secret`. */
export const settingParameterName = (deployment: Deployment, name: SettingName): string =>
  `/cap/${deployment.installation}/${deployment.stage}/${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

export class CollectorsDataStack extends Stack {
  readonly table: Table;
  readonly imagesBucket: Bucket;
  readonly webBucket: Bucket;
  readonly distribution: Distribution;
  /** `https://<domains.web>` when config declares it (CAP-29), else `https://<id>.cloudfront.net`. */
  readonly webUrl: string;

  constructor(scope: Construct, id: string, props: CollectorsDataStackProps) {
    super(scope, id, props);
    const { deployment, config } = props;
    const disposable = isDisposableStage(deployment);
    const removalPolicy = disposable ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // Static web for the Mac (ADR-001, ADR-008 §3): a private bucket read only by CloudFront through Origin Access
    // Control (CAP-16). No website hosting, no public policy. Not versioned, so no noncurrent-version rule (CAP-57).
    this.webBucket = new Bucket(this, 'Web', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: disposable,
    });

    // Custom domain (CAP-29): the us-east-1 ACM certificate whose ARN Edu stores in SSM, resolved at deploy time.
    // DNS stays at GoDaddy: a CNAME from domains.web to the `WebDomainTarget` output. No Route 53.
    const webDomain = config.domains?.web;
    const webCertificate = webDomain
      ? Certificate.fromCertificateArn(
          this,
          'WebCertificate',
          StringParameter.valueForStringParameter(this, settingParameterName(deployment, 'webCertificateArn')),
        )
      : undefined;

    // HTTPS on the default *.cloudfront.net domain (plus domains.web when set); price class 100 (EU + North America),
    // compression, HTTP/2+3. Deep paths (/cap/<id>) reach S3 as missing keys → the SPA's index.html with 200.
    this.distribution = new Distribution(this, 'WebDistribution', {
      ...(webDomain && webCertificate && { domainNames: [webDomain], certificate: webCertificate }),
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
    this.webUrl = `https://${webDomain ?? this.distribution.distributionDomainName}`;

    // Cap photos (WebP ≤ 1024 px, uploaded with presigned PUT from the app). Private, versioned, IA after 90 days;
    // noncurrent versions (overwritten / deleted photos) expire after 90 days so they don't accumulate (CAP-57). They
    // are expired, not moved to IA first: S3 rejects a noncurrent transition on the same day as the expiry, and IA
    // bills a 30-day minimum, so the transition CAP-13 had for them would only add cost.
    // CORS allows the origins declared in infra/config/<installation>.<stage>.json plus this stack's own web URL:
    // the custom domain when config declares one (CAP-29), else the CloudFront origin (CAP-16).
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
          noncurrentVersionExpiration: Duration.days(IMAGES_NONCURRENT_EXPIRY_DAYS),
          abortIncompleteMultipartUploadAfter: Duration.days(ABORT_MULTIPART_AFTER_DAYS),
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

    // Daily AWS Backup of the table (CAP-57); the vault follows the stack's removal policy.
    addTableBackup(this, deployment, this.table, config.ops.backupRetentionDays, removalPolicy);

    // API settings (CAP-15, CAP-29, CAP-40) are NOT created here (CAP-60): their values are Edu's, and a CDK-owned
    // parameter either collides with an existing one or resets a real value to `unset` on any template change. The
    // stacks only read them (`valueForStringParameter` → an `AWS::SSM::Parameter::Value<String>` template parameter,
    // which fails the deploy with a clear message if one is missing). Creation: `npm run settings:bootstrap`
    // (infra/README.md § Settings). SPEC-GAP CAP-15 stands: plain String parameters, since Lambda env cannot resolve
    // a SecureString; the values end up in the functions' (encrypted) environment.

    // Exported for CollectorsApi (and for Edu's console checks after deploy).
    const out = (key: string, value: string, description: string) =>
      new CfnOutput(this, key, { value, description, exportName: dataExportName(deployment, key) });
    out('TableName', this.table.tableName, 'DynamoDB single table');
    out('TableArn', this.table.tableArn, 'DynamoDB single table ARN');
    out('ImagesBucketName', this.imagesBucket.bucketName, 'S3 bucket for cap images (presigned PUT/GET)');
    out('WebBucketName', this.webBucket.bucketName, 'S3 bucket for the static web build');
    out('WebUrl', this.webUrl, 'HTTPS URL of the web build (custom domain when config declares domains.web)');
    out('DistributionId', this.distribution.distributionId, 'CloudFront distribution of the web build');
    if (webDomain) {
      new CfnOutput(this, 'WebDomainTarget', {
        value: this.distribution.distributionDomainName,
        description: `GoDaddy CNAME value for ${webDomain}`,
      });
    }

    // CAP-51: the S3 auto-delete provider (dev only) is a Lambda CDK creates itself; its log group gets the configured
    // retention too, so no log group in this stack is "never expire".
    retainProviderLogs(this, config.ops.logRetentionDays, removalPolicy);
  }
}
