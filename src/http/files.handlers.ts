import type { RequestHandler } from 'express';
import { FileError, FilesService } from '../files/files.service';

/** All behind requireAuth (HW #24): req.auth.sub is the owner. */
export function createFilesHandlers(files: FilesService) {
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (err) {
        if (err instanceof FileError) return next(Object.assign(new Error(err.message), { status: err.status }));
        next(err);
      }
    };

  return {
    // POST /uploads/intent
    intent: wrap(async (req, res) => {
      const result = await files.intent(
        req.auth!.sub,
        { filename: req.body.filename, contentType: req.body.content_type, size: req.body.size },
        req.header('idempotency-key') || undefined,
      );
      if (result.replayed) res.set('Idempotency-Replay', 'true');
      const { replayed: _replayed, ...body } = result;
      // presigned URLs are credentials: no shared cache may keep them
      res.set('Cache-Control', 'no-store').json(body);
    }),

    // GET /uploads/:fileId/parts
    parts: wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await files.parts(req.auth!.sub, String(req.params.fileId)));
    }),

    // POST /uploads/commit
    commit: wrap(async (req, res) => {
      res.json(await files.commit(req.auth!.sub, req.body.file_id));
    }),

    // GET /files/:fileId → 302 to a one-minute presigned GET
    download: wrap(async (req, res) => {
      const url = await files.downloadUrl(req.auth!.sub, String(req.params.fileId));
      res.set('Cache-Control', 'no-store').redirect(302, url);
    }),
  };
}
