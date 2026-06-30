import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Minimal structural shape shared by zod schemas across major versions. The
 * backend pins zod v4 while `@syra/shared-types` is built against zod v3, so
 * typing against a concrete `ZodSchema` would reject the shared schemas. Both
 * versions expose `.parse(data)` and throw an error carrying an `issues` array,
 * which is all this middleware relies on.
 */
interface ParsableSchema {
  parse: (data: unknown) => unknown;
}

interface ValidationSchemas {
  body?: ParsableSchema;
  query?: ParsableSchema;
  params?: ParsableSchema;
}

interface ZodLikeIssue {
  path: (string | number)[];
  message: string;
}

function isZodError(error: unknown): error is { issues: ZodLikeIssue[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query) as typeof req.query;
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as typeof req.params;
      }
      next();
    } catch (error) {
      if (isZodError(error)) {
        return res.status(400).json({
          error: 'Validation failed',
          details: error.issues.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
      }
      next(error);
    }
  };
}
