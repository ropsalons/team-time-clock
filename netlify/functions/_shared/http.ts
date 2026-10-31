// Small HTTP helpers for Netlify Functions v2 (Web Request/Response).

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

export function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw error(400, 'bad_json', 'Request body must be valid JSON.');
  }
}

/** Throwable Response guard: enforce a single HTTP method. */
export function requireMethod(req: Request, method: string): void {
  if (req.method !== method) throw error(405, 'method_not_allowed', `Use ${method}.`);
}
