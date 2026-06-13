import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as crypto from 'crypto';

async function getCommitFiles(hash: string): Promise<string[]> {
    let output = '';
    await exec.exec('git', ['show', '--name-only', '--format=', hash], {
        listeners: { stdout: (data: Buffer) => output += data.toString() },
        silent: true 
    });
    return output.trim().split('\n').filter(Boolean);
}

async function getConflictedFiles(): Promise<string[]> {
    let output = '';
    await exec.exec('git', ['diff', '--name-only', '--diff-filter=U'], {
        listeners: { stdout: (data: Buffer) => output += data.toString() },
        ignoreReturnCode: true,
        silent: true
    });
    return output.trim().split('\n').filter(Boolean);
}

export async function run(): Promise<void> {
    try {
        let prefixKeys = core.getInput('prefix-keys').split(',').map(k => k.trim()).filter(Boolean);
        let suffixKeys = core.getInput('suffix-keys').split(',').map(k => k.trim()).filter(Boolean);
        let regexKeys = core.getInput('regex-keys').split(',').map(k => k.trim()).filter(Boolean);
        
        const initialPrefixKeys = [...prefixKeys];
        const initialSuffixKeys = [...suffixKeys];
        const initialRegexKeys = [...regexKeys];

        const sourceBranch = core.getInput('source-branch');
        const targetBranch = core.getInput('target-branch');
        const token = core.getInput('github-token');
        const testWorkflowId = core.getInput('test-workflow-id');

        if (prefixKeys.length === 0 && suffixKeys.length === 0 && regexKeys.length === 0) {
            throw new Error("You must provide at least one matching condition.");
        }
        
        const octokit = github.getOctokit(token);
        const { owner, repo } = github.context.repo;

        // Fallback bot config (only used for UI branch commits like the report or conflict-data)
        await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
        await exec.exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
        await exec.exec('git', ['fetch', '--all']);

        let mergeBase = '';
        await exec.exec('git', ['merge-base', `origin/${targetBranch}`, `origin/${sourceBranch}`], {
            listeners: { stdout: (data: Buffer) => mergeBase += data.toString() }
        });
        mergeBase = mergeBase.trim();

        let logOutput = '';
        
        // 1. UPDATED LOG FORMAT: Extract exact Committer Name (%cn), Email (%ce), and ISO Date (%cI)
        await exec.exec('git', ['log', '--reverse', '--format=%H|%cn|%ce|%cI|%s', `${mergeBase}..origin/${sourceBranch}`], {
            listeners: { stdout: (data: Buffer) => logOutput += data.toString() }
        });
        
        const commits = logOutput.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('|');
            const hash = parts.shift()!;
            const cName = parts.shift()!;
            const cEmail = parts.shift()!;
            const cDate = parts.shift()!;
            const msg = parts.join('|');
            const shortHash = hash.substring(0, 7).toUpperCase(); 
            return { hash, shortHash, cName, cEmail, cDate, msg };
        });

        const runUuid = crypto.randomUUID();
        const candidateBranch = `candidate/${runUuid}`;
        
        const finalConflicts: any[] = [];
        let finalSummary: any;

        let retryPipeline = true;

        while (retryPipeline) {
            retryPipeline = false;
            let hasPendingChangesToTest = false;

            core.info('========================================');
            core.info(`Starting Pipeline Build. Active Prefixes: [${prefixKeys.join(', ')}]`);
            core.info('========================================');

            await exec.exec('git', ['checkout', `origin/${targetBranch}`]);
            try { await exec.exec('git', ['branch', '-D', candidateBranch], { silent: true }); } catch (e) {}
            await exec.exec('git', ['checkout', '-b', candidateBranch, `origin/${targetBranch}`]);

            const summary = { applied: [] as any[], skipped: [] as any[], testFailures: [] as any[] };

            for (const commit of commits) {
                const matchedPrefixes = prefixKeys.filter(p => commit.msg.startsWith(p));
                const matchedSuffixes = suffixKeys.filter(s => commit.msg.endsWith(s));
                const matchedRegexes = regexKeys.filter(r => {
                    try { return new RegExp(r).test(commit.msg); } catch(e) { return false; }
                });

                const isMatch = matchedPrefixes.length > 0 || matchedSuffixes.length > 0 || matchedRegexes.length > 0;

                if (isMatch) {
                    core.info(`Applying commit: ${commit.shortHash} (${commit.msg})`);
                    
                    // 2. SPOOF COMMITTER: Inject the original committer's exact data to prevent changes
                    const cherryPickOptions = { 
                        env: { 
                            ...process.env, 
                            GIT_COMMITTER_NAME: commit.cName,
                            GIT_COMMITTER_EMAIL: commit.cEmail,
                            GIT_COMMITTER_DATE: commit.cDate
                        } 
                    };

                    try {
                        await exec.exec('git', ['cherry-pick', commit.hash], cherryPickOptions);
                        summary.applied.push(commit);
                        hasPendingChangesToTest = true;
                    } catch (error) {
                        core.warning(`🚨 Merge conflict on ${commit.shortHash}. Analyzing dependencies and pruning keys...`);
                        
                        const conflictedFiles = await getConflictedFiles();
                        
                        const conflictBranch = `conflict-data/${commit.shortHash}-${runUuid}`;
                        await exec.exec('git', ['cherry-pick', '--abort']);
                        await exec.exec('git', ['checkout', '-b', conflictBranch]);
                        await exec.exec('git', ['cherry-pick', '-n', commit.hash], { ignoreReturnCode: true });
                        await exec.exec('git', ['commit', '-am', `Conflict data for ${commit.hash}`], { ignoreReturnCode: true });
                        await exec.exec('git', ['push', '-u', 'origin', conflictBranch], { ignoreReturnCode: true });
                        
                        const potentialFixes = [];
                        for (const skipped of summary.skipped) {
                            const intersection = skipped.files.filter((f: string) => conflictedFiles.includes(f));
                            const others = skipped.files.filter((f: string) => !conflictedFiles.includes(f));
                            
                            if (intersection.length > 0) {
                                potentialFixes.push({
                                    ...skipped, 
                                    intersectingFiles: intersection,
                                    otherFiles: others
                                });
                            }
                        }

                        const droppedKeys = [...matchedPrefixes, ...matchedSuffixes, ...matchedRegexes];

                        finalConflicts.push({
                            ...commit,
                            files: conflictedFiles,
                            potentialFixes: potentialFixes,
                            droppedKeys: droppedKeys,
                            conflictBranch: conflictBranch 
                        });

                        prefixKeys = prefixKeys.filter(k => !matchedPrefixes.includes(k));
                        suffixKeys = suffixKeys.filter(k => !matchedSuffixes.includes(k));
                        regexKeys = regexKeys.filter(k => !matchedRegexes.includes(k));

                        core.info(`❌ Dropped keys: [${droppedKeys.join(', ')}]. Wiping branch and restarting pipeline...`);
                        
                        retryPipeline = true;
                        break; 
                    }
                } else {
                    core.info(`Skipping commit: ${commit.shortHash} (${commit.msg})`);
                    const files = await getCommitFiles(commit.hash);
                    
                    const matchedInitialPrefixes = initialPrefixKeys.some(p => commit.msg.startsWith(p));
                    const matchedInitialSuffixes = initialSuffixKeys.some(s => commit.msg.endsWith(s));
                    const matchedInitialRegexes = initialRegexKeys.some(r => {
                        try { return new RegExp(r).test(commit.msg); } catch(e) { return false; }
                    });
                    
                    const isPruned = matchedInitialPrefixes || matchedInitialSuffixes || matchedInitialRegexes;
                    const reason = isPruned ? 'Pruned (Merge Conflict)' : 'Ignored (No Match)';

                    summary.skipped.push({ ...commit, files, reason });

                    if (hasPendingChangesToTest && testWorkflowId) {
                        let testPassed = false;
                        core.startGroup(`Automated Validation Loop`);
                        
                        while (!testPassed && summary.applied.length > 0) {
                            const tmpBranch = `build/tmp/${runUuid}`;
                            await exec.exec('git', ['checkout', '-B', tmpBranch]);
                            await exec.exec('git', ['push', '-u', 'origin', tmpBranch, '--force']);

                            let success = false;
                            if (testWorkflowId.endsWith('.yml') || testWorkflowId.endsWith('.yaml')) {
                                await octokit.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: testWorkflowId, ref: tmpBranch });
                                success = await pollWorkflowRun(octokit, owner, repo, testWorkflowId, tmpBranch);
                            } else {
                                try { await exec.exec(testWorkflowId); success = true; } catch { success = false; }
                            }
                            
                            await exec.exec('git', ['checkout', candidateBranch]);
                            
                            if (success) {
                                testPassed = true;
                                hasPendingChangesToTest = false;
                            } else {
                                const droppedCommit = summary.applied.pop();
                                summary.testFailures.push(droppedCommit);
                                await exec.exec('git', ['reset', '--hard', 'HEAD~1']);
                            }
                        }
                        core.endGroup();
                    } else if (!testWorkflowId) {
                        hasPendingChangesToTest = false;
                    }
                }
            }

            if (!retryPipeline) {
                finalSummary = summary; 
            }
        }

        await exec.exec('git', ['push', '-u', 'origin', candidateBranch]);
        core.setOutput('candidate-branch', candidateBranch);
        
        await publishSummary(finalSummary, finalConflicts, candidateBranch, runUuid, testWorkflowId);

    } catch (error: any) {
        core.setFailed(error.message);
    }
}

