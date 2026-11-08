// Table backups (CAP-57, EP-09): an AWS Backup vault + daily plan selecting the single table. PITR on the table stays
// the fine-grained net (35 days, any second); this is the daily, independently stored copy. Backups are the last line
// against a bug, not against the user — that is soft delete's job (ADR-006). Restores always go to a NEW table
// (infra/README.md § Backups).
import { Duration, type RemovalPolicy, type Stack } from 'aws-cdk-lib';
import { BackupPlan, BackupPlanRule, BackupResource, BackupVault } from 'aws-cdk-lib/aws-backup';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Schedule } from 'aws-cdk-lib/aws-events';

import type { Deployment } from './config.js';

/** Daily at 03:00 UTC (CAP-57): after the Spanish evening's captures, before the morning. Cold storage off. */
export const BACKUP_SCHEDULE = { hour: 3, minute: 0 } as const;

/** Vault and plan share the deployment's base name, `cap-<installation>-<stage>` (CAP-57). */
export const backupName = (deployment: Deployment): string => `cap-${deployment.installation}-${deployment.stage}`;

export function addTableBackup(
  stack: Stack,
  deployment: Deployment,
  table: Table,
  retentionDays: number,
  removalPolicy: RemovalPolicy,
): { vault: BackupVault; plan: BackupPlan } {
  const name = backupName(deployment);
  // Encrypted with the AWS-managed `aws/backup` key: no customer KMS key to pay for (CONVENTIONS § Cost rules).
  const vault = new BackupVault(stack, 'BackupVault', { backupVaultName: name, removalPolicy });
  const plan = new BackupPlan(stack, 'BackupPlan', {
    backupPlanName: name,
    backupVault: vault,
    backupPlanRules: [
      new BackupPlanRule({
        ruleName: 'daily',
        scheduleExpression: Schedule.cron({
          hour: String(BACKUP_SCHEDULE.hour),
          minute: String(BACKUP_SCHEDULE.minute),
        }),
        deleteAfter: Duration.days(retentionDays),
      }),
    ],
  });
  // Selected by the construct's ARN reference, never a literal (CLAUDE.md § infra).
  plan.addSelection('Table', {
    backupSelectionName: `${name}-table`,
    resources: [BackupResource.fromDynamoDbTable(table)],
  });
  return { vault, plan };
}
