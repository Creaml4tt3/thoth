import { newStableId } from "@thoth/domain";
import type { ApiResult, TestEnv, TestPrincipal } from "./helpers.ts";

export const uuid = newStableId;

export async function createPage(env: TestEnv, who: TestPrincipal, workspaceId: string, input: { id?: string; title?: string; markdown?: string; parentId?: string | null } = {}): Promise<{ id: string; revisionId: string; res: ApiResult }> {
  const id = input.id ?? uuid();
  const res = await env.api(who, "PUT", `/workspaces/${workspaceId}/pages/${id}`, {
    headers: { "if-none-match": "*" },
    json: { title: input.title ?? "Page", markdown: input.markdown ?? "# Page\n", ...(input.parentId === undefined ? {} : { parentId: input.parentId }) },
  });
  if (res.status !== 201) throw new Error(`create page failed: ${res.status} ${res.text}`);
  return { id, revisionId: res.json.revision.id, res };
}

export async function uploadAttachment(env: TestEnv, who: TestPrincipal, workspaceId: string, bytes: Buffer = Buffer.from("bytes")): Promise<string> {
  const res = await env.api(who, "POST", `/workspaces/${workspaceId}/attachments`, { headers: { "content-type": "application/octet-stream" }, body: bytes });
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${res.text}`);
  return res.json.id;
}

export function toWorkspacePlan(pageId = uuid(), operationId = uuid(), markdown = "# staged\n") {
  return { operationId, direction: "to_workspace" as const, mode: "copy" as const, pages: [{ sourceId: "local:x", pageId, parentId: null, title: "Staged", markdown }] };
}

export async function createTransfer(env: TestEnv, who: TestPrincipal, workspaceId: string, plan: Record<string, unknown> & { operationId: string }): Promise<ApiResult> {
  return env.api(who, "POST", `/workspaces/${workspaceId}/transfers`, { headers: { "idempotency-key": plan.operationId }, json: plan });
}

/** Opens an SSE stream; resolves once the response headers arrive. `events()` reads `changes` events until `n` arrived or time ran out. */
export async function openEvents(env: TestEnv, who: TestPrincipal | null, workspaceId: string, baseUrl = env.url) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/v1/workspaces/${workspaceId}/events`, { headers: { ...(who?.headers ?? {}), accept: "text/event-stream" }, signal: controller.signal });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const received: { event: string; data: any }[] = [];
  // One outstanding read at a time: a read that lost a race against a timer must not swallow the next chunk.
  let pending: ReturnType<NonNullable<typeof reader>["read"]> | null = null;
  async function until(predicate: (events: typeof received) => boolean, timeoutMs = 5000): Promise<typeof received> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(received)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !reader) return received;
      pending ??= reader.read();
      const chunk = await Promise.race([pending, new Promise<"t">((r) => setTimeout(() => r("t"), remaining))]);
      if (chunk === "t") return received;
      pending = null;
      if (chunk.done) return received;
      buffer += decoder.decode(chunk.value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data) received.push({ event, data: JSON.parse(data) });
      }
    }
    return received;
  }
  return { status: res.status, contentType: res.headers.get("content-type"), text: reader ? null : await res.text(), received, until, close: () => controller.abort() };
}
