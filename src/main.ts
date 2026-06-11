import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as crypto from 'crypto';

export async function run(): Promise<void> {
    try {
        const prefixKeys = core.getInput('prefix-keys').split(',').map(k => k.trim()).filter(Boolean);
        const suffixKeys = core.getInput('suffix-keys').split(',').map(k => k.trim()).filter(Boolean);
        const regexKeys = core.getInput('regex-keys').split(',').map(k => k.trim()).filter(Boolean);
        
        const sourceBranch = core.getInput('source-branch');
        const targetBranch = core.getInput('target-branch');
        const token = core.getInput('github-token');
        const testWorkflowId = core.getInput('test-workflow-id'); // Will be '' if omitted

        if (prefixKeys.length === 0 && suffixKeys.length === 0 && regexKeys.length === 0) {
            throw new Error("You must provide at least one matching condition: prefix-keys, suffix-keys, or regex-keys.");
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
        
        core.debug(`Calculated Merge Base: ${mergeBase}`);

        let logOutput = '';
        await exec.exec('git', ['log', '--reverse', '--format=%H|%cD|%s', `${mergeBase}..origin/${sourceBranch}`], {
            listeners: { stdout: (data: Buffer) => logOutput += data.toString() }
        });
        
        const commits = logOutput.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('|');
            const hash = parts.shift()!;
            const date = parts.shift()!;
            const msg = parts.join('|');
            return { hash, date, msg };
        });

        const runUuid = crypto.randomUUID();
        const candidateBranch = `candidate/${runUuid}`;
        await exec.exec('git', ['checkout', '-b', candidateBranch, `origin/${targetBranch}`]);

        const summary = { 
            applied: [] as string[], 
            skipped: [] as string[], 
            conflicts: [] as string[], 
            testFailures: [] as string[] 
        };
        let hasPendingChangesToTest = false;

        for (const commit of commits) {
            let isMatch = false;

            if (prefixKeys.length > 0) {
                isMatch = isMatch || prefixKeys.some(prefix => commit.msg.startsWith(prefix));
            }
            if (!isMatch && suffixKeys.length > 0) {
                isMatch = isMatch || suffixKeys.some(suffix => commit.msg.endsWith(suffix));
            }
            if (!isMatch && regexKeys.length > 0) {
                isMatch = isMatch || regexKeys.some(regexStr => {
                    try {
                        const regex = new RegExp(regexStr);
                        return regex.test(commit.msg);
                    } catch (e) {
                        core.warning(`Invalid Regex provided: ${regexStr}. Skipping this pattern.`);
                        return false;
                    }
                });
            }
            
            core.debug(`Evaluating commit ${commit.hash} - Match found? ${isMatch}`);

            if (isMatch) {
                core.info(`Applying commit: ${commit.hash} (${commit.msg})`);
                
                const cherryPickOptions = {
                    env: { ...process.env, GIT_COMMITTER_DATE: commit.date }
                };

                try {
                    await exec.exec('git', ['cherry-pick', commit.hash], cherryPickOptions);
                    summary.applied.push(commit.hash);
                    hasPendingChangesToTest = true;
                } catch (error) {
                    core.warning(`Merge conflict on ${commit.hash}. Aborting cherry-pick and dropping commit.`);
                    await exec.exec('git', ['cherry-pick', '--abort']);
                    
                    const conflictBranch = `conflict-data/${commit.hash}-${runUuid}`;
                    await exec.exec('git', ['checkout', '-b', conflictBranch]);
                    
                    await exec.exec('git', ['cherry-pick', '-n', commit.hash], { ignoreReturnCode: true });
                    await exec.exec('git', ['commit', '-am', `Conflict data for ${commit.hash}`], { ignoreReturnCode: true });
                    await exec.exec('git', ['push', '-u', 'origin', conflictBranch]);
                    
                    await exec.exec('git', ['checkout', candidateBranch]);
                    summary.conflicts.push(commit.hash);
                }
            } else {
                core.info(`Skipping commit: ${commit.hash} (${commit.msg})`);
                summary.skipped.push(commit.hash);

                // --- OPTIONAL VALIDATION LOGIC ---
                if (hasPendingChangesToTest) {
                    if (testWorkflowId) {
                        let testPassed = false;
                        
                        core.startGroup(`Automated Validation Loop for pending commits`);
                        
                        while (!testPassed && summary.applied.length > 0) {
                            core.debug(`Current applied queue before test: ${JSON.stringify(summary.applied)}`);
                            
                            const tmpBranch = `build/tmp/${runUuid}`;
                            
                            await exec.exec('git', ['checkout', '-B', tmpBranch]);
                            await exec.exec('git', ['push', '-u', 'origin', tmpBranch, '--force']);

                            let success = false;
                            const isYaml = testWorkflowId.endsWith('.yml') || testWorkflowId.endsWith('.yaml');

                            if (isYaml) {
                                core.info(`Triggering GitHub workflow ${testWorkflowId} for ${tmpBranch}...`);
                                await octokit.rest.actions.createWorkflowDispatch({
                                    owner, repo, workflow_id: testWorkflowId, ref: tmpBranch
                                });
                                success = await pollWorkflowRun(octokit, owner, repo, testWorkflowId, tmpBranch);
                            } else {
                                core.info(`🔧 Local script mode detected. Executing: ${testWorkflowId}`);
                                try {
                                    await exec.exec(testWorkflowId);
                                    success = true; 
                                } catch (err) {
                                    success = false; 
                                }
                            }
                            
                            await exec.exec('git', ['checkout', candidateBranch]);
                            
                            if (success) {
                                core.info('Validation passed. Proceeding with cherry-pick loop.');
                                testPassed = true;
                                hasPendingChangesToTest = false;
                            } else {
                                const droppedCommit = summary.applied.pop();
                                core.warning(`Validation failed. Dropping last applied commit: ${droppedCommit}`);
                                core.debug(`Executing git reset --hard HEAD~1 to drop ${droppedCommit}`);
                                summary.testFailures.push(droppedCommit!);
                                await exec.exec('git', ['reset', '--hard', 'HEAD~1']);
                            }
                        }
                        core.endGroup();
                    } else {
                        // Validation is disabled. Clear the pending flag and move on.
                        core.info('Validation testing is disabled. Proceeding directly to next commit.');
                        hasPendingChangesToTest = false;
                    }
                }
            }
        }

        await exec.exec('git', ['push', '-u', 'origin', candidateBranch]);

        core.setOutput('applied-commits', summary.applied.join(','));
        core.setOutput('candidate-branch', candidateBranch);

        await publishSummary(summary, candidateBranch, runUuid, testWorkflowId);

    } catch (error: any) {
        core.setFailed(error.message);
    }
}

