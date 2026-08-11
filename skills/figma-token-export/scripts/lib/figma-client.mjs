// Figma REST client for the fallback extraction path.
//
// Scope note: this client deliberately never calls /v1/files/:key/variables.
// That endpoint needs the `file_variables:read` scope, which Figma gates to
// Enterprise plans — on an Organization plan it returns 403 no matter how the
// token was minted. The fallback path reads published styles and node trees,
// both of which work with a plain `file_content:read` personal access token.
import path from 'node:path';
import fs from 'node:fs/promises';

const API_BASE = 'https://api.figma.com/v1';

// Figma does not publish a rate limit, and returns 429 with a `Retry-After`
// when you cross it. These are the values that stopped producing 429s against a
// 40-page production file; raise them only with a run to back it up.
const MAX_CONCURRENT = 2;
// Enough to ride out the longest `Retry-After` Figma has been observed to send
// (~60s) with exponential backoff, without hanging a CI job indefinitely.
const MAX_RETRIES = 5;

let activeRequests = 0;
const waiting = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const base = 2000 * 2 ** attempt;
  const jitter = base * 0.2 * (Math.random() - 0.5);
  return Math.min(base + jitter, 60_000);
}

async function withConcurrencyLimit(fn) {
  if (activeRequests >= MAX_CONCURRENT) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  activeRequests++;
  try {
    return await fn();
  } finally {
    activeRequests--;
    waiting.shift()?.();
  }
}

export function requireToken() {
  const token = process.env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'FIGMA_ACCESS_TOKEN is not set. Create a personal access token at ' +
        'figma.com > Settings > Security > Personal access tokens (scope: file_content:read), ' +
        'then export it or put it in a .env file that is gitignored.',
    );
  }
  return token;
}

/**
 * GET a Figma REST path with retry/backoff and a global concurrency cap.
 * `:key` in the path is replaced with `fileKey`.
 */
export async function figmaGet(pathname, fileKey) {
  const token = requireToken();
  const url = `${API_BASE}${pathname.replace(':key', fileKey)}`;

  return withConcurrencyLimit(async () => {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'X-Figma-Token': token } });

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after')) || 0;
          const delay = retryAfter > 0 ? retryAfter * 1000 : backoffDelay(attempt);
          console.warn(`[figma] 429 rate limited, retrying in ${delay}ms: ${pathname}`);
          await sleep(delay);
          continue;
        }
        if (res.status >= 500) {
          console.warn(`[figma] ${res.status} server error, retrying: ${pathname}`);
          await sleep(backoffDelay(attempt));
          continue;
        }
        if (res.status === 403) {
          throw new Error(
            `Figma API 403 for ${pathname}. If this is /variables, that endpoint is ` +
              'Enterprise-only — use the MCP extraction path instead (see references/extraction-mcp.md).',
          );
        }
        if (!res.ok) {
          throw new Error(`Figma API ${res.status} for ${pathname}: ${await res.text()}`);
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        if (String(err.message).includes('403')) throw err; // not retryable
        if (attempt < MAX_RETRIES - 1) await sleep(backoffDelay(attempt));
      }
    }
    throw new Error(`Figma API failed after ${MAX_RETRIES} attempts for ${pathname}: ${lastError?.message}`);
  });
}

/** Fetches node subtrees, chunked so URLs stay under Figma's length limit. */
export async function fetchNodes(fileKey, nodeIds, { depth } = {}) {
  const out = {};
  for (let i = 0; i < nodeIds.length; i += 20) {
    const chunk = nodeIds.slice(i, i + 20);
    const depthParam = depth ? `&depth=${depth}` : '';
    const data = await figmaGet(`/files/:key/nodes?ids=${chunk.join(',')}${depthParam}`, fileKey);
    Object.assign(out, data.nodes ?? {});
  }
  return out;
}

export async function saveRaw(rawDir, name, data) {
  await fs.mkdir(rawDir, { recursive: true });
  const file = path.join(rawDir, `${name}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2));
  return file;
}

/** Parses a Figma URL into { fileKey, nodeId } — accepts node-id in either "1-2" or "1:2" form. */
export function parseFigmaUrl(url) {
  const fileKey = url.match(/figma\.com\/(?:design|file)\/([0-9a-zA-Z]{22,128})/)?.[1] ?? null;
  const rawNode = new URL(url).searchParams.get('node-id');
  return { fileKey, nodeId: rawNode ? rawNode.replace('-', ':') : null };
}
