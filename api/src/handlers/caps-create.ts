// POST /caps — create a cap after one of the three review screens (openapi.yaml /caps post, ADR-003, CAP-18).
import { CapCreateBody, createCap } from '../lib/caps.js';
import { created, defineHandler } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, body: CapCreateBody }, async (req) =>
  created(await createCap(getRepositories(), req.uid, req.body)),
);
