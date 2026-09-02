#!/usr/bin/env bun

/**
 * Enforce Syra's AI boundary.
 *
 * Product-specific upstreams such as MusicBrainz, AcoustID, LRCLIB, Podcast
 * Index, LiveKit and CrowdSource are deliberately not inference providers.
 * Alia podcast provenance is also legitimate: Alia calls Syra, not the other
 * way around. This gate targets only model-provider custody/routing surfaces:
 * provider SDK packages/imports, provider credentials, provider inference
 * endpoints and direct current/retired inference data-plane endpoints.
 *
 * Override AI_ARCHITECTURE_VALIDATOR_ROOT only in the mutation harness, where
 * the real validator runs against a temporary git checkout.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = process.env.AI_ARCHITECTURE_VALIDATOR_ROOT
  ? resolve(process.env.AI_ARCHITECTURE_VALIDATOR_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fixtureMode = process.env.AI_ARCHITECTURE_VALIDATOR_FIXTURE_FLOORS === "1";

const validatorPaths = new Set([
  "scripts/validate-ai-architecture.mjs",
  "scripts/test-validate-ai-architecture.mjs",
]);

const bannedPackages = new Set([
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@google/genai",
  "groq-sdk",
  "@mistralai/mistralai",
  "cohere-ai",
  "together-ai",
  "@fireworks-ai/sdk",
  "replicate",
  "@perplexity-ai/perplexity_ai",
  "@aws-sdk/client-bedrock-runtime",
  "@azure/openai",
  "@azure-rest/ai-inference",
  "@google-cloud/vertexai",
  "@huggingface/inference",
  "@xenova/transformers",
  "@huggingface/transformers",
  "ollama",
  "cerebras-cloud-sdk",
  "@xai-org/xai-sdk",
  "@fal-ai/client",
  "@cloudflare/ai",
]);

const bannedPackagePrefixes = ["@ai-sdk/"];

const providerCredential = /\b(?:OPENAI_API_KEY|AZURE_OPENAI_API_KEY|AZURE_AI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_AI_API_KEY|GEMINI_API_KEY|GROQ_API_KEY|MISTRAL_API_KEY|COHERE_API_KEY|TOGETHER_API_KEY|FIREWORKS_API_KEY|REPLICATE_API_TOKEN|PERPLEXITY_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|BEDROCK_API_KEY|XAI_API_KEY|CEREBRAS_API_KEY|SAMBANOVA_API_KEY|NVIDIA_API_KEY|HUGGINGFACE_API_KEY|HF_TOKEN|FAL_KEY)\b/i;

const providerEndpoint = /\b(?:api\.openai\.com|[a-z0-9.-]+\.openai\.azure\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|[a-z0-9.-]+\.aiplatform\.googleapis\.com|api\.groq\.com|api\.mistral\.ai|api\.cohere\.com|api\.together\.xyz|api\.fireworks\.ai|api\.replicate\.com|api\.perplexity\.ai|api\.deepseek\.com|openrouter\.ai\/api|api\.x\.ai|api\.cerebras\.ai|api\.sambanova\.ai|integrate\.api\.nvidia\.com|api-inference\.huggingface\.co|api\.fal\.ai|bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com)\b/i;

const directDataPlaneEndpoint = /\b(?:(?:api\.)?kaana\.ai|kaana\.oxy\.so|relay\.oxy\.so)\b/i;

const importSpecifier = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;

function isBannedPackage(name) {
  return [...bannedPackages].some((dependency) => name === dependency || name.startsWith(`${dependency}/`))
    || bannedPackagePrefixes.some((prefix) => name.startsWith(prefix));
}

function dependencyReferenceIsBanned(reference) {
  if (typeof reference !== "string" || !reference.startsWith("npm:")) return false;
  const packageName = reference.slice(4).replace(/@[^@/]+$/, "");
  return isBannedPackage(packageName);
}

function manifestDependencyMaps(manifest) {
  const maps = [
    ["dependencies", manifest.dependencies],
    ["devDependencies", manifest.devDependencies],
    ["peerDependencies", manifest.peerDependencies],
    ["optionalDependencies", manifest.optionalDependencies],
    ["overrides", manifest.overrides],
  ];
  const workspaces = manifest.workspaces;
  if (workspaces && !Array.isArray(workspaces) && typeof workspaces === "object") {
    maps.push(["workspaces.catalog", workspaces.catalog]);
  }
  return maps;
}

function isRuntimeOrConfig(path) {
  if (path.startsWith("docs/") || path.includes("/docs/")) return false;
  if (path.startsWith("packages/backend/data/")) return false;
  if (path.startsWith("packages/") || path.startsWith(".github/") || path.startsWith("scripts/")) {
    const extension = extname(path).toLowerCase();
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".sh", ".env", ".example"].includes(extension)
      || path.endsWith("Dockerfile")
      || path.includes("Dockerfile.");
  }
  return path === "package.json" || path.endsWith(".env.example");
}

const listing = spawnSync("git", ["ls-files", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});

if (listing.status !== 0) {
  console.error(`AI architecture gate could not list tracked files: ${listing.stderr || "git ls-files failed"}`);
  process.exit(1);
}

const trackedFiles = listing.stdout.split("\0").filter(Boolean);
const manifests = trackedFiles.filter((path) => path === "package.json" || path.endsWith("/package.json"));
const scanFiles = trackedFiles.filter((path) => !validatorPaths.has(path));
const runtimeFiles = scanFiles.filter(isRuntimeOrConfig);

if (!fixtureMode && (trackedFiles.length < 500 || manifests.length < 5 || runtimeFiles.length < 300)) {
  console.error(
    `AI architecture gate scan is vacuous: tracked=${trackedFiles.length}, manifests=${manifests.length}, runtime/config=${runtimeFiles.length}`,
  );
  process.exit(1);
}

const violations = [];

for (const path of manifests) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
  } catch (error) {
    violations.push(`${path}: cannot read/parse manifest (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  for (const [field, values] of manifestDependencyMaps(manifest)) {
    if (!values || typeof values !== "object") continue;
    for (const [dependency, reference] of Object.entries(values)) {
      if (isBannedPackage(dependency) || dependencyReferenceIsBanned(reference)) {
        violations.push(`${path}: ${field} declares direct inference package ${dependency}`);
      }
    }
  }
}

for (const path of scanFiles) {
  let source;
  try {
    source = await readFile(resolve(repositoryRoot, path), "utf8");
  } catch (error) {
    violations.push(`${path}: cannot read tracked file (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  if (source.includes("\0")) continue;

  const credential = source.match(providerCredential)?.[0];
  if (credential) violations.push(`${path}: names inference-provider credential ${credential}`);

  if (path === "bun.lock") {
    for (const dependency of bannedPackages) {
      if (source.includes(`"${dependency}": [`) || source.includes(`"${dependency}@`)) {
        violations.push(`${path}: resolves direct inference package ${dependency}`);
      }
    }
    if (source.includes('"@ai-sdk/')) {
      violations.push(`${path}: resolves a direct @ai-sdk provider package`);
    }
  }

  const endpoint = source.match(providerEndpoint)?.[0];
  if (endpoint) violations.push(`${path}: calls direct inference-provider endpoint ${endpoint}`);

  const dataPlane = source.match(directDataPlaneEndpoint)?.[0];
  if (dataPlane) violations.push(`${path}: names direct inference data-plane endpoint ${dataPlane}; Syra must use Oxy`);

  if (!isRuntimeOrConfig(path)) continue;

  for (const match of source.matchAll(importSpecifier)) {
    const specifier = match[1];
    if (specifier && isBannedPackage(specifier)) {
      violations.push(`${path}: imports direct inference package ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Syra AI architecture violations:\n" + violations.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(
  `Syra AI architecture OK: ${manifests.length} manifests and ${runtimeFiles.length} runtime/config files; no direct provider credential, SDK, endpoint, or inference data-plane endpoint.`,
);
