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
        // Use let instead of const so we can dynamically remove bad keys
        let prefixKeys = core.getInput('prefix-keys').split(',').map(k => k.trim()).filter(Boolean);
        let suffixKeys = core.getInput('suffix-keys').split(',').map(k => k.trim()).filter(Boolean);
        let regexKeys = core.getInput('regex-keys').split(',').map(k => k.trim()).filter(Boolean);
        
        const sourceBranch = core.getInput('source-branch');
        const targetBranch = core.getInput('target-branch');
        const token = core.getInput('github-token');
        const testWorkflowId = core.getInput('test-workflow-id');

        if (prefixKeys.length === 0 && suffixKeys.length === 0 && regexKeys.length === 0) {
            throw new Error("You must provide at least one matching condition.");
        }
        
        const octokit = github.getOctokit(token);
        const { owner, repo } = github.context.repo;

        await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
        await exec.exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
        await exec.exec('git', ['fetch', '--all']);

        let mergeBase = '';
        await exec.exec('git', ['merge-base', `origin/${targetBranch}`, `origin/${sourceBranch}`], {
            listeners: { stdout: (data: Buffer) => mergeBase += data.toString() }
        });
        mergeBase = mergeBase.trim();

        let logOutput = '';
        await exec.exec('git', ['log', '--reverse', '--format=%H|%cD|%s', `${mergeBase}..origin/${sourceBranch}`], {
            listeners: { stdout: (data: Buffer) => logOutput += data.toString() }
        });
        
        const commits = logOutput.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('|');
            const hash = parts.shift()!;
            const date = parts.shift()!;
            const msg = parts.join('|');
            const shortHash = hash.substring(0, 7);
            return { hash, shortHash, date, msg };
        });

        const runUuid = crypto.randomUUID();
        const candidateBranch = `candidate/${runUuid}`;
        
        // Persist conflicts across all pipeline retries so the report shows everything that failed
        const finalConflicts: any[] = [];
        let finalSummary: any;

        // --- THE SELF-HEALING LOOP ---
        let retryPipeline = true;

        while (retryPipeline) {
            retryPipeline = false;
            let hasPendingChangesToTest = false;

            core.info('========================================');
            core.info(`Starting Pipeline Build. Active Prefixes: [${prefixKeys.join(', ')}]`);
            core.info('========================================');

            // 1. Wipe the branch clean to ensure a completely fresh start
            await exec.exec('git', ['checkout', `origin/${targetBranch}`]);
            try { await exec.exec('git', ['branch', '-D', candidateBranch], { silent: true }); } catch (e) {}
            await exec.exec('git', ['checkout', '-b', candidateBranch, `origin/${targetBranch}`]);

            const summary = { applied: [] as any[], skipped: [] as any[], testFailures: [] as any[] };

            for (const commit of commits) {
                // Find exactly WHICH keys triggered this commit so we can delete them if they break
                const matchedPrefixes = prefixKeys.filter(p => commit.msg.startsWith(p));
                const matchedSuffixes = suffixKeys.filter(s => commit.msg.endsWith(s));
                const matchedRegexes = regexKeys.filter(r => {
                    try { return new RegExp(r).test(commit.msg); } catch(e) { return false; }
                });

                const isMatch = matchedPrefixes.length > 0 || matchedSuffixes.length > 0 || matchedRegexes.length > 0;

                if (isMatch) {
                    core.info(`Applying commit: ${commit.shortHash} (${commit.msg})`);
                    const cherryPickOptions = { env: { ...process.env, GIT_COMMITTER_DATE: commit.date } };

                    try {
                        await exec.exec('git', ['cherry-pick', commit.hash], cherryPickOptions);
                        summary.applied.push(commit);
                        hasPendingChangesToTest = true;
                    } catch (error) {
                        core.warning(`🚨 Merge conflict on ${commit.shortHash}. Analyzing dependencies and pruning keys...`);
                        
                        const conflictedFiles = await getConflictedFiles();
                        await exec.exec('git', ['cherry-pick', '--abort']);
                        
                        const potentialFixes = [];
                        for (const skipped of summary.skipped) {
                            const intersection = skipped.files.filter((f: string) => conflictedFiles.includes(f));
                            if (intersection.length > 0) potentialFixes.push({...skipped, intersectingFiles: intersection});
                        }

                        // Combine all keys that were associated with this broken commit
                        const droppedKeys = [...matchedPrefixes, ...matchedSuffixes, ...matchedRegexes];

                        finalConflicts.push({
                            ...commit,
                            files: conflictedFiles,
                            potentialFixes: potentialFixes,
                            droppedKeys: droppedKeys // Save the pruned keys for the HTML report
                        });

                        // 2. PRUNE THE KEYS FROM THE LISTS
                        prefixKeys = prefixKeys.filter(k => !matchedPrefixes.includes(k));
                        suffixKeys = suffixKeys.filter(k => !matchedSuffixes.includes(k));
                        regexKeys = regexKeys.filter(k => !matchedRegexes.includes(k));

                        core.info(`❌ Dropped keys: [${droppedKeys.join(', ')}]. Wiping branch and restarting pipeline...`);
                        
                        // 3. TRIGGER THE RESTART
                        retryPipeline = true;
                        break; // Break the commit loop, which forces the while-loop to start over
                    }
                } else {
                    core.info(`Skipping commit: ${commit.shortHash} (${commit.msg})`);
                    const files = await getCommitFiles(commit.hash);
                    summary.skipped.push({ ...commit, files });

                    // --- OPTIONAL VALIDATION LOGIC ---
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
                                // Note: Currently, a test failure only drops the LAST commit, not the whole ticket.
                                // It behaves exactly as it did before.
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
                finalSummary = summary; // Save the successful run data
            }
        }

        await exec.exec('git', ['push', '-u', 'origin', candidateBranch]);
        core.setOutput('candidate-branch', candidateBranch);
        
        // Pass finalSummary and finalConflicts to the HTML generator
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
    
    const mapCommitList = (arr: any[]) => arr.length > 0 
        ? arr.map(c => `<li><a href="${commitBaseUrl}/${c.hash}" target="_blank" class="commit-link"><code>${c.shortHash}</code></a> ${c.msg}</li>`).join('') 
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
                        <h4>Conflicted Files</h4>
                        <ul>${c.files.map((f: string) => `<li>📄 ${f}</li>`).join('')}</ul>
                    </div>
                    <div class="fixes-column">
                        <h4>Potential Missing Dependencies (Skipped)</h4>
                        ${c.potentialFixes.length > 0 ? `
                            <ul>${c.potentialFixes.map((fix: any) => `
                                <li>
                                    <strong><a href="${commitBaseUrl}/${fix.hash}" target="_blank" class="commit-link"><code>${fix.shortHash}</code></a></strong> ${fix.msg}<br>
                                    <small>Touched: ${fix.intersectingFiles.join(', ')}</small>
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
                li { margin-bottom: 5px; font-family: monospace; font-size: 14px; }
                .empty { color: #586069; font-style: italic; list-style-type: none; }
                
                a.commit-link { text-decoration: none; }
                a.commit-link code { color: #0366d6; cursor: pointer; }
                a.commit-link:hover code { text-decoration: underline; color: #005cc5; }
                
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
            <ul>${mapCommitList(summary.skipped)}</ul>
            
            <h3>⚠️ Invalidated Tickets (Merge Conflicts)</h3>
            ${generateConflictGraph(conflicts)}
            
            <h3>❌ Dropped due to Failed Validation Tests${testingStatus}</h3>
            <ul>${mapCommitList(summary.testFailures)}</ul>
        </body>
    </html>`;

    fs.writeFileSync('index.html', html);

    try { await exec.exec('git', ['checkout', 'gh-pages']); } 
    catch {
        await exec.exec('git', ['checkout', '--orphan', 'gh-pages']);
        await exec.exec('git', ['rm', '-rf', '.']);
    }
    
    fs.writeFileSync(`report-${runUuid}.html`, html);
    fs.copyFileSync(`report-${runUuid}.html`, 'index.html');
    await exec.exec('git', ['add', `report-${runUuid}.html`, 'index.html']);
    await exec.exec('git', ['commit', '-m', `Add automation report for ${candidateBranch}`]);
    await exec.exec('git', ['push', 'origin', 'gh-pages']);
}