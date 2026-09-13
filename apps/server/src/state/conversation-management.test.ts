import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRef } from "@conclave/core";
import { exportFilename, exportToMarkdown } from "./conversation-export.js";
import { conversationSnippet, matchesConversation, searchTerms } from "./conversation-search.js";
import { FileStateStore } from "./file-store.js";

const tempDirs: string[] = [];
const participant: ModelRef = { provider: "mock", model: "mock-gpt", label: "GPT (mock)" };
const critic: ModelRef = { provider: "mock", model: "mock-claude", label: "Claude (mock)" };

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "conclave-conversations-"));
  tempDirs.push(dir);
  const store = new FileStateStore(dir);
  await store.init();
  return { dir, store };
}

async function seed(store: FileStateStore, prompt: string, answer: string, conversationId?: string) {
  const created = await store.createRun({ mode: "single", prompt, participants: [participant] }, conversationId);
  await store.completeRun(created.run.id, {
    mode: "single",
    steps: [{ id: "answer-1", kind: "answer", model: participant, content: answer }],
    final: answer,
  });
  return created;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("conversation search", () => {
  it("keeps quoted phrases together and lowercases loose terms", () => {
    expect(searchTerms('  Vector "Event Sourcing"  DB ')).toEqual(["vector", "event sourcing", "db"]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("requires every term to appear somewhere in the conversation", () => {
    const conversation = {
      id: "c1",
      title: "Storage choices",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messages: [
        { id: "m1", role: "user" as const, content: "Should we use SQLite or Postgres?", createdAt: "x" },
        { id: "m2", role: "assistant" as const, content: "SQLite keeps the deployment local.", createdAt: "x" },
      ],
    };

    expect(matchesConversation(conversation, searchTerms("sqlite local"))).toBe(true);
    expect(matchesConversation(conversation, searchTerms("sqlite kubernetes"))).toBe(false);
    expect(matchesConversation(conversation, searchTerms("storage"))).toBe(true);
    expect(matchesConversation(conversation, [])).toBe(true);
  });

  it("returns an excerpt around the first message hit", () => {
    const conversation = {
      id: "c1",
      title: "Unrelated title",
      createdAt: "x",
      updatedAt: "x",
      messages: [
        { id: "m1", role: "user" as const, content: `${"filler ".repeat(40)}the watchdog fires after 180s${" trailing".repeat(40)}`, createdAt: "x" },
      ],
    };

    const snippet = conversationSnippet(conversation, searchTerms("watchdog"))!;
    expect(snippet).toContain("watchdog");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(conversationSnippet(conversation, [])).toBeUndefined();
  });
});

describe("FileStateStore conversation management", () => {
  it("filters listings by query and reports why each conversation matched", async () => {
    const { store } = await tempStore();
    await seed(store, "How should we cache provider models?", "Cache them in memory per process.");
    await seed(store, "Draft a migration plan", "Ship the watchdog timeout first.");

    const all = await store.listConversations();
    expect(all).toHaveLength(2);
    expect(all.every(item => item.snippet === undefined)).toBe(true);

    const hits = await store.listConversations({ query: "watchdog" });
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Draft a migration plan");
    expect(hits[0].snippet).toContain("watchdog");

    expect(await store.listConversations({ query: "cache provider" })).toHaveLength(1);
    expect(await store.listConversations({ query: "nothing here" })).toHaveLength(0);
    expect(await store.listConversations({ limit: 1 })).toHaveLength(1);
  });

  it("renames a conversation and rejects an empty title", async () => {
    const { dir, store } = await tempStore();
    const created = await seed(store, "Original prompt", "Original answer");

    const renamed = await store.renameConversation(created.conversation.id, "  Provider   adapters  ");
    expect(renamed.title).toBe("Provider adapters");

    await expect(store.renameConversation(created.conversation.id, "   ")).rejects.toThrow(/cannot be empty/);
    await expect(store.renameConversation("missing", "Title")).rejects.toThrow(/not found/);

    const reopened = new FileStateStore(dir);
    await reopened.init();
    expect((await reopened.getConversation(created.conversation.id))?.title).toBe("Provider adapters");
  });

  it("deletes a conversation with its runs and event logs", async () => {
    const { dir, store } = await tempStore();
    const kept = await seed(store, "Keep me", "Kept answer");
    const doomed = await seed(store, "Delete me", "Doomed answer");
    await store.appendRunEvent({
      seq: 1,
      attempt: 1,
      at: new Date().toISOString(),
      event: { type: "run_started", runId: doomed.run.id, mode: "single" },
    });

    await store.deleteConversation(doomed.conversation.id);

    expect(await store.getConversation(doomed.conversation.id)).toBeNull();
    expect(await store.getRun(doomed.run.id)).toBeNull();
    expect(await store.getConversation(kept.conversation.id)).not.toBeNull();

    const runFiles = await readdir(join(dir, "runs"));
    expect(runFiles.some(name => name.startsWith(doomed.run.id))).toBe(false);

    const reopened = new FileStateStore(dir);
    await reopened.init();
    expect(await reopened.listConversations()).toHaveLength(1);
    await expect(store.deleteConversation(doomed.conversation.id)).rejects.toThrow(/not found/);
  });

  it("exports the conversation with the council work behind each answer", async () => {
    const { store } = await tempStore();
    const created = await store.createRun({
      mode: "critic-revise",
      prompt: "Review this plan",
      participants: [participant, critic],
      synthesizer: critic,
    });
    await store.completeRun(created.run.id, {
      mode: "critic-revise",
      steps: [
        { id: "draft-1", kind: "answer", model: participant, content: "First draft" },
        { id: "critique-1", kind: "critique", model: critic, content: "Missing rollback", dependsOn: ["draft-1"] },
      ],
      final: "Revised plan with rollback",
    });

    const data = (await store.exportConversation(created.conversation.id))!;
    expect(data.version).toBe(1);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].steps).toHaveLength(2);

    const markdown = exportToMarkdown(data);
    expect(markdown).toContain("# Review this plan");
    expect(markdown).toContain("## You");
    expect(markdown).toContain("Revised plan with rollback");
    expect(markdown).toContain("critique-1 · critique · Claude (mock) (mock/mock-claude)");
    expect(markdown).toContain("after draft-1");
    expect(markdown).toContain("Missing rollback");
    expect(await store.exportConversation("missing")).toBeNull();
  });

  it("keeps runs that never produced an answer in the export", async () => {
    const { store } = await tempStore();
    const created = await store.createRun({ mode: "single", prompt: "Doomed run", participants: [participant] });
    await store.updateRun(created.run.id, { status: "failed", error: "provider offline" });

    const markdown = exportToMarkdown((await store.exportConversation(created.conversation.id))!);
    expect(markdown).toContain("## Runs without a final answer");
    expect(markdown).toContain("provider offline");
  });

  it("escapes fenced code so an exported answer stays parseable", () => {
    const markdown = exportToMarkdown({
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      conversation: {
        id: "c1",
        title: "Fences",
        createdAt: "x",
        updatedAt: "x",
        lastRunId: "r1",
        messages: [
          { id: "m1", role: "user", content: "Show code", createdAt: "x", runId: "r1" },
          { id: "m2", role: "assistant", content: "Done", createdAt: "x", runId: "r1" },
        ],
      },
      runs: [{
        id: "r1",
        attempt: 1,
        status: "completed",
        mode: "single",
        participants: [participant],
        usage: { callsStarted: 1, callsCompleted: 1, inputTokens: 0, outputTokens: 0, tokenReports: 0 },
        createdAt: "x",
        updatedAt: "x",
        steps: [{ id: "answer-1", kind: "answer", model: participant, content: "```js\nconst a = 1;\n```" }],
      }],
    });

    expect(markdown).toContain("````markdown");
    expect(markdown).toContain("```js");
  });

  it("derives a safe download filename", () => {
    expect(exportFilename("Provider adapters / runtime notes!", "markdown")).toBe("conclave-provider-adapters-runtime-notes.md");
    expect(exportFilename("***", "json")).toBe("conclave-conversation.json");
  });
});
