// Fake vision adapter for `npm run api:local` (CAP-39, `CAP_VISION=fake`): answers from the fixture files in
// api/test/fixtures/vision/*.json through the same parser as Bedrock (answer.ts), so the app can be developed without
// Bedrock or AWS credentials. The fixture is chosen by a stable hash of the top image key (same photo → same answer).
// Never used in a deployed Lambda (the bundle has no fixtures).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { IdentifyInput, IdentifyResult, VisionAdapter } from './adapter.js';
import { parseAnswer, toResult } from './answer.js';

export const FAKE_FIXTURES_DIR = fileURLToPath(new URL('../../../test/fixtures/vision/', import.meta.url));
export const FAKE_MODEL_ID = 'fake';

export class FakeVisionAdapter implements VisionAdapter {
  private readonly answers: string[];

  constructor(dir: string = FAKE_FIXTURES_DIR) {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    if (files.length === 0) throw new Error(`no vision fixtures in ${dir}`);
    this.answers = files.map((f) => readFileSync(`${dir}${f}`, 'utf8'));
  }

  async identify(input: IdentifyInput): Promise<IdentifyResult> {
    let h = 0;
    for (const ch of input.imageKeys.top) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const answer = this.answers[h % this.answers.length]!;
    return toResult(parseAnswer(answer), FAKE_MODEL_ID);
  }
}