async function pollWorkflowRun(octokit: any, owner: string, repo: string, workflowId: string, branch: string): Promise<boolean> {
    const initialDelay = parseInt(process.env.TEST_DELAY_MS || '15000', 10);
    const pollDelay = parseInt(process.env.TEST_DELAY_MS || '20000', 10);
    await new Promise(r => setTimeout(r, initialDelay)); 
    const runs = await octokit.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: workflowId, branch, per_page: 1 });
    if (!runs.data.workflow_runs || runs.data.workflow_runs.length === 0) throw new Error(`Workflow run not found.`);
    const runId = runs.data.workflow_runs[0].id;

    while (true) {
        const { data: runData } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
        if (runData.status === 'completed') return runData.conclusion === 'success';
        await new Promise(r => setTimeout(r, pollDelay));
    }
}

async function publishSummary(summary: any, conflicts: any[], candidateBranch: string, runUuid: string, testWorkflowId: string) {
    const testingStatus = testWorkflowId ? '' : ' <i>(Testing Disabled)</i>';
    
    const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
    const repository = process.env.GITHUB_REPOSITORY;
    
    const commitBaseUrl = `${serverUrl}/${repository}/commit`;
    const blobBaseUrl = `${serverUrl}/${repository}/blob`;
    
    const mapCommitList = (arr: any[]) => arr.length > 0 
        ? arr.map(c => `<li><a href="${commitBaseUrl}/${c.hash}" target="_blank" class="commit-link"><code>${c.shortHash}</code></a> ${c.msg}</li>`).join('') 
        : '<li class="empty">None</li>';

    const mapSkippedCommitList = (arr: any[]) => arr.length > 0 
        ? arr.map(c => {
            const badgeClass = c.reason.includes('Ignored') ? 'badge-ignored' : 'badge-conflict';
            return `<li><a href="${commitBaseUrl}/${c.hash}" target="_blank" class="commit-link"><code>${c.shortHash}</code></a> ${c.msg} <span class="badge ${badgeClass}">${c.reason}</span></li>`;
        }).join('') 
        : '<li class="empty">None</li>';

    const mapFailedTestList = (arr: any[]) => arr.length > 0 
        ? arr.map(c => `<li><a href="${commitBaseUrl}/${c.hash}" target="_blank" class="commit-link"><code>${c.shortHash}</code></a> ${c.msg} <span class="badge badge-failed">Validation Failed</span></li>`).join('') 
        : '<li class="empty">None</li>';

    const generateConflictGraph = (conflictsArray: any[]) => {
        if (conflictsArray.length === 0) return '<p class="empty" style="margin-left: 40px;">None</p>';
        
        return conflictsArray.map(c => `
            <div class="conflict-card">
                <div class="commit-header">
                    <strong>🚨 Pipeline Reset - Bad Keys Pruned: <code>[${c.droppedKeys.join(', ')}]</code></strong>
                    <br>
                    <small>Conflict on: <a href="${commitBaseUrl}/${c.hash}" target="_blank" class="commit-link"><code>${c.shortHash}</code></a> ${c.msg}</small>
                </div>
                <div class="conflict-body">
                    <div class="files-column">
                        <h4>Conflicted Files (Branch View)</h4>
                        <ul>${c.files.map((f: string) => `
                            <li><a href="${blobBaseUrl}/${c.conflictBranch}/${f}" target="_blank" class="file-link">📄 ${f}</a></li>
                        `).join('')}</ul>
                    </div>
                    <div class="fixes-column">
                        <h4>Potential Missing Dependencies (Commit View)</h4>
                        ${c.potentialFixes.length > 0 ? `
                            <ul>${c.potentialFixes.map((fix: any) => `
                                <li>
                                    <strong><a href="${commitBaseUrl}/${fix.hash}" target="_blank" class="commit-link"><code>${fix.shortHash}</code></a></strong> ${fix.msg}<br>
                                    <div style="margin-top: 6px;">
                                        <small><strong>Conflicting:</strong> ${fix.intersectingFiles.map((f: string) => `
                                            <a href="${blobBaseUrl}/${fix.hash}/${f}" target="_blank" class="file-link">${f}</a>
                                        `).join(', ')}</small>
                                        
                                        ${fix.otherFiles.length > 0 ? `
                                            <details style="margin-top: 6px; cursor: pointer;">
                                                <summary style="color: #0366d6; font-size: 11px; font-family: monospace;">Show ${fix.otherFiles.length} other files touched</summary>
                                                <div style="padding-left: 10px; margin-top: 4px;">
                                                    <small>${fix.otherFiles.map((f: string) => `
                                                        <a href="${blobBaseUrl}/${fix.hash}/${f}" target="_blank" class="file-link">${f}</a>
                                                    `).join('<br>')}</small>
                                                </div>
                                            </details>
                                        ` : ''}
                                    </div>
                                </li>
                            `).join('')}</ul>
                        ` : `<p class="empty">No skipped commits touched these files.</p>`}
                    </div>
                </div>
            </div>
        `).join('');
    };

    const html = `
    <!DOCTYPE html>
    <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Rebase Summary ${runUuid}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #333; }
                h1 { border-bottom: 2px solid #eaecef; padding-bottom: .3em; }
                h2 { color: #0366d6; }
                ul { background: #f6f8fa; padding: 15px 40px; border-radius: 6px; }
                li { margin-bottom: 8px; font-family: monospace; font-size: 14px; }
                .empty { color: #586069; font-style: italic; list-style-type: none; }
                
                a.commit-link { text-decoration: none; }
                a.commit-link code { color: #0366d6; cursor: pointer; }
                a.commit-link:hover code { text-decoration: underline; color: #005cc5; }
                
                a.file-link { text-decoration: none; color: #24292e; transition: color 0.2s; }
                a.file-link:hover { text-decoration: underline; color: #0366d6; }
                
                .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; margin-left: 8px; vertical-align: middle; font-family: -apple-system, sans-serif; }
                .badge-ignored { background: #e1e4e8; color: #586069; }
                .badge-conflict { background: #ffdce0; color: #b31d28; }
                .badge-failed { background: #fff5b1; color: #b08800; }
                
                details summary { outline: none; transition: color 0.2s; }
                details summary:hover { color: #005cc5; }

                .conflict-card { border: 1px solid #d73a49; border-radius: 6px; margin: 15px 0 15px 40px; overflow: hidden; }
                .commit-header { background: #ffeef0; padding: 10px 15px; border-bottom: 1px solid #d73a49; color: #b31d28; font-family: monospace;}
                .commit-header a.commit-link code { color: #b31d28; text-decoration: underline; }
                .conflict-body { display: flex; background: #fff; }
                .files-column, .fixes-column { padding: 15px; flex: 1; }
                .files-column { border-right: 1px solid #eaecef; background: #fdf8f8; }
                .fixes-column { background: #f1f8ff; }
                .conflict-card h4 { margin-top: 0; font-size: 13px; text-transform: uppercase; color: #586069; border-bottom: 1px solid #eaecef; padding-bottom: 5px;}
                .conflict-card ul { background: transparent; padding-left: 20px; margin: 0; }
                .conflict-card li { font-family: -apple-system, sans-serif; font-size: 13px; margin-bottom: 10px; }
                .conflict-card small { display: block; color: #586069; margin-top: 2px; font-family: monospace; font-size: 11px;}
            </style>
        </head>
        <body>
            <h1>Rebase Execution Summary</h1>
            <h2>Candidate Branch: <code>${candidateBranch}</code></h2>
            
            <h3>✅ Applied Commits (${summary.applied.length})</h3>
            <ul>${mapCommitList(summary.applied)}</ul>
            
            <h3>⏭️ Skipped Commits</h3>
            <ul>${mapSkippedCommitList(summary.skipped)}</ul>
            
            <h3>⚠️ Invalidated Tickets (Merge Conflicts)</h3>
            ${generateConflictGraph(conflicts)}
            
            <h3>❌ Dropped due to Failed Validation Tests${testingStatus}</h3>
            <ul>${mapFailedTestList(summary.testFailures)}</ul>
        </body>
    </html>`;

    let lsRemoteOutput = '';
    await exec.exec('git', ['ls-remote', '--heads', 'origin', 'gh-pages'], {
        listeners: { stdout: (data: Buffer) => lsRemoteOutput += data.toString() },
        silent: true
    });

    const hasRemoteGhPages = lsRemoteOutput.trim().length > 0;

    if (hasRemoteGhPages) {
        core.info('Remote gh-pages branch found. Syncing...');
        await exec.exec('git', ['fetch', 'origin', 'gh-pages']);
        try { await exec.exec('git', ['branch', '-D', 'gh-pages'], { silent: true }); } catch (e) {}
        await exec.exec('git', ['checkout', '-b', 'gh-pages', 'origin/gh-pages']);
    } else {
        core.info('Remote gh-pages branch not found. Creating a new orphan branch...');
        await exec.exec('git', ['checkout', '--orphan', 'gh-pages']);
        await exec.exec('git', ['rm', '-rf', '.']);
    }

    fs.writeFileSync('index.html', html);
    fs.writeFileSync(`report-${runUuid}.html`, html);
    
    await exec.exec('git', ['add', `report-${runUuid}.html`, 'index.html']);
    await exec.exec('git', ['commit', '-m', `Add automation report for ${candidateBranch}`]);
    await exec.exec('git', ['push', 'origin', 'gh-pages']);

    await exec.exec('git', ['checkout', candidateBranch]);
}
