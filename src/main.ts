import * as core from '@actions/core';
import * as github from '@actions/github';
import * as tc from '@actions/tool-cache';
import { exec, ExecException, ExecOptions } from 'child_process';
import fs from 'fs';
import nodeFetch from 'node-fetch';
import path from 'path';

interface ExecResult {
  err?: Error;
  stdout: string;
  stderr: string;
}

interface Diff {
  app: App;
  diff: string;
  error?: ExecResult;
}

export interface App {
  metadata: { name: string };
  spec: {
    source: {
      repoURL: string;
      path: string;
      targetRevision: string;
      kustomize: object;
      helm: object;
    };
  };
  status: {
    sync: {
      status: 'OutOfSync' | 'Synced';
    };
  };
}

export function filterAppsByName(appsAffected: App[], appNameMatcher: string): App[] {
  if (appNameMatcher.startsWith('/') && appNameMatcher.endsWith('/')) {
    const appNameFilter = new RegExp(appNameMatcher.slice(1, -1));
    return appsAffected.filter(app => appNameFilter.test(app.metadata.name));
  } else if (appNameMatcher !== '') {
    const appNames = new Set(appNameMatcher.split(','));
    return appsAffected.filter(app => appNames.has(app.metadata.name));
  }
  return appsAffected;
}

