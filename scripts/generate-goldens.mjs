#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { convertOpenClawBundles } from "../dist/exporter.js";

const root = process.cwd();
const bundlesRoot = join(root, "fixtures", "bundles");
const goldenRoot = join(root, "fixtures", "golden");
await rm(bundlesRoot, { recursive: true, force: true });
await rm(goldenRoot, { recursive: true, force: true });
await mkdir(bundlesRoot, { recursive: true });
await mkdir(goldenRoot, { recursive: true });

function event({ seq, source, type, sessionId, runId, entryId, data }) {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source,
    type,
    ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    seq,
    sessionId,
    ...(runId ? { runId } : {}),
    ...(entryId ? { entryId } : {}),
    ...(data ? { data } : {}),
  };
}

async function writeBundle(directory, sessionKey, sessionId, events) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    traceId: sessionId,
    sessionId,
    sessionKey,
    workspaceDir: "$WORKSPACE_DIR",
    leafId: "leaf-1",
    eventCount: events.length,
    runtimeEventCount: events.filter((value) => value.source === "runtime").length,
    transcriptEventCount: events.filter((value) => value.source === "transcript").length,
    sourceFiles: { session: sessionKey },
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "events.jsonl"),
    `${events.map((value) => JSON.stringify(value)).join("\n")}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "session-branch.json"),
    `${JSON.stringify({ header: { id: sessionId }, leafId: "leaf-1", entries: [] }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function childEvents(sessionId, runId) {
  return [
    event({
      seq: 1,
      source: "runtime",
      type: "trace.metadata",
      sessionId,
      runId,
      data: { harness: { version: "2026.7.1-2" }, model: { provider: "openai", name: "gpt-test" } },
    }),
    event({
      seq: 2,
      source: "transcript",
      type: "user.message",
      sessionId,
      runId,
      entryId: "u",
      data: { message: { role: "user", content: "Do the delegated work." } },
    }),
    event({
      seq: 3,
      source: "transcript",
      type: "assistant.message",
      sessionId,
      runId,
      entryId: "a",
      data: {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [{ type: "text", text: "Done." }],
          usage: { input: 3, output: 1, cost: { total: 0.002 } },
        },
      },
    }),
  ];
}

function rootEvents(sessionId, childKey, childRunId) {
  return [
    event({
      seq: 1,
      source: "runtime",
      type: "trace.metadata",
      sessionId,
      data: { harness: { version: "2026.7.1-2" }, model: { provider: "openai", name: "gpt-test" } },
    }),
    event({
      seq: 2,
      source: "runtime",
      type: "context.compiled",
      sessionId,
      data: {
        systemPrompt: "Synthetic system prompt",
        tools: [
          {
            type: "function",
            function: { name: "sessions_spawn", parameters: { type: "object" } },
          },
        ],
      },
    }),
    event({
      seq: 3,
      source: "transcript",
      type: "user.message",
      sessionId,
      entryId: "u",
      data: { message: { role: "user", content: "Delegate this task." } },
    }),
    event({
      seq: 4,
      source: "transcript",
      type: "assistant.message",
      sessionId,
      entryId: "a",
      data: {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [{ type: "text", text: "Starting a child." }],
          usage: { input: 10, cacheRead: 2, output: 4, cost: { total: 0.01 } },
        },
      },
    }),
    event({
      seq: 5,
      source: "transcript",
      type: "tool.call",
      sessionId,
      entryId: "a",
      data: {
        assistantEntryId: "a",
        toolCallId: "spawn-1",
        name: "sessions_spawn",
        arguments: { task: "child work" },
      },
    }),
    event({
      seq: 6,
      source: "transcript",
      type: "tool.result",
      sessionId,
      entryId: "r",
      data: {
        message: {
          role: "toolResult",
          toolCallId: "spawn-1",
          toolName: "sessions_spawn",
          content: JSON.stringify({
            childSessionKey: childKey,
            status: "accepted",
            runId: childRunId,
          }),
        },
      },
    }),
  ];
}

