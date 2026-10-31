/**
 * The two stacks of ADR-002 / CONVENTIONS § Code. Empty in the V0 skeleton (CAP-11):
 * - CollectorsData: S3 (images + static web) and the single DynamoDB table (doc/spec/specs/data-model.md).
 * - CollectorsApi: Lambda handlers, API Gateway HTTP API, auth (Sign in with Apple).
 * No VPC, no NAT, no always-on compute (CONVENTIONS § Cost rules).
 */
import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { Deployment } from './config.js';

export type CapStackProps = StackProps & { readonly deployment: Deployment };

export class CollectorsDataStack extends Stack {
  constructor(scope: Construct, id: string, props: CapStackProps) {
    super(scope, id, props);
  }
}

export class CollectorsApiStack extends Stack {
  constructor(scope: Construct, id: string, props: CapStackProps) {
    super(scope, id, props);
  }
}
