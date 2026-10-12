// Express 4 does not catch errors thrown by async handlers: the rejection goes unhandled and
// Node ends the process, taking the user's live connection to their Flex with it. This router
// turns any such error into a 500 for that one request.
import { Router, type NextFunction, type Request, type Response } from 'express';

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

export function safeRouter(): Router {
  const router = Router();
  for (const method of ['get', 'post', 'put', 'delete'] as const) {
    const original = router[method].bind(router) as (path: string, ...h: Handler[]) => Router;
    (router as unknown as Record<string, unknown>)[method] = (path: string, ...handlers: Handler[]) =>
      original(path, ...handlers.map((h) => (req: Request, res: Response, next: NextFunction) => {
        try {
          return Promise.resolve(h(req, res, next)).catch((e) => fail(e, res, next));
        } catch (e) {
          return fail(e, res, next);
        }
      }));
  }
  return router;
}

function fail(e: unknown, res: Response, next: NextFunction) {
  if (res.headersSent) return next(e);
  res.status(500).json({ error: `server error: ${(e as Error)?.message ?? String(e)}` });
}