async function generateFamily(name, version, childKey, relationshipKind, exactReference) {
  const familyRoot = join(bundlesRoot, name);
  const childRunId = `${name}-child-run`;
  await writeBundle(
    join(familyRoot, "root"),
    "agent:main:main",
    `${name}-root-session`,
    rootEvents(`${name}-root-session`, childKey, childRunId),
  );
  await writeBundle(
    join(familyRoot, "child"),
    childKey,
    `${name}-child-session`,
    childEvents(`${name}-child-session`, childRunId),
  );
  const graph = {
    schema: "openclaw-atif-bundle-graph-v1",
    rootKey: "agent:main:main",
    openclawVersion: version,
    nodes: [
      { sessionKey: "agent:main:main", bundleDir: "root" },
      {
        sessionKey: childKey,
        bundleDir: "child",
        parentKey: "agent:main:main",
        relationshipKind,
        ...(exactReference ? { toolCallId: "spawn-1" } : {}),
      },
    ],
  };
  const graphPath = join(familyRoot, "graph.json");
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  await convertOpenClawBundles({
    graph: graphPath,
    bundleRoot: familyRoot,
    output: join(goldenRoot, name),
  });
}

await generateFamily(
  "legacy-jsonl",
  "2026.7.1-2",
  "agent:main:subagent:child",
  "native-subagent",
  true,
);
await generateFamily("sqlite", "2026.8.1-beta.2", "agent:main:acp:child", "acp-child", false);

// Synthetic public bundle, not a capture from a live model or OpenClaw run.
const mediaRoot = join(bundlesRoot, "media");
const sessionId = "media-session";
const image = { type: "image", source: { media_type: "image/png", path: "pixel.png" } };
const audio = {
  type: "audio",
  source: { media_type: "audio/x-wav", path: "sample.wav", duration_sec: 0.000125 },
};
await writeBundle(join(mediaRoot, "root"), "agent:main:main", sessionId, [
  event({
    seq: 1,
    source: "transcript",
    type: "user.message",
    sessionId,
    entryId: "u",
    data: {
      message: {
        content: [
          { type: "text", text: "Look and listen." },
          { type: "image_url", image_url: image.source },
          audio,
        ],
      },
    },
  }),
  event({
    seq: 2,
    source: "transcript",
    type: "assistant.message",
    sessionId,
    entryId: "a",
    data: {
      message: { content: [audio], usage: { input: 2, output: 1, cacheWrite: 3 } },
    },
  }),
  event({
    seq: 3,
    source: "transcript",
    type: "tool.call",
    sessionId,
    entryId: "a",
    data: {
      assistantEntryId: "a",
      toolCallId: "read-1",
      name: "read",
      arguments: {},
    },
  }),
  event({
    seq: 4,
    source: "transcript",
    type: "tool.result",
    sessionId,
    entryId: "r",
    data: {
      message: {
        toolCallId: "read-1",
        toolName: "read",
        content: [{ ...image, type: "input_image" }, audio],
      },
    },
  }),
  event({
    seq: 5,
    source: "runtime",
    type: "session.ended",
    sessionId,
    data: { reason: "completed" },
  }),
]);
await writeFile(
  join(mediaRoot, "root", "pixel.png"),
  Buffer.from(
    // Generated 1x1 red RGB PNG with valid chunk CRCs.
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  ),
);
const wav = Buffer.alloc(46);
wav.write("RIFF");
wav.writeUInt32LE(38, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(2, 40);
await writeFile(join(mediaRoot, "root", "sample.wav"), wav);
await writeFile(
  join(mediaRoot, "graph.json"),
  `${JSON.stringify(
    {
      schema: "openclaw-atif-bundle-graph-v1",
      rootKey: "agent:main:main",
      openclawVersion: "synthetic-media-fixture",
      nodes: [{ sessionKey: "agent:main:main", bundleDir: "root" }],
    },
    null,
    2,
  )}\n`,
);
await convertOpenClawBundles({
  graph: join(mediaRoot, "graph.json"),
  bundleRoot: mediaRoot,
  output: join(goldenRoot, "media"),
});
