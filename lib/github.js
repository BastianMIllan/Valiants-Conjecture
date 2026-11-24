// The PR bot: opens every pull request on the official repository from the
// project's own GitHub account (one branch, one commit, one file), so the
// official record credits the project. Uses a classic token with public_repo.
export function createGithub({ config }) {
  const { api, token, handle, xHandle } = config.github;
  const upstream = config.pnp.repo;
  const name = upstream.split('/')[1];
  const fork = `${handle}/${name}`;
  let defaultBranch = null;
  let forkReady = false;

  async function gh(method, path, body) {
    const r = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'collective-pr-bot/1.0',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const t = await r.text();
    let json = null;
    try { json = t ? JSON.parse(t) : null; } catch { json = null; }
    return { status: r.status, json };
  }
  const must = (r, what) => {
    if (r.status >= 300) throw new Error(`${what}: GitHub answered ${r.status} ${r.json?.message || ''}`.trim());
    return r.json;
  };
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const configured = () => !!(token && handle);

  async function ensureFork() {
    if (forkReady) return;
    if (!defaultBranch) defaultBranch = must(await gh('GET', `/repos/${upstream}`), 'read upstream').default_branch || 'main';
    let r = await gh('GET', `/repos/${fork}`);
    if (r.status === 404) {
      must(await gh('POST', `/repos/${upstream}/forks`, { default_branch_only: true }), 'fork');
      for (let i = 0; i < 20 && r.status === 404; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        r = await gh('GET', `/repos/${fork}`);
      }
    }
    must(r, 'read fork');
    forkReady = true;
  }

  async function baseSha() {
    await gh('POST', `/repos/${fork}/merge-upstream`, { branch: defaultBranch }); // keep the fork current; harmless if already
    return must(await gh('GET', `/repos/${fork}/git/ref/heads/${encodeURIComponent(defaultBranch)}`), 'read base').object.sha;
  }

  // branch: wanted name (the gap id); a suffix is added if it is taken.
  async function openPr({ branch, path, content, title }) {
    await ensureFork();
    const sha = await baseSha();
    let b = branch;
    for (let n = 2; ; n++) {
      const r = await gh('POST', `/repos/${fork}/git/refs`, { ref: `refs/heads/${b}`, sha });
      if (r.status === 201) break;
      if (r.status === 422 && n < 50) { b = `${branch}-${n}`; continue; }
      must(r, 'create branch');
    }
    must(await gh('PUT', `/repos/${fork}/contents/${enc(path)}?ref=${encodeURIComponent(b)}`, {
      message: title,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: b,
    }), 'commit file');
    const pr = must(await gh('POST', `/repos/${upstream}/pulls`, {
      title,
      head: `${handle}:${b}`,
      base: defaultBranch,
      body: xHandle ? `**X handle**: @${xHandle}` : '',
      maintainer_can_modify: false,
    }), 'open pull request');
    return { number: pr.number, url: pr.html_url, branch: b };
  }

  // A fix after a REJECTED verdict goes to the same pull request.
  async function updateFile({ branch, path, content, title }) {
    const cur = must(await gh('GET', `/repos/${fork}/contents/${enc(path)}?ref=${encodeURIComponent(branch)}`), 'read file');
    must(await gh('PUT', `/repos/${fork}/contents/${enc(path)}`, {
      message: `${title} (fix)`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      sha: cur.sha,
    }), 'update file');
  }

  // The official checker posts ACCEPTED, REJECTED or FAULT as a comment.
  async function verdict(number) {
    const comments = must(await gh('GET', `/repos/${upstream}/issues/${number}/comments?per_page=100`), 'read comments') || [];
    let found = null;
    for (const c of comments) {
      const m = String(c.body || '').match(/\b(ACCEPTED|REJECTED|FAULT)\b/);
      if (m && (!found || c.created_at >= found.at)) found = { verdict: m[1], url: c.html_url, at: c.created_at };
    }
    const pr = must(await gh('GET', `/repos/${upstream}/pulls/${number}`), 'read pull request');
    return { verdict: found?.verdict || null, verdict_url: found?.url || null, merged: !!pr.merged, state: pr.state };
  }

  return { configured, openPr, updateFile, verdict, fork };
}
