// Test env for handlers that sign S3 URLs (CAP-20, CAP-30): a valid config plus static fake credentials, so presigning
// works offline and never picks up the developer's AWS profile. Restores the environment afterwards.
import { afterEach, beforeEach } from 'vitest';

import { resetConfig } from '../../src/lib/config.js';
import { resetS3 } from '../../src/lib/images.js';

export const TEST_BUCKET = 'cap-dev-images';

export function useAwsTestEnv(): void {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      CAP_TABLE_NAME: 'cap-dev-table',
      CAP_IMAGES_BUCKET: TEST_BUCKET,
      CAP_STAGE: 'dev',
      AWS_REGION: 'eu-west-1',
      AWS_ACCESS_KEY_ID: 'AKIDTEST',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    delete process.env.AWS_PROFILE;
    resetConfig();
    resetS3();
  });
  afterEach(() => {
    process.env = { ...saved };
    resetConfig();
    resetS3();
  });
}
