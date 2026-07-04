import { Client, type ClientChannel } from 'ssh2';
import type { SSHConnectionConfig } from '../utils/ssh';

export interface ShellPtyOptions {
  term?: string;
  cols: number;
  rows: number;
}

export interface ShellSessionCallbacks {
  onData: (data: Buffer) => void;
  onClose: () => void;
  onError: (error: Error) => void;
}

/**
 * Interactive SSH shell (PTY) — one instance per web terminal session.
 */
export class SSHShellSession {
  private client = new Client();
  private stream: ClientChannel | null = null;
  private closed = false;

  async connect(
    config: SSHConnectionConfig,
    pty: ShellPtyOptions,
    callbacks: ShellSessionCallbacks,
    /** When set, run this command with a PTY instead of an interactive login shell
     *  (e.g. `docker exec -it <container> sh` for the app-container web shell). */
    execCommand?: string,
  ): Promise<void> {
    if (!config.privateKey && !config.password) {
      throw new Error('SSH shell requires privateKey or password');
    }

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        if (!this.closed) {
          callbacks.onError(err);
        }
        reject(err);
      };

      this.client.once('error', onError);

      this.client.once('ready', () => {
        const ptyOptions = {
          term: pty.term ?? 'xterm-256color',
          cols: pty.cols,
          rows: pty.rows,
        };
        const onStream = (err: Error | undefined, stream: ClientChannel) => {
            if (err) {
              onError(err);
              return;
            }

            this.stream = stream;
            this.client.removeListener('error', onError);
            this.client.on('error', (e) => callbacks.onError(e));

            stream.on('data', (chunk: Buffer) => {
              callbacks.onData(chunk);
            });

            stream.stderr.on('data', (chunk: Buffer) => {
              callbacks.onData(chunk);
            });

            const finish = () => {
              if (this.closed) return;
              this.closed = true;
              callbacks.onClose();
            };

            stream.on('close', finish);
            stream.on('end', finish);

            resolve();
        };

        if (execCommand) {
          this.client.exec(execCommand, { pty: ptyOptions }, onStream);
        } else {
          this.client.shell(ptyOptions, onStream);
        }
      });

      const connectConfig: Parameters<Client['connect']>[0] = {
        host: config.host,
        port: config.port ?? 22,
        username: config.username,
        readyTimeout: 30_000,
        keepaliveInterval: 10_000,
        tryKeyboard: false,
      };

      if (config.privateKey) {
        connectConfig.privateKey = config.privateKey;
      }
      if (config.password) {
        connectConfig.password = config.password;
      }

      this.client.connect(connectConfig);
    });
  }

  write(data: string): void {
    this.stream?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.stream?.setWindow(rows, cols, 0, 0);
  }

  disconnect(): void {
    this.closed = true;
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
    this.stream = null;
    this.client.end();
  }
}
