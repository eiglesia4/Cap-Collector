// GET /albums/{albumId}/next-free — first empty pocket in row-major order, proposed on save (openapi.yaml NextFree,
// physical-link.md § Location code, CAP-49). Walks sheets with one GSI1 query each and stops at the first gap.
import { AlbumIdPath, nextFree } from '../lib/albums.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, path: AlbumIdPath }, async (req) =>
  ok(await nextFree({ repos: getRepositories() }, req.uid, req.path.albumId)),
);
