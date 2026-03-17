import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface StreamingCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  timeout?: number;
}

/**
 * Execute a shell command and return the result
 */
export async function execCommand(
  command: string,
  options?: { cwd?: string; timeout?: number }
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: options?.cwd,
      timeout: options?.timeout || 300000, // 5 minutes default
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || String(error),
      exitCode: err.code || 1,
    };
  }
}

/**
 * Execute a shell command with streaming output
 */
export function execStreamingCommand(
  command: string,
  args: string[],
  options: StreamingCommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: true,
    });

    let timeoutId: NodeJS.Timeout | null = null;
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        proc.kill('SIGTERM');
        stderr += '\nProcess killed due to timeout';
      }, options.timeout);
    }

    proc.stdout.on('data', (data) => {
      const str = data.toString();
      stdout += str;
      options.onStdout?.(str);
    });

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      stderr += str;
      options.onStderr?.(str);
    });

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
      });
    });

    proc.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        stdout,
        stderr: stderr + '\n' + error.message,
        exitCode: 1,
      });
    });
  });
}
