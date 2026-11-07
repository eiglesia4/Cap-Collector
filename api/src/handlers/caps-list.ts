// GET /caps — list / search with filters, sort and cursor; `total` for collections ≤ 5 000 (openapi.yaml CapPage, CAP-18).
// Every item carries `imageUrls` (presigned GETs, v0.2, CAP-30).
import { listCaps, CapListQuery } from '../lib/caps.js';
import { defineHandler, ok } from '../lib/http.js';
import { withImageUrls } from '../lib/images.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, query: CapListQuery }, async (req) => {
  const page = await listCaps(getRepositories(), req.uid, req.query);
  return ok({ ...page, items: await Promise.all(page.items.map(withImageUrls)) });
});
