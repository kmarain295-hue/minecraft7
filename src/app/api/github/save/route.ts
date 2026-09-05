import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * POST /api/github/save
 *
 * Pushes the ENTIRE game source (src/, public/, prisma/ + root config files)
 * to the caller's GitHub account using the GitHub REST API.
 *
 * Body: { token: string; repo: string }
 *   - token: a GitHub personal access token. Classic token needs the "repo"
 *     scope; a fine-grained token needs Contents + Administration read/write.
 *   - repo:  repository name. Created under the caller's account when it does
 *     not exist yet; otherwise a fresh commit is pushed on top.
 *
 * Upload strategy (fast + reliable):
 *   1. Repo already has commits  -> straight to the git data API.
 *   2. Repo is EMPTY (freshly created) -> raw git-data bootstrap (root commit
 *      + first ref) is rejected by GitHub with 409 "Git Repository is empty."
 *      on many accounts, and uploading every file through the Contents API
 *      needs ~2 sequential calls per file (minutes for 85 files). So instead
 *      we seed the repo with ONE tiny file via the Contents API — which
 *      officially creates the first commit and branch — and then push ALL
 *      files as a single commit through the batched git data API.
 *   3. Partially-uploaded repos simply resume: everything is pushed as one
 *      fresh commit on top of whatever is there.
 *
 * The token never touches persistent storage; it is used in-memory for the
 * duration of this single request only.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GITHUB_API = 'https://api.github.com';
const MAX_FILE_BYTES = 12 * 1024 * 1024; // skip pathologically large binaries
const BLOB_BATCH = 10; // parallel blob uploads
const CALL_TIMEOUT_MS = 60_000; // hard cap per GitHub call (anti-hang)

/** Source directories pushed to the repository (relative to the project root). */
const SOURCE_DIRS = ['src', 'public', 'prisma'];

/** Standalone config / lock files pushed from the project root. */
const SOURCE_ROOT_FILES = new Set([
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'next.config.ts',
  'postcss.config.mjs',
  'components.json',
  'eslint.config.mjs',
  'next-env.d.ts',
  '.gitignore',
  'README.md',
]);

/** Directories never descended into while walking the source tree. */
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.turbo', '.vercel']);

interface RepoFile {
  /** Slash-separated path relative to the project root. */
  path: string;
  data: Buffer;
}

/** Error carrying the HTTP status from a failed GitHub REST call. */
class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Minimal typed GitHub REST call with consistent headers + error extraction. */
async function github(
  token: string,
  endpoint: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GITHUB_API}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ratfire-game-source-export',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

  const text = await res.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // non-JSON error body — fall through with the generic message
    }
  }
  if (!res.ok) {
    const message =
      (typeof payload.message === 'string' && payload.message) ||
      `GitHub API request failed (${res.status})`;
    throw new GitHubError(res.status, message);
  }
  return payload;
}

/** Recursively collects source files from one directory. */
async function collectDir(
  root: string,
  dir: string,
  out: RepoFile[]
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectDir(root, full, out);
    } else if (entry.isFile()) {
      const stat = await fs.stat(full);
      if (stat.size > MAX_FILE_BYTES) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      out.push({ path: rel, data: await fs.readFile(full) });
    }
  }
}

/** Gathers every file that belongs in the exported repository. */
async function collectFiles(root: string): Promise<RepoFile[]> {
  const out: RepoFile[] = [];
  for (const dir of SOURCE_DIRS) {
    const full = path.join(root, dir);
    try {
      await fs.access(full);
    } catch {
      continue;
    }
    await collectDir(root, full, out);
  }
  for (const name of SOURCE_ROOT_FILES) {
    try {
      const full = path.join(root, name);
      const stat = await fs.stat(full);
      if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
        out.push({ path: name, data: await fs.readFile(full) });
      }
    } catch {
      // optional file — absent on this install
    }
  }
  return out;
}

function shaOf(payload: Record<string, unknown>): string {
  return typeof payload.sha === 'string' ? payload.sha : '';
}

/** Percent-encodes each path segment for a Contents API URL. */
function encodeGitPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/**
 * Seeds an EMPTY repository with one small file through the Contents API.
 * This single call creates the initial commit AND the default branch — the
 * officially supported bootstrap, unlike raw git-data root commits which
 * GitHub often rejects on fresh repos.
 */
async function seedEmptyRepo(
  token: string,
  login: string,
  repoName: string,
  branch: string,
  seed: RepoFile
): Promise<void> {
  const base = `/repos/${login}/${repoName}/contents/${encodeGitPath(seed.path)}`;
  const put = (): Promise<unknown> =>
    github(token, base, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Initial commit',
        content: seed.data.toString('base64'),
        branch,
      }),
    });
  try {
    await put();
  } catch {
    // fresh repos can take a moment to become writable — retry once
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await put();
  }
}