export async function run(): Promise<void> {
  const ARCH = process.env.ARCH || 'linux';
  const githubToken = core.getInput('github-token');
  core.info(githubToken);

  const ARGOCD_SERVER_URL = core.getInput('argocd-server-url');
  const ARGOCD_TOKEN = core.getInput('argocd-token');
  const VERSION = core.getInput('argocd-version');
  const ENV = core.getInput('environment');
  const PLAINTEXT = core.getInput('plaintext').toLowerCase() === 'true';
  const APP_NAME_MATCHER = core.getInput('app-name-matcher');
  let EXTRA_CLI_ARGS = core.getInput('argocd-extra-cli-args');
  if (PLAINTEXT) {
    EXTRA_CLI_ARGS += ' --plaintext';
  }

  const octokit = github.getOctokit(githubToken);

  function execCommand(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise<ExecResult>((done, failed) => {
      exec(command, options, (err: ExecException | null, stdout: string, stderr: string): void => {
        const res: ExecResult = {
          stdout,
          stderr
        };
        if (err) {
          res.err = err;
          failed(res);
          return;
        }
        done(res);
      });
    });
  }

  function scrubSecrets(input: string): string {
    let output = input;
    const authTokenMatches = input.match(/--auth-token=([\w.\S]+)/);
    if (authTokenMatches) {
      output = output.replace(new RegExp(authTokenMatches[1], 'g'), '***');
    }
    return output;
  }

  async function setupArgoCDCommand(): Promise<(params: string) => Promise<ExecResult>> {
    const argoBinaryPath = await tc.downloadTool(
      `https://github.com/argoproj/argo-cd/releases/download/${VERSION}/argocd-${ARCH}-amd64`
    );
    fs.chmodSync(argoBinaryPath, '755');

    return async (params: string) =>
      execCommand(
        `${argoBinaryPath} ${params} --auth-token=${ARGOCD_TOKEN} --server=${ARGOCD_SERVER_URL} ${EXTRA_CLI_ARGS}`
      );
  }

  async function getApps(): Promise<App[]> {
    const protocol = PLAINTEXT ? 'http' : 'https';
    const url = `${protocol}://${ARGOCD_SERVER_URL}/api/v1/applications`;
    core.info(`Fetching apps from: ${url}`);
    core.info(`Using protocol: ${protocol}`);
    core.info(`PLAINTEXT setting: ${PLAINTEXT}`);
    core.info(`ARGOCD_SERVER_URL: ${ARGOCD_SERVER_URL}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let responseJson: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let response: any;
    try {
      const requestHeaders = { Cookie: `argocd.token=${ARGOCD_TOKEN}` };
      core.info(`Request headers: ${JSON.stringify({ Cookie: 'argocd.token=***' })}`);

      response = await nodeFetch(url, {
        method: 'GET',
        headers: requestHeaders
      });

      core.info(`Response status: ${response.status} ${response.statusText}`);
      core.info(`Response headers: ${JSON.stringify(Object.fromEntries(response.headers))}`);

      if (!response.ok) {
        const errorText = await response.text();
        core.error(`HTTP Error ${response.status}: ${response.statusText}`);
        core.error(`Response body: ${errorText}`);
        core.setFailed(
          `Failed to fetch applications: HTTP ${response.status} ${response.statusText}`
        );
        return [];
      }

      const responseText = await response.text();
      core.info(`Response body length: ${responseText.length} characters`);

      try {
        responseJson = JSON.parse(responseText);
        core.info(
          `Successfully parsed JSON response with ${responseJson.items?.length || 0} items`
        );
      } catch (jsonError) {
        core.error(`Failed to parse JSON response: ${jsonError}`);
        core.error(`Response text (first 500 chars): ${responseText.substring(0, 500)}`);
        core.setFailed(`Invalid JSON response from ArgoCD API`);
        return [];
      }
    } catch (e) {
      core.error(`Network or request error: ${e}`);
      if (e instanceof Error) {
        core.error(`Error name: ${e.name}`);
        core.error(`Error message: ${e.message}`);
        core.error(`Error stack: ${e.stack}`);
      }
      core.setFailed(`Failed to connect to ArgoCD server: ${e}`);
      return [];
    }
    const apps = responseJson.items as App[];
    core.info(`Total apps fetched: ${apps.length}`);

    const repoApps = apps.filter(app => {
      const targetRevision = app.spec.source.targetRevision;
      const targetPrimary =
        targetRevision === 'master' || targetRevision === 'main' || !targetRevision;
      const isRepoMatch = app.spec.source.repoURL.includes(
        `${github.context.repo.owner}/${github.context.repo.repo}`
      );

      core.info(
        `App ${app.metadata.name}: repoURL=${app.spec.source.repoURL}, targetRevision=${targetRevision}, isRepoMatch=${isRepoMatch}, targetPrimary=${targetPrimary}`
      );

      return isRepoMatch && targetPrimary;
    });

    core.info(`Apps matching repo: ${repoApps.length}`);
    core.info(`Repo filter: ${github.context.repo.owner}/${github.context.repo.repo}`);

    let changedFiles: string[];
    try {
      changedFiles = await getChangedFiles();
      core.info(`Changed files: ${changedFiles.join(', ')}`);
    } catch (error) {
      core.error(`Error getting changed files: ${error}`);
      core.setFailed(`Failed to get changed files: ${error}`);
      return [];
    }

    const appsAffected = repoApps.filter(partOfApp.bind(null, changedFiles));
    core.info(`Apps affected by changes: ${appsAffected.length}`);
    for (const app of appsAffected) {
      core.info(`Affected app: ${app.metadata.name} (path: ${app.spec.source.path})`);
    }

    const finalApps = filterAppsByName(appsAffected, APP_NAME_MATCHER);
    core.info(`Final filtered apps: ${finalApps.length}`);
    core.info(`App name matcher: "${APP_NAME_MATCHER}"`);

    return finalApps;
  }

  async function postDiffComment(diffs: Diff[]): Promise<void> {
    const protocol = PLAINTEXT ? 'http' : 'https';
    const { owner, repo } = github.context.repo;
    const sha = github.context.payload.pull_request?.head?.sha;

    const commitLink = `https://github.com/${owner}/${repo}/pull/${github.context.issue.number}/commits/${sha}`;
    const shortCommitSha = String(sha).slice(0, 7);

    const filteredDiffs = diffs
      .map(diff => {
        diff.diff = filterDiff(diff.diff);
        return diff;
      })
      .filter(d => d.diff !== '');

    const prefixHeader = `## ArgoCD Diff on ${ENV}`;
    const diffOutput = filteredDiffs.map(
      ({ app, diff, error }) => `
App: [\`${app.metadata.name}\`](${protocol}://${ARGOCD_SERVER_URL}/applications/${
        app.metadata.name
      })
YAML generation: ${error ? ' Error 🛑' : 'Success 🟢'}
App sync status: ${app.status.sync.status === 'Synced' ? 'Synced ✅' : 'Out of Sync ⚠️ '}
${
  error
    ? `
**\`stderr:\`**
\`\`\`
${error.stderr}
\`\`\`

**\`command:\`**
\`\`\`json
${JSON.stringify(error.err)}
\`\`\`
`
    : ''
}

${
  diff
    ? `

\`\`\`diff
${diff}
\`\`\`

`
    : ''
}
---
`
    );

    const output = scrubSecrets(`
${prefixHeader} for commit [\`${shortCommitSha}\`](${commitLink})
_Updated at ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT_
  ${diffOutput.join('\n')}

| Legend | Status |
| :---:  | :---   |
| ✅     | The app is synced in ArgoCD, and diffs you see are solely from this PR. |
| ⚠️      | The app is out-of-sync in ArgoCD, and the diffs you see include those changes plus any from this PR. |
| 🛑     | There was an error generating the ArgoCD diffs due to changes in this PR. |
`);

    const commentsResponse = await octokit.rest.issues.listComments({
      issue_number: github.context.issue.number,
      owner,
      repo
    });

    // Delete stale comments
    for (const comment of commentsResponse.data) {
      if (comment.body?.includes(prefixHeader)) {
        core.info(`deleting comment ${comment.id}`);
        octokit.rest.issues.deleteComment({
          owner,
          repo,
          comment_id: comment.id
        });
      }
    }

    // Only post a new comment when there are changes
    if (filteredDiffs.length) {
      octokit.rest.issues.createComment({
        issue_number: github.context.issue.number,
        owner,
        repo,
        body: output
      });
    }
  }

  async function getChangedFiles(): Promise<string[]> {
    const { owner, repo } = github.context.repo;
    const pull_number = github.context.issue.number;

    core.info(`GitHub context - owner: ${owner}, repo: ${repo}`);
    core.info(`Pull request number: ${pull_number}`);
    core.info(`GitHub context payload: ${JSON.stringify(github.context.payload, null, 2)}`);
    core.info(`GitHub context eventName: ${github.context.eventName}`);
    core.info(`GitHub context ref: ${github.context.ref}`);
    core.info(`GitHub context sha: ${github.context.sha}`);

    try {
      const listFilesResponse = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number
      });

      core.info(`Successfully fetched ${listFilesResponse.data.length} changed files`);
      return listFilesResponse.data.map(file => file.filename);
    } catch (error) {
      core.error(`GitHub API error details: ${JSON.stringify(error, null, 2)}`);
      if (error instanceof Error) {
        core.error(`Error name: ${error.name}`);
        core.error(`Error message: ${error.message}`);
      }
      throw error;
    }
  }

  function partOfApp(changedFiles: string[], app: App): boolean {
    const sourcePath = path.normalize(app.spec.source.path);
    const appPath = getFirstTwoDirectories(sourcePath);

    return changedFiles.some(file => {
      const normalizedFilePath = path.normalize(file);
      return normalizedFilePath.startsWith(appPath);
    });
  }

  function getFirstTwoDirectories(filePath: string): string {
    const normalizedPath = path.normalize(filePath);
    const parts = normalizedPath.split(path.sep).filter(Boolean); // filter(Boolean) removes empty strings
    if (parts.length < 2) {
      return parts.join(path.sep); // Return the entire path if less than two directories
    }
    return parts.slice(0, 2).join(path.sep);
  }

  async function asyncForEach<T>(
    array: T[],
    callback: (item: T, i: number, arr: T[]) => Promise<void>
  ): Promise<void> {
    for (let index = 0; index < array.length; index++) {
      await callback(array[index], index, array);
    }
  }

  const argocd = await setupArgoCDCommand();
  const apps = await getApps();
  core.info(`Found apps: ${apps.map(a => a.metadata.name).join(', ')}`);

  // Log detailed info about each app
  for (const app of apps) {
    core.info(`App: ${app.metadata.name}`);
    core.info(`  - Source path: ${app.spec.source.path}`);
    core.info(`  - Repo URL: ${app.spec.source.repoURL}`);
    core.info(`  - Target revision: ${app.spec.source.targetRevision}`);
    core.info(`  - Sync status: ${app.status.sync.status}`);
  }

  const diffs: Diff[] = [];

  await asyncForEach(apps, async (app, index) => {
    const command = `app diff ${app.metadata.name} --local=${app.spec.source.path}`;
    try {
      core.info(`[${index + 1}/${apps.length}] Processing app: ${app.metadata.name}`);
      core.info(`[${index + 1}/${apps.length}] Running: argocd ${command}`);
      core.info(`[${index + 1}/${apps.length}] Local path: ${app.spec.source.path}`);

      // ArgoCD app diff will exit 1 if there is a diff, so always catch,
      // and then consider it a success if there's a diff in stdout
      // https://github.com/argoproj/argo-cd/issues/3588
      await argocd(command);
      core.info(`[${index + 1}/${apps.length}] Success for ${app.metadata.name}: No diff found`);
      diffs.push({ app, diff: '' });
    } catch (e) {
      const res = e as ExecResult;
      core.info(`[${index + 1}/${apps.length}] Command failed for app: ${app.metadata.name}`);
      core.info(`[${index + 1}/${apps.length}] stdout: ${res.stdout}`);
      core.info(`[${index + 1}/${apps.length}] stderr: ${res.stderr}`);

      if (res.err) {
        core.info(`[${index + 1}/${apps.length}] Error details: ${JSON.stringify(res.err)}`);
        core.info(`[${index + 1}/${apps.length}] Error message: ${res.err.message}`);
        if ('code' in res.err && res.err.code) {
          core.info(`[${index + 1}/${apps.length}] Error code: ${res.err.code}`);
        }
      }

      if (res.stdout) {
        core.info(`[${index + 1}/${apps.length}] Found diff for ${app.metadata.name}`);
        diffs.push({ app, diff: res.stdout });
      } else {
        core.info(
          `[${index + 1}/${apps.length}] No diff, recording error for ${app.metadata.name}`
        );
        diffs.push({
          app,
          diff: '',
          error: res
        });
      }
    }
  });
  await postDiffComment(diffs);
  const diffsWithErrors = diffs.filter(d => d.error);
  if (diffsWithErrors.length) {
    core.setFailed(`ArgoCD diff failed: Encountered ${diffsWithErrors.length} errors`);
  }
}

function filterDiff(diffText: string): string {
  // Split the diff text into sections based on the headers
  const sections = diffText.split(/(?=^===== )/m);

  const filteredSection = sections
    .map(section =>
      section
        .replace(
          /(\d+(,\d+)?c\d+(,\d+)?\n)?<\s+argocd\.argoproj\.io\/instance:.*\n---\n>\s+argocd\.argoproj\.io\/instance:.*\n?/g,
          ''
        )
        .trim()
        .replace(/(\d+(,\d+)?c\d+(,\d+)?\n)?<\s+app.kubernetes.io\/part-of:.*\n?/g, '')
        .trim()
    )
    .filter(section => section !== '');

  // Remove empty strings and sections that are just headers with line numbers
  const removeEmptyHeaders = filteredSection.filter(entry => !entry.match(/^===== .*\/.* ======$/));

  // Join the filtered sections back together
  return removeEmptyHeaders.join('\n').trim();
}

// Avoid executing main automatically during tests
if (require.main === module) {
  // eslint-disable-next-line github/no-then
  run().catch(e => core.setFailed(e.message));
}
