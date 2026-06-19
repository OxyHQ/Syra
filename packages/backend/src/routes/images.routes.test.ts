import { describe, expect, it } from 'bun:test';
import imagesAuthRoutes from './images.auth.routes';
import imagesPublicRoutes from './images.public.routes';

interface ExpressRouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
}

interface RouterWithStack {
  stack: ExpressRouteLayer[];
}

function routeMethods(router: RouterWithStack): string[] {
  return router.stack
    .flatMap((layer) => {
      const route = layer.route;
      if (!route) {
        return [];
      }

      return Object.entries(route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => `${method.toUpperCase()} ${route.path}`);
    })
    .sort();
}

describe('image routes', () => {
  it('keeps public image reads separate from authenticated uploads', () => {
    expect(routeMethods(imagesPublicRoutes as RouterWithStack)).toEqual(['GET /:id']);
    expect(routeMethods(imagesAuthRoutes as RouterWithStack)).toEqual(['POST /upload']);
  });
});
