// GET /scans — recent scans, newest first, cursor-paged; for threshold tuning and AI cost (openapi.yaml /scans, CAP-37).
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';
import { ScanListQuery, listScans } from '../lib/scans.js';

export const handler = defineHandler({ auth: true, query: ScanListQuery }, async (req) =>
  ok(await listScans(getRepositories(), req.uid, req.query)),
);
