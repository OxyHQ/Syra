#!/usr/bin/env bun

/** Mutation tests for the real AI architecture gate. */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-ai-architecture.mjs");

function cleanTree(extra = {}) {
  return {
    "package.json": `${JSON.stringify({
      name: "fixture",
      dependencies: { "@oxyhq/core": "^23.0.0" },
    }, null, 2)}\n`,
    "packages/backend/package.json": `${JSON.stringify({
      name: "backend",
      dependencies: { postgres: "3.4.9" },
    }, null, 2)}\n`,
    "packages/backend/src/catalog.ts": [
      "const metadataKeys = ['ACOUSTID_API_KEY', 'PODCAST_INDEX_KEY'];",
      "const metadataHosts = ['musicbrainz.org', 'lrclib.net'];",
      "export { metadataKeys, metadataHosts };",
      "",
    ].join("\n"),
    "packages/backend/src/podcast.ts": [
      "export const provenance = { provider: 'alia', aiGenerated: true };",
      "",
    ].join("\n"),
    "packages/frontend/src/alia.ts": "import { OxyServices } from '@oxyhq/core';\nexport { OxyServices };\n",
    ...extra,
  };
}

async function runAgainst(files) {
  const root = await mkdtemp(join(tmpdir(), "syra-ai-architecture-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const fullPath = join(root, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, contents);
    }
    Bun.spawnSync({ cmd: ["git", "-c", "init.defaultBranch=main", "init", "-q"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "add", "-A", "-f"], cwd: root });

    const process = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: {
        ...globalThis.process.env,
        AI_ARCHITECTURE_VALIDATOR_ROOT: root,
        AI_ARCHITECTURE_VALIDATOR_FIXTURE_FLOORS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: process.exitCode,
      output: `${process.stdout.toString()}${process.stderr.toString()}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const cases = [
  {
    name: "legitimate metadata, Alia provenance and Oxy imports pass",
    files: cleanTree(),
    fails: false,
  },
  {
    name: "a provider credential is rejected",
    files: cleanTree({ "packages/backend/.env.example": "OPENAI_API_KEY=\n" }),
    fails: true,
    output: "inference-provider credential OPENAI_API_KEY",
  },
  {
    name: "a direct provider dependency is rejected",
    files: cleanTree({
      "packages/backend/package.json": `${JSON.stringify({ name: "backend", dependencies: { openai: "^6.0.0" } }, null, 2)}\n`,
    }),
    fails: true,
    output: "dependencies declares direct inference package openai",
  },
  {
    name: "a generic AI SDK provider adapter is rejected",
    files: cleanTree({
      "packages/backend/package.json": `${JSON.stringify({ name: "backend", dependencies: { "@ai-sdk/openai": "^2.0.0" } }, null, 2)}\n`,
    }),
    fails: true,
    output: "dependencies declares direct inference package @ai-sdk/openai",
  },
  {
    name: "a direct provider import is rejected",
    files: cleanTree({ "packages/backend/src/inference.ts": "import messages from '@anthropic-ai/sdk/resources/messages';\n" }),
    fails: true,
    output: "imports direct inference package @anthropic-ai/sdk/resources/messages",
  },
  {
    name: "a side-effect provider import is rejected",
    files: cleanTree({ "packages/backend/src/inference.ts": "import 'ollama';\n" }),
    fails: true,
    output: "imports direct inference package ollama",
  },
  {
    name: "a stale provider lock resolution is rejected",
    files: cleanTree({ "bun.lock": '{\n  "openai": ["openai@6.0.0", "", {}]\n}\n' }),
    fails: true,
    output: "resolves direct inference package openai",
  },
  {
    name: "a direct provider endpoint is rejected",
    files: cleanTree({ "packages/backend/src/inference.ts": "fetch('https://api.openai.com/v1/responses');\n" }),
    fails: true,
    output: "calls direct inference-provider endpoint api.openai.com",
  },
  {
    name: "a direct Kaana endpoint is rejected",
    files: cleanTree({ "packages/backend/src/inference.ts": "fetch('https://kaana.ai/v1/responses');\n" }),
    fails: true,
    output: "names direct inference data-plane endpoint kaana.ai",
  },
  {
    name: "a retired Relay endpoint in documentation is rejected",
    files: cleanTree({ "README.md": "Send inference requests to https://relay.oxy.so/v1/responses.\n" }),
    fails: true,
    output: "names direct inference data-plane endpoint relay.oxy.so",
  },
  {
    name: "credential advice in documentation is rejected",
    files: cleanTree({ "README.md": "Set GEMINI_API_KEY before starting the API.\n" }),
    fails: true,
    output: "names inference-provider credential GEMINI_API_KEY",
  },
];

for (const testCase of cases) {
  const result = await runAgainst(testCase.files);
  const failed = result.exitCode !== 0;
  if (failed !== testCase.fails || (testCase.output && !result.output.includes(testCase.output))) {
    console.error(`FAIL: ${testCase.name}`);
    console.error(`exit=${result.exitCode}\n${result.output}`);
    process.exit(1);
  }
  console.log(`PASS: ${testCase.name}`);
}

console.log(`AI architecture mutation suite passed (${cases.length} cases).`);
