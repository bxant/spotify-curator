// Scripted fetch for client tests: no network, records every call.

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function fakeFetch(responder: Responder) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: body === undefined || body === null ? undefined : String(body),
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}
