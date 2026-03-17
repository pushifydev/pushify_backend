import { execCommand, execStreamingCommand, type StreamingCommandOptions } from './shell';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export interface CloneOptions {
  repoUrl: string;
  branch?: string;
  accessToken?: string;
  depth?: number;
  onProgress?: (message: string) => void;
}

export interface CloneResult {
  workDir: string;
  commitHash: string;
  commitMessage: string;
  branch: string;
}

/**
 * Clone a Git repository to a temporary directory
 */
export async function cloneRepository(options: CloneOptions): Promise<CloneResult> {
  const { repoUrl, branch, accessToken, depth = 1, onProgress } = options;

  // Create temp directory
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushify-'));
  const workDir = path.join(tmpDir, 'repo');

  onProgress?.(`📦 Cloning repository to ${workDir}...`);

  // Prepare authenticated URL if access token provided
  let cloneUrl = repoUrl;
  if (accessToken && repoUrl.includes('github.com')) {
    // Convert https://github.com/user/repo.git to https://token@github.com/user/repo.git
    cloneUrl = repoUrl.replace('https://github.com/', `https://${accessToken}@github.com/`);
  }

  // Clone command - if branch is specified, use it; otherwise clone default branch
  const cloneArgs = ['clone', '--single-branch'];
  if (branch) {
    cloneArgs.push('--branch', branch);
  }
  if (depth > 0) {
    cloneArgs.push('--depth', String(depth));
  }
  cloneArgs.push(cloneUrl, workDir);

  const streamOptions: StreamingCommandOptions = {
    onStdout: (data) => onProgress?.(data.trim()),
    onStderr: (data) => onProgress?.(data.trim()),
    timeout: 300000, // 5 minutes
  };

  let result = await execStreamingCommand('git', cloneArgs, streamOptions);

  // If branch was specified and clone failed, try without branch (use default)
  if (result.exitCode !== 0 && branch) {
    onProgress?.(`⚠️ Branch "${branch}" not found, trying default branch...`);

    // Clean up failed attempt
    await fs.rm(tmpDir, { recursive: true, force: true });

    // Create new temp directory
    const newTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushify-'));
    const newWorkDir = path.join(newTmpDir, 'repo');

    // Clone without specific branch
    const defaultCloneArgs = ['clone', '--single-branch'];
    if (depth > 0) {
      defaultCloneArgs.push('--depth', String(depth));
    }
    defaultCloneArgs.push(cloneUrl, newWorkDir);

    result = await execStreamingCommand('git', defaultCloneArgs, streamOptions);

    if (result.exitCode !== 0) {
      await fs.rm(newTmpDir, { recursive: true, force: true });
      throw new Error(`Failed to clone repository: ${result.stderr}`);
    }

    onProgress?.('✅ Repository cloned successfully (using default branch)');

    // Get the actual branch name
    const branchResult = await execCommand('git branch --show-current', { cwd: newWorkDir });
    onProgress?.(`📌 Default branch: ${branchResult.stdout.trim()}`);

    // Get commit info
    const hashResult = await execCommand('git rev-parse HEAD', { cwd: newWorkDir });
    const commitHash = hashResult.stdout.trim();

    const messageResult = await execCommand('git log -1 --pretty=%B', { cwd: newWorkDir });
    const commitMessage = messageResult.stdout.trim().split('\n')[0];

    onProgress?.(`📝 Commit: ${commitHash.substring(0, 7)} - ${commitMessage}`);

    const detectedBranch = branchResult.stdout.trim();
    return {
      workDir: newWorkDir,
      commitHash,
      commitMessage,
      branch: detectedBranch,
    };
  }

  if (result.exitCode !== 0) {
    // Clean up on failure
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw new Error(`Failed to clone repository: ${result.stderr}`);
  }

  onProgress?.('✅ Repository cloned successfully');

  // Get branch info
  const branchResult = await execCommand('git branch --show-current', { cwd: workDir });
  const clonedBranch = branchResult.stdout.trim() || branch || 'main';
  onProgress?.(`📌 Branch: ${clonedBranch}`);

  // Get commit info
  const hashResult = await execCommand('git rev-parse HEAD', { cwd: workDir });
  const commitHash = hashResult.stdout.trim();

  const messageResult = await execCommand('git log -1 --pretty=%B', { cwd: workDir });
  const commitMessage = messageResult.stdout.trim().split('\n')[0]; // First line only

  onProgress?.(`📝 Commit: ${commitHash.substring(0, 7)} - ${commitMessage}`);

  return {
    workDir,
    commitHash,
    commitMessage,
    branch: clonedBranch,
  };
}

/**
 * Clean up cloned repository
 */
export async function cleanupRepository(workDir: string): Promise<void> {
  try {
    // Get parent temp directory
    const tmpDir = path.dirname(workDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
