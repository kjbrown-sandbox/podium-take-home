export async function request(
  port: number,
  path: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: Record<string, string>; body: string; json: () => unknown }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: options.method ?? "GET",
    body: options.body,
    headers: options.headers,
  });
  const body = await res.text();
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body,
    json: () => JSON.parse(body),
  };
}
