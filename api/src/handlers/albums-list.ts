// GET /albums — every album, box and frame of the user, by letter (openapi.yaml /albums, ADR-005, CAP-49).
import { listAlbums } from '../lib/albums.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true }, async (req) =>
  ok(await listAlbums({ repos: getRepositories() }, req.uid)),
);