async function pollWorkflowRun(octokit: any, owner: string, repo: string, workflowId: string, branch: string): Promise<boolean> {
    const initialDelay = parseInt(process.env.TEST_DELAY_MS || '15000', 10);
    const pollDelay = parseInt(process.env.TEST_DELAY_MS || '20000', 10);

    core.info('Waiting for workflow run to register...');
    await new Promise(r => setTimeout(r, initialDelay)); 

    const runs = await octokit.rest.actions.listWorkflowRuns({
        owner, repo, workflow_id: workflowId, branch, per_page: 1
    });

    if (!runs.data.workflow_runs || runs.data.workflow_runs.length === 0) {
        throw new Error(`Failed to find triggered workflow run for branch ${branch}`);
    }

    const runId = runs.data.workflow_runs[0].id;
    core.info(`Polling workflow run ${runId}...`);

    while (true) {
        const { data: runData } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
        if (runData.status === 'completed') {
            return runData.conclusion === 'success';
        }
        await new Promise(r => setTimeout(r, pollDelay));
    }
}

async function publishSummary(summary: any, candidateBranch: string, runUuid: string, testWorkflowId: string) {
    const testingStatus = testWorkflowId ? '' : ' <i>(Testing Disabled)</i>';
    
    const html = `
    <!DOCTYPE html>
    <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Rebase Summary ${runUuid}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #333; }
                h1 { border-bottom: 2px solid #eaecef; padding-bottom: .3em; }
                h2 { color: #0366d6; }
                ul { background: #f6f8fa; padding: 15px 40px; border-radius: 6px; }
                li { margin-bottom: 5px; font-family: monospace; }
                .empty { color: #586069; font-style: italic; list-style-type: none; }
            </style>
        </head>
        <body>
            <h1>Rebase Execution Summary</h1>
            <h2>Candidate Branch: <code>${candidateBranch}</code></h2>
            
            <h3>✅ Applied Commits (${summary.applied.length})</h3>
            <ul>${summary.applied.length > 0 ? summary.applied.map((c: string) => `<li>${c}</li>`).join('') : '<li class="empty">None</li>'}</ul>
            
            <h3>⏭️ Skipped Commits (Did not match patterns)</h3>
            <ul>${summary.skipped.length > 0 ? summary.skipped.map((c: string) => `<li>${c}</li>`).join('') : '<li class="empty">None</li>'}</ul>
            
            <h3>⚠️ Dropped due to Merge Conflicts</h3>
            <ul>${summary.conflicts.length > 0 ? summary.conflicts.map((c: string) => `<li>${c}</li>`).join('') : '<li class="empty">None</li>'}</ul>
            
            <h3>❌ Dropped due to Failed Validation Tests${testingStatus}</h3>
            <ul>${summary.testFailures.length > 0 ? summary.testFailures.map((c: string) => `<li>${c}</li>`).join('') : '<li class="empty">None</li>'}</ul>
        </body>
    </html>`;

    fs.writeFileSync('index.html', html);

    try {
        await exec.exec('git', ['checkout', 'gh-pages']);
    } catch {
        await exec.exec('git', ['checkout', '--orphan', 'gh-pages']);
        await exec.exec('git', ['rm', '-rf', '.']);
    }
    
    fs.writeFileSync(`report-${runUuid}.html`, html);
    fs.copyFileSync(`report-${runUuid}.html`, 'index.html');
    
    await exec.exec('git', ['add', `report-${runUuid}.html`, 'index.html']);
    await exec.exec('git', ['commit', '-m', `Add automation report for ${candidateBranch}`]);
    await exec.exec('git', ['push', 'origin', 'gh-pages']);
}