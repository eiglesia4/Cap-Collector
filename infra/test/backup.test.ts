// Backups (CAP-57, EP-09): the AWS Backup vault + daily plan for the table, the images bucket lifecycle that expires
// noncurrent versions, and the four cost tags on the new Backup resources (ADR-002, ADR-006, CONVENTIONS § AWS tagging).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import { BACKUP_SCHEDULE, backupName } from '../lib/backup.js';
import {
  ABORT_MULTIPART_AFTER_DAYS,
  CollectorsDataStack,
  IMAGES_IA_AFTER_DAYS,
  IMAGES_NONCURRENT_EXPIRY_DAYS,
} from '../lib/collectors-data-stack.js';
import { loadInstallationConfig, PROJECT_TAG_VALUE, USER_NAME_TAG_VALUE } from '../lib/config.js';

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

const deployment = { installation: 'naeva', stage: 'dev' };
const config = loadInstallationConfig(deployment);

/** The committed naeva.dev target, built through the app (so the tags are the real ones). */
const devTemplate = () => Template.fromStack(buildApp(new App({ context: deployment })).data);

/** A stage / retention without a config file in the repo, built directly. */
const stackFor = (stage: string, backupRetentionDays: number) =>
  Template.fromStack(
    new CollectorsDataStack(new App(), 'CollectorsData', {
      deployment: { installation: 'naeva', stage },
      config: { ...config, ops: { ...config.ops, backupRetentionDays } },
    }),
  );

const tableRef = (t: Template) => {
  const [id] = Object.keys(t.findResources('AWS::DynamoDB::Table'));
  return { 'Fn::GetAtt': [id, 'Arn'] };
};

describe('Backups', () => {
  it('[T-infra-036] AWS Backup: vault + daily plan (03:00 UTC, retention from config, no cold storage) selecting the table; ops.backupRetentionDays validated', () => {
    expect(config.ops.backupRetentionDays).toBe(35);
    const dev = devTemplate();
    dev.resourceCountIs('AWS::Backup::BackupVault', 1);
    dev.resourceCountIs('AWS::Backup::BackupPlan', 1);
    dev.resourceCountIs('AWS::Backup::BackupSelection', 1);
    dev.hasResourceProperties('AWS::Backup::BackupVault', { BackupVaultName: 'cap-naeva-dev' });
    expect(backupName(deployment)).toBe('cap-naeva-dev');
    const [vaultId] = Object.keys(dev.findResources('AWS::Backup::BackupVault'));
    dev.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: {
        BackupPlanName: 'cap-naeva-dev',
        BackupPlanRule: [
          {
            RuleName: 'daily',
            ScheduleExpression: `cron(${BACKUP_SCHEDULE.minute} ${BACKUP_SCHEDULE.hour} * * ? *)`,
            // Cold storage off: no MoveToColdStorageAfterDays, so nothing has the 90-day cold minimum.
            Lifecycle: { DeleteAfterDays: 35, MoveToColdStorageAfterDays: Match.absent() },
            TargetBackupVault: { 'Fn::GetAtt': [vaultId, 'BackupVaultName'] },
          },
        ],
      },
    });
    expect(BACKUP_SCHEDULE).toEqual({ hour: 3, minute: 0 });
    // The selection targets the table through its construct reference, never a literal ARN.
    dev.hasResourceProperties('AWS::Backup::BackupSelection', {
      BackupSelection: { Resources: [tableRef(dev)], SelectionName: 'cap-naeva-dev-table' },
    });
    // PITR stays on.
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });

    // Retention comes from config; the vault follows the stack's removal policy.
    dev.hasResource('AWS::Backup::BackupVault', { DeletionPolicy: 'Delete' });
    const prod = stackFor('prod', 90);
    prod.hasResource('AWS::Backup::BackupVault', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    prod.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: {
        BackupPlanName: 'cap-naeva-prod',
        BackupPlanRule: [Match.objectLike({ Lifecycle: { DeleteAfterDays: 90 } })],
      },
    });

    // Validation: whole days ≥ 1, required.
    const dir = mkdtempSync(join(tmpdir(), 'cap-backup-'));
    const load = (backupRetentionDays?: unknown) => {
      const ops = {
        budgetEur: 10,
        logRetentionDays: 30,
        ...(backupRetentionDays !== undefined && { backupRetentionDays }),
      };
      writeFileSync(
        join(dir, 'naeva.dev.json'),
        JSON.stringify({ config_version: 'v', region: 'r', ai: config.ai, ops }),
      );
      return loadInstallationConfig(deployment, dir);
    };
    expect(load(1).ops.backupRetentionDays).toBe(1);
    for (const bad of [undefined, 0, -1, 1.5, '35', Number.NaN]) {
      expect(() => load(bad), String(bad)).toThrow(/"ops\.backupRetentionDays"/);
    }
  });

  it('[T-infra-037] images bucket lifecycle: IA transition plus noncurrent-version expiry and multipart abort; web bucket untouched', () => {
    const dev = devTemplate();
    dev.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'images-to-ia',
            Status: 'Enabled',
            Transitions: [{ StorageClass: 'STANDARD_IA', TransitionInDays: IMAGES_IA_AFTER_DAYS }],
            NoncurrentVersionExpiration: { NoncurrentDays: IMAGES_NONCURRENT_EXPIRY_DAYS },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_MULTIPART_AFTER_DAYS },
            // No noncurrent IA transition: S3 refuses one on the same day as the expiry.
            NoncurrentVersionTransitions: Match.absent(),
          },
        ],
      },
    });
    expect(IMAGES_NONCURRENT_EXPIRY_DAYS).toBe(90);
    expect(ABORT_MULTIPART_AFTER_DAYS).toBe(7);
    // The web bucket is not versioned, so it gets no noncurrent rule (and no lifecycle at all).
    const buckets = Object.values(dev.findResources('AWS::S3::Bucket'));
    expect(buckets).toHaveLength(2);
    const web = buckets.find((b) => !(b.Properties as Record<string, unknown>).VersioningConfiguration);
    expect(web?.Properties).not.toHaveProperty('LifecycleConfiguration');
  });

  it('[T-infra-038] tags: the Backup vault, plan and selection role carry project, UserName, installation, stage', () => {
    const dev = devTemplate();
    const expected = {
      project: PROJECT_TAG_VALUE,
      UserName: USER_NAME_TAG_VALUE,
      installation: deployment.installation,
      stage: deployment.stage,
    };
    dev.hasResourceProperties('AWS::Backup::BackupVault', { BackupVaultTags: Match.objectLike(expected) });
    dev.hasResourceProperties('AWS::Backup::BackupPlan', { BackupPlanTags: Match.objectLike(expected) });
    dev.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Principal: { Service: 'backup.amazonaws.com' } })],
      }),
      // CDK sorts tags by key; arrayWith matches in order.
      Tags: Match.arrayWith(
        Object.entries(expected)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([Key, Value]) => ({ Key, Value })),
      ),
    });
  });
});