export async function POST(request: Request) {
  let body: { token?: unknown; repo?: unknown };
  try {
    body = (await request.json()) as { token?: unknown; repo?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request body.' },
      { status: 400 }
    );
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const repoName = typeof body.repo === 'string' ? body.repo.trim() : '';

  if (!token) {
    return NextResponse.json(
      { ok: false, error: 'A GitHub personal access token is required.' },
      { status: 400 }
    );
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repoName)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Repository name may only contain letters, numbers, dots, dashes and underscores.',
      },
      { status: 400 }
    );
  }

  try {
    // ---------- 1) identify the authenticated account ----------
    const me = await github(token, '/user');
    const login = typeof me.login === 'string' ? me.login : '';
    if (!login) {
      throw new GitHubError(
        401,
        'Could not resolve the GitHub account for this token.'
      );
    }

    // ---------- 2) find or create the repository ----------
    let htmlUrl = `https://github.com/${login}/${repoName}`;
    let defaultBranch = 'main';
    let created = false;
    let headSha = '';
    let baseTree = '';

    try {
      const existing = await github(token, `/repos/${login}/${repoName}`);
      htmlUrl =
        typeof existing.html_url === 'string' ? existing.html_url : htmlUrl;
      if (typeof existing.default_branch === 'string' && existing.default_branch) {
        defaultBranch = existing.default_branch;
      }
      // Resolve the current head commit. A 409 ("Git Repository is empty.")
      // or 404 here simply means there are no commits yet.
      try {
        const ref = await github(
          token,
          `/repos/${login}/${repoName}/git/ref/heads/${defaultBranch}`
        );
        const object = ref.object as { sha?: string } | undefined;
        headSha = object?.sha ?? '';
        if (headSha) {
          const headCommit = await github(
            token,
            `/repos/${login}/${repoName}/git/commits/${headSha}`
          );
          const tree = headCommit.tree as { sha?: string } | undefined;
          baseTree = tree?.sha ?? '';
        }
      } catch {
        headSha = '';
      }
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) {
        const newRepo = await github(token, '/user/repos', {
          method: 'POST',
          body: JSON.stringify({
            name: repoName,
            description:
              'RATFIRE — third-person three.js game built with Next.js',
            private: false,
            auto_init: false,
          }),
        });
        htmlUrl =
          typeof newRepo.html_url === 'string' ? newRepo.html_url : htmlUrl;
        if (
          typeof newRepo.default_branch === 'string' &&
          newRepo.default_branch
        ) {
          defaultBranch = newRepo.default_branch;
        }
        created = true;
      } else {
        throw error;
      }
    }

    // ---------- 3) collect every source file from disk ----------
    const files = await collectFiles(process.cwd());
    if (files.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No source files found on the server to upload.' },
        { status: 500 }
      );
    }

    // ---------- 4) empty repo? seed ONE small file (creates first commit) ----------
    if (!headSha) {
      const seed =
        files.find((file) => file.path === 'package.json') ?? files[0];
      await seedEmptyRepo(token, login, repoName, defaultBranch, seed);
      const ref = await github(
        token,
        `/repos/${login}/${repoName}/git/ref/heads/${defaultBranch}`
      );
      const object = ref.object as { sha?: string } | undefined;
      headSha = object?.sha ?? '';
      if (!headSha) {
        throw new GitHubError(
          502,
          'GitHub did not report the seed commit — press Save again to retry.'
        );
      }
      const seedCommit = await github(
        token,
        `/repos/${login}/${repoName}/git/commits/${headSha}`
      );
      const tree = seedCommit.tree as { sha?: string } | undefined;
      baseTree = tree?.sha ?? '';
    }

    // ---------- 5) bulk upload: batched blobs -> one tree -> one commit ----------
    const treeItems: Array<{
      path: string;
      mode: string;
      type: string;
      sha: string;
    }> = [];
    for (let i = 0; i < files.length; i += BLOB_BATCH) {
      const batch = files.slice(i, i + BLOB_BATCH);
      const results = await Promise.all(
        batch.map((file) =>
          github(token, `/repos/${login}/${repoName}/git/blobs`, {
            method: 'POST',
            body: JSON.stringify({
              content: file.data.toString('base64'),
              encoding: 'base64',
            }),
          }).then((blob) => ({
            path: file.path,
            mode: '100644',
            type: 'blob',
            sha: shaOf(blob),
          }))
        )
      );
      for (const item of results) {
        if (item.sha) treeItems.push(item);
      }
    }
    if (treeItems.length === 0) {
      throw new GitHubError(502, 'GitHub rejected every file blob upload.');
    }

    const treePayload: Record<string, unknown> = { tree: treeItems };
    if (baseTree) treePayload.base_tree = baseTree;
    const tree = await github(token, `/repos/${login}/${repoName}/git/trees`, {
      method: 'POST',
      body: JSON.stringify(treePayload),
    });

    const commit = await github(
      token,
      `/repos/${login}/${repoName}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: 'Add RATFIRE game source',
          tree: shaOf(tree),
          parents: [headSha],
        }),
      }
    );

    // ---------- 6) move the branch ----------
    const patchRef = (): Promise<unknown> =>
      github(
        token,
        `/repos/${login}/${repoName}/git/refs/heads/${defaultBranch}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sha: shaOf(commit), force: false }),
        }
      );
    try {
      await patchRef();
    } catch {
      // transient ref races resolve within a couple of seconds
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await patchRef();
    }

    return NextResponse.json({
      ok: true,
      url: htmlUrl,
      owner: login,
      repo: repoName,
      branch: defaultBranch,
      files: treeItems.length,
      created,
      method: 'git-data',
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    const isGitHubError = error instanceof GitHubError;
    const status = isGitHubError && error.status === 401 ? 401 : 500;
    let message = error instanceof Error ? error.message : 'Unexpected error.';
    if (isTimeout) {
      message =
        'A GitHub request timed out (network or GitHub was slow) — press Save again to retry.';
    }
    const hint =
      isGitHubError && (error.status === 401 || error.status === 403)
        ? ' — check that the token is valid and has the required permissions (classic token with the "repo" scope, or a fine-grained token with Contents + Administration read & write).'
        : '';
    return NextResponse.json({ ok: false, error: `${message}${hint}` }, { status });
  }
}
