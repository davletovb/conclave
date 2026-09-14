import type {
  Conversation,
  ConversationExportFormat,
  ConversationSummary,
  ModelRef,
  ProviderLimitSnapshot,
  ProviderStatus,
  RunInspection,
  StartRunRequest,
  StartRunResponse,
  StoredRun,
  WorkflowPreset,
} from "@conclave/core";

export const API = import.meta.env.VITE_CONCLAVE_API ?? "http://localhost:8787";

export async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

function get<T>(path: string, init?: RequestInit) {
  return fetch(`${API}${path}`, init).then(response => readJson<T>(response));
}

function withWebSearchPreference(body: StartRunRequest): StartRunRequest {
  const enabled = localStorage.getItem("conclave.webSearch") === "shared";
  if (!enabled) return body;
  return {
    ...body,
    request: {
      ...body.request,
      webSearch: body.request.webSearch ?? { mode: "shared", maxResults: 6 },
    },
  };
}

export const api = {
  models: () => get<ModelRef[]>("/models"),
  providers: () => get<ProviderStatus[]>("/providers"),
  limits: () => get<ProviderLimitSnapshot[]>("/provider-limits"),
  presets: () => get<WorkflowPreset[]>("/workflow-presets"),

  conversations: (query = "", signal?: AbortSignal) =>
    get<ConversationSummary[]>(`/conversations${query ? `?q=${encodeURIComponent(query)}` : ""}`, { signal }),
  conversation: (id: string) => get<Conversation>(`/conversations/${id}`),
  renameConversation: (id: string, title: string) => get<Conversation>(`/conversations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  }),
  deleteConversation: (id: string) => get<{ id: string; deleted: true }>(`/conversations/${id}`, { method: "DELETE" }),

  async exportConversation(id: string, format: ConversationExportFormat) {
    const response = await fetch(`${API}/conversations/${id}/export?format=${format}`);
    if (!response.ok) await readJson(response);
    const disposition = response.headers.get("content-disposition") ?? "";
    const named = /filename="([^"]+)"/.exec(disposition)?.[1];
    return { blob: await response.blob(), filename: named ?? `conclave-conversation.${format === "markdown" ? "md" : "json"}` };
  },

  startRun: (body: StartRunRequest) => get<StartRunResponse>("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withWebSearchPreference(body)),
  }),
  run: (id: string, signal?: AbortSignal) => get<StoredRun>(`/runs/${id}`, { signal }),
  inspection: (id: string) => get<RunInspection>(`/runs/${id}/inspection`),
  cancelRun: (id: string) => get<StoredRun>(`/runs/${id}/cancel`, { method: "POST" }),
  resumeRun: (id: string) => get<StartRunResponse>(`/runs/${id}/resume`, { method: "POST" }),
  eventStream: (id: string, after: number, follow: boolean, signal?: AbortSignal) =>
    fetch(`${API}/runs/${id}/events?after=${after}&follow=${follow ? 1 : 0}`, { signal }),
};

/** Hands a generated file to the browser without leaking the object URL. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
