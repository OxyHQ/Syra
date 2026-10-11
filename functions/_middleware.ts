interface PagesContext {
  next: () => Promise<Response>;
}

// Both Pages deployments run from the repository root, sharing this middleware.
// It is a pure pass-through: the asset or navigation response, and any failure,
// reach the visitor exactly as Pages produced them.
export function onRequest(context: PagesContext): Promise<Response> {
  return context.next();
}
