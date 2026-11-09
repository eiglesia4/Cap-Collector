// CollectorsData stack (CAP-13): table, GSIs, TTL, PITR, buckets, removal policy per stage and exported outputs.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GSI_PROJECTION, INDEXES } from '@capcollector/shared';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import { CollectorsDataStack, IMAGES_IA_AFTER_DAYS } from '../lib/collectors-data-stack.js';
import { loadInstallationConfig } from '../lib/config.js';

const ENV_KEYS = ['CDK_DEFAULT_ACCOUNT', 'CAP_ACCOUNT_NAEVA_DEV', 'CAP_INSTALLATION', 'CAP_STAGE'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const devTemplate = () =>
  Template.fromStack(buildApp(new App({ context: { installation: 'naeva', stage: 'dev' } })).data);

/** A stage without a config file in the repo, built directly so no prod target has to exist yet. */
const stackFor = (stage: string) =>
  Template.fromStack(
    new CollectorsDataStack(new App(), 'CollectorsData', {
      deployment: { installation: 'naeva', stage },
      config: {
        config_version: 'test',
        region: 'test-region-1',
        app_origins: ['https://localhost'],
        ai: { modelId: 'anthropic.claude-test-v1:0', dhashThreshold: 10 },
        ops: { budgetEur: 10, logRetentionDays: 30, backupRetentionDays: 35 },
      },
    }),
  );

describe('CollectorsData stack', () => {
  it('[T-infra-008] synthesised table matches data-model.md: keys, GSI1/GSI2 projections, TTL, PITR, on-demand', () => {
    const template = devTemplate();
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    const tables = template.findResources('AWS::DynamoDB::Table');
    const table = Object.values(tables)[0] as { Properties: Record<string, unknown> };

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: INDEXES.location,
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: [...GSI_PROJECTION] },
        }),
        Match.objectLike({
          IndexName: INDEXES.brand,
          KeySchema: [
            { AttributeName: 'gsi2pk', KeyType: 'HASH' },
            { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: [...GSI_PROJECTION] },
        }),
      ]),
    });
    // The snapshot pins the whole table definition: any key/index change shows up as a reviewed diff.
    expect(table.Properties).toMatchSnapshot();
  });

  it('[T-infra-010] buckets: private versioned images with IA lifecycle and CORS, private web bucket; outputs exported', () => {
    const template = devTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Status: 'Enabled',
            Transitions: [{ StorageClass: 'STANDARD_IA', TransitionInDays: IMAGES_IA_AFTER_DAYS }],
          }),
        ],
      },
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedOrigins: Match.arrayWith(['https://localhost', 'http://localhost:5173']),
          }),
        ],
      },
    });
    // Since CAP-16 both buckets are private (the web one is read by CloudFront only) and neither hosts a website.
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      WebsiteConfiguration: Match.absent(),
    });
    // TLS is enforced on both buckets.
    const tlsDeny = template.findResources('AWS::S3::BucketPolicy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
          ]),
        },
      },
    });
    expect(Object.keys(tlsDeny)).toHaveLength(2);
    for (const key of ['TableName', 'TableArn', 'ImagesBucketName', 'WebBucketName', 'WebUrl', 'DistributionId']) {
      template.hasOutput(key, { Export: { Name: `cap-naeva-dev-data-${key}` } });
    }
  });

  it('[T-infra-011] removal policy: dev is disposable (DESTROY + auto-delete), any other stage RETAINs data', () => {
    const dev = stackFor('dev');
    dev.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
    dev.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: false });
    expect(Object.keys(dev.findResources('Custom::S3AutoDeleteObjects'))).toHaveLength(2);

    for (const stage of ['prod', 'test']) {
      const kept = stackFor(stage);
      kept.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
      kept.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: true });
      kept.allResources('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
      kept.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
    }
  });

  it('[T-infra-014] every stack carries project, UserName, installation and stage on the table and both buckets', () => {
    const built = buildApp(new App({ context: { installation: 'naeva', stage: 'dev' } }));
    const expected = [
      { Key: 'project', Value: 'EIM_CAP' },
      { Key: 'UserName', Value: 'eiglesia4' },
      { Key: 'installation', Value: 'naeva' },
      { Key: 'stage', Value: 'dev' },
    ];
    const data = Template.fromStack(built.data);
    data.resourceCountIs('AWS::S3::Bucket', 2);
    for (const tag of expected) {
      data.allResourcesProperties('AWS::S3::Bucket', { Tags: Match.arrayWith([tag]) });
      data.allResourcesProperties('AWS::DynamoDB::Table', { Tags: Match.arrayWith([tag]) });
    }
    // Applied at app level, so the (still empty) API stack inherits them too: checked on the stack's own tags.
    for (const stack of [built.data, built.api]) {
      const tags = stack.tags.tagValues();
      expect(tags).toMatchObject({ project: 'EIM_CAP', UserName: 'eiglesia4', installation: 'naeva', stage: 'dev' });
    }
  });

  it('[T-infra-012] app_origins in config/ is optional and must be a list of bare origins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-config-'));
    const target = { installation: 'naeva', stage: 'dev' };
    const write = (extra: Record<string, unknown>) =>
      writeFileSync(
        join(dir, 'naeva.dev.json'),
        JSON.stringify({
          config_version: 'v',
          region: 'r',
          ai: { modelId: 'anthropic.claude-test-v1:0', dhashThreshold: 10 },
          ops: { budgetEur: 10, logRetentionDays: 30, backupRetentionDays: 35 },
          ...extra,
        }),
      );

    write({});
    expect(loadInstallationConfig(target, dir).app_origins).toEqual([]);
    write({ app_origins: ['https://localhost', 'https://caps.example.org:8443'] });
    expect(loadInstallationConfig(target, dir).app_origins).toHaveLength(2);
    for (const bad of ['https://caps.example.org/path', 'caps.example.org', 42]) {
      write({ app_origins: [bad] });
      expect(() => loadInstallationConfig(target, dir)).toThrow(/"app_origins" must be a list/);
    }
    write({ app_origins: 'https://localhost' });
    expect(() => loadInstallationConfig(target, dir)).toThrow(/"app_origins" must be a list/);
  });

  it('[T-infra-042] app_origins accepts only http(s) origins (API Gateway CORS); the committed config and both CORS lists comply', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-config-'));
    const target = { installation: 'naeva', stage: 'dev' };
    const load = (app_origins: unknown) => {
      writeFileSync(
        join(dir, 'naeva.dev.json'),
        JSON.stringify({
          config_version: 'v',
          region: 'r',
          app_origins,
          ai: { modelId: 'anthropic.claude-test-v1:0', dhashThreshold: 10 },
          ops: { budgetEur: 10, logRetentionDays: 30, backupRetentionDays: 35 },
        }),
      );
      return loadInstallationConfig(target, dir).app_origins;
    };
    expect(load(['https://localhost', 'http://localhost:5173'])).toEqual([
      'https://localhost',
      'http://localhost:5173',
    ]);
    for (const bad of [
      'capacitor://localhost', // "Invalid format for origin" in API Gateway (CAP-62)
      'localhost:5173',
      'https://x/',
      'ftp://example.org',
      'https://Localhost',
      'https://example.org:port',
    ]) {
      expect(() => load([bad]), bad).toThrow(/http\(s\) origins without a path/);
    }

    // The committed naeva/dev config: the iOS origin is https://localhost (CAP-61) and every origin the stacks hand
    // to API Gateway and S3 CORS is http(s) or a CloudFormation token (the imported WebUrl).
    expect(loadInstallationConfig(target).app_origins).toEqual(['https://localhost', 'http://localhost:5173']);
    const built = buildApp(new App({ context: { ...target, 'aws:cdk:bundling-stacks': [] } }));
    type Api = { Properties: { CorsConfiguration: { AllowOrigins: unknown[] } } };
    type Bucket = { Properties: { CorsConfiguration?: { CorsRules: { AllowedOrigins: unknown[] }[] } } };
    const api = Object.values(Template.fromStack(built.api).findResources('AWS::ApiGatewayV2::Api')) as Api[];
    const s3 = Object.values(Template.fromStack(built.data).findResources('AWS::S3::Bucket')) as Bucket[];
    const origins = [
      ...api.flatMap((r) => r.Properties.CorsConfiguration.AllowOrigins),
      ...s3.flatMap((r) => r.Properties.CorsConfiguration?.CorsRules.flatMap((c) => c.AllowedOrigins) ?? []),
    ];
    expect(origins.filter((o) => o === 'https://localhost')).toHaveLength(2);
    for (const o of origins) {
      if (typeof o === 'string') expect(o).toMatch(/^https?:\/\/[^/]+$/);
    }
  });
});
