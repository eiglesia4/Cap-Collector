/**
 * CollectorsApi (ADR-002): Lambda handlers, API Gateway HTTP API, auth (Sign in with Apple). Empty until the API
 * stack story; CollectorsData lives in collectors-data-stack.ts (CAP-13).
 * No VPC, no NAT, no always-on compute (CONVENTIONS § Cost rules).
 */
import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { Deployment } from './config.js';

export type CapStackProps = StackProps & { readonly deployment: Deployment };

export class CollectorsApiStack extends Stack {
  constructor(scope: Construct, id: string, props: CapStackProps) {
    super(scope, id, props);
  }
}
