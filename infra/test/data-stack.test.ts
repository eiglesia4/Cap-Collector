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
      config: { config_version: 'test', region: 'test-region-1', app_origins: ['capacitor://localhost'] },
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

  it('[T-infra-010] buckets: private versioned images with IA lifecycle and CORS, public website; outputs exported', () => {
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
            AllowedOrigins: Match.arrayWith(['capacitor://localhost', 'http://localhost:5173']),
          }),
        ],
      },
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      WebsiteConfiguration: { IndexDocument: 'index.html', ErrorDocument: 'index.html' },
    });
    // TLS is enforced on the images bucket only (the website endpoint is HTTP).
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      },
    });
    for (const key of ['TableName', 'TableArn', 'ImagesBucketName', 'WebBucketName', 'WebsiteUrl']) {
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
      writeFileSync(join(dir, 'naeva.dev.json'), JSON.stringify({ config_version: 'v', region: 'r', ...extra }));

    write({});
    expect(loadInstallationConfig(target, dir).app_origins).toEqual([]);
    write({ app_origins: ['capacitor://localhost', 'https://caps.example.org:8443'] });
    expect(loadInstallationConfig(target, dir).app_origins).toHaveLength(2);
    for (const bad of ['https://caps.example.org/path', 'caps.example.org', 42]) {
      write({ app_origins: [bad] });
      expect(() => loadInstallationConfig(target, dir)).toThrow(/"app_origins" must be a list/);
    }
    write({ app_origins: 'capacitor://localhost' });
    expect(() => loadInstallationConfig(target, dir)).toThrow(/"app_origins" must be a list/);
  });
});
