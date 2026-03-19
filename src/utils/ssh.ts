import { Client, type ConnectConfig, type ExecOptions } from 'ssh2';
import { generateKeyPairSync } from 'crypto';

export interface SSHConnectionConfig {
  host: string;
  port?: number;
  username: string;
  privateKey: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class SSHClient {
  private client: Client;
  private connected: boolean = false;
  private config: SSHConnectionConfig | null = null;

  constructor() {
    this.client = new Client();
  }

  /**
   * Connect to a remote server via SSH
   */
  async connect(config: SSHConnectionConfig): Promise<void> {
    if (this.connected) {
      return;
    }

    this.config = config;

    return new Promise((resolve, reject) => {
      const connectConfig: ConnectConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        privateKey: config.privateKey,
        readyTimeout: 30000, // 30 second timeout
        keepaliveInterval: 10000, // Send keepalive every 10 seconds
      };

      this.client.on('ready', () => {
        this.connected = true;
        resolve();
      });

      this.client.on('error', (err) => {
        this.connected = false;
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      this.client.on('close', () => {
        this.connected = false;
      });

      this.client.connect(connectConfig);
    });
  }

  /**
   * Execute a command on the remote server
   */
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.connected) {
      throw new Error('SSH client is not connected');
    }

    return new Promise((resolve, reject) => {
      this.client.exec(command, options || {}, (err, stream) => {
        if (err) {
          reject(new Error(`SSH exec error: ${err.message}`));
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code: number) => {
          resolve({ stdout, stderr, code: code || 0 });
        });

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('error', (err: Error) => {
          reject(new Error(`SSH stream error: ${err.message}`));
        });
      });
    });
  }

  /**
   * Execute a command with streaming output
   */
  async execStream(
    command: string,
    onStdout?: (data: string) => void,
    onStderr?: (data: string) => void
  ): Promise<number> {
    if (!this.connected) {
      throw new Error('SSH client is not connected');
    }

    return new Promise((resolve, reject) => {
      this.client.exec(command, {}, (err, stream) => {
        if (err) {
          reject(new Error(`SSH exec error: ${err.message}`));
          return;
        }

        stream.on('close', (code: number) => {
          resolve(code || 0);
        });

        stream.on('data', (data: Buffer) => {
          onStdout?.(data.toString());
        });

        stream.stderr.on('data', (data: Buffer) => {
          onStderr?.(data.toString());
        });

        stream.on('error', (err: Error) => {
          reject(new Error(`SSH stream error: ${err.message}`));
        });
      });
    });
  }

  /**
   * Upload a file to the remote server using SFTP
   */
  async uploadFile(localContent: string | Buffer, remotePath: string): Promise<void> {
    if (!this.connected) {
      throw new Error('SSH client is not connected');
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP error: ${err.message}`));
          return;
        }

        const writeStream = sftp.createWriteStream(remotePath);

        writeStream.on('close', () => {
          resolve();
        });

        writeStream.on('error', (err: Error) => {
          reject(new Error(`SFTP write error: ${err.message}`));
        });

        const content = typeof localContent === 'string' ? Buffer.from(localContent) : localContent;
        writeStream.end(content);
      });
    });
  }

  /**
   * Download a file from the remote server
   */
  async downloadFile(remotePath: string): Promise<Buffer> {
    if (!this.connected) {
      throw new Error('SSH client is not connected');
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP error: ${err.message}`));
          return;
        }

        const chunks: Buffer[] = [];
        const readStream = sftp.createReadStream(remotePath);

        readStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        readStream.on('close', () => {
          resolve(Buffer.concat(chunks));
        });

        readStream.on('error', (err: Error) => {
          reject(new Error(`SFTP read error: ${err.message}`));
        });
      });
    });
  }

  /**
   * Check if a file exists on the remote server
   */
  async fileExists(remotePath: string): Promise<boolean> {
    try {
      const result = await this.exec(`test -e "${remotePath}" && echo "exists" || echo "not_exists"`);
      return result.stdout.trim() === 'exists';
    } catch {
      return false;
    }
  }

  /**
   * Create a directory on the remote server (with parents)
   */
  async mkdir(remotePath: string): Promise<void> {
    await this.exec(`mkdir -p "${remotePath}"`);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get connection info
   */
  getConnectionInfo(): { host: string; port: number } | null {
    if (!this.config) return null;
    return { host: this.config.host, port: this.config.port || 22 };
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.connected) {
      this.client.end();
      this.connected = false;
    }
  }
}

// Connection pool for reusing SSH connections
const MAX_POOL_SIZE = 20;
const CONNECTION_TTL = 5 * 60 * 1000; // 5 minutes

interface PoolEntry {
  client: SSHClient;
  lastUsedAt: number;
}

const connectionPool = new Map<string, PoolEntry>();

// Cleanup stale connections every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of connectionPool.entries()) {
    if (now - entry.lastUsedAt > CONNECTION_TTL) {
      entry.client.disconnect();
      connectionPool.delete(key);
    }
  }
}, 60 * 1000);

/**
 * Get or create an SSH connection from the pool
 */
export async function getSSHConnection(config: SSHConnectionConfig): Promise<SSHClient> {
  const key = `${config.username}@${config.host}:${config.port || 22}`;

  // Check if we have an existing connected client
  const existing = connectionPool.get(key);
  if (existing && existing.client.isConnected()) {
    existing.lastUsedAt = Date.now();
    return existing.client;
  }

  // Evict oldest entry if pool is full
  if (connectionPool.size >= MAX_POOL_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, entry] of connectionPool.entries()) {
      if (entry.lastUsedAt < oldestTime) {
        oldestTime = entry.lastUsedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      const evicted = connectionPool.get(oldestKey);
      evicted?.client.disconnect();
      connectionPool.delete(oldestKey);
    }
  }

  // Create new client
  const client = new SSHClient();
  await client.connect(config);

  // Store in pool
  connectionPool.set(key, { client, lastUsedAt: Date.now() });

  return client;
}

/**
 * Close all connections in the pool
 */
export function closeAllSSHConnections(): void {
  for (const entry of connectionPool.values()) {
    entry.client.disconnect();
  }
  connectionPool.clear();
}

/**
 * Remove a specific connection from the pool
 */
export function removeSSHConnection(host: string, port: number = 22, username: string): void {
  const key = `${username}@${host}:${port}`;
  const entry = connectionPool.get(key);
  if (entry) {
    entry.client.disconnect();
    connectionPool.delete(key);
  }
}

export interface SSHKeyPair {
  privateKey: string;
  publicKey: string;
}

/**
 * Generate an SSH key pair (RSA 4096-bit)
 */
export function generateSSHKeyPair(comment: string = 'pushify@deployment'): SSHKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs1',  // Use pkcs1 for ssh2 compatibility (RSA PRIVATE KEY format)
      format: 'pem',
    },
  });

  // Convert public key from PEM (SPKI) to OpenSSH format
  const publicKeyOpenSSH = convertPEMToOpenSSH(publicKey, comment);

  return {
    privateKey,
    publicKey: publicKeyOpenSSH,
  };
}

/**
 * Convert PEM public key to OpenSSH format
 */
function convertPEMToOpenSSH(pemKey: string, comment: string): string {
  // Remove PEM headers and concatenate base64
  const base64 = pemKey
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\n/g, '')
    .trim();

  // Decode base64 to get DER format
  const der = Buffer.from(base64, 'base64');

  // Parse SPKI structure to extract RSA public key
  // SPKI format: SEQUENCE { AlgorithmIdentifier, BIT STRING (public key) }
  // For RSA, the public key is: SEQUENCE { INTEGER (n), INTEGER (e) }

  // Skip SPKI header (algorithm identifier) and get to the BIT STRING
  // The structure is: 30 xx 30 0d 06 09 ... [algorithm OID] ... 03 yy 00 [public key]
  // We need to find the nested SEQUENCE containing n and e

  let offset = 0;

  // Read outer SEQUENCE
  if (der[offset++] !== 0x30) throw new Error('Invalid PEM: expected SEQUENCE');
  offset += readASN1Length(der, offset).bytesRead;

  // Read AlgorithmIdentifier SEQUENCE
  if (der[offset++] !== 0x30) throw new Error('Invalid PEM: expected AlgorithmIdentifier SEQUENCE');
  const algLen = readASN1Length(der, offset);
  offset += algLen.bytesRead + algLen.length;

  // Read BIT STRING
  if (der[offset++] !== 0x03) throw new Error('Invalid PEM: expected BIT STRING');
  const bitStringLen = readASN1Length(der, offset);
  offset += bitStringLen.bytesRead;

  // Skip unused bits byte
  offset += 1;

  // Now we're at the RSA public key SEQUENCE
  if (der[offset++] !== 0x30) throw new Error('Invalid PEM: expected RSA key SEQUENCE');
  offset += readASN1Length(der, offset).bytesRead;

  // Read INTEGER (n - modulus)
  if (der[offset++] !== 0x02) throw new Error('Invalid PEM: expected INTEGER for modulus');
  const nLen = readASN1Length(der, offset);
  offset += nLen.bytesRead;
  let n = der.subarray(offset, offset + nLen.length);
  offset += nLen.length;

  // Read INTEGER (e - exponent)
  if (der[offset++] !== 0x02) throw new Error('Invalid PEM: expected INTEGER for exponent');
  const eLen = readASN1Length(der, offset);
  offset += eLen.bytesRead;
  let e = der.subarray(offset, offset + eLen.length);

  // Remove leading zeros from n and e (ASN.1 integers can have leading zeros for sign)
  while (n.length > 1 && n[0] === 0 && (n[1] & 0x80) === 0) {
    n = n.subarray(1);
  }
  while (e.length > 1 && e[0] === 0 && (e[1] & 0x80) === 0) {
    e = e.subarray(1);
  }

  // Build OpenSSH format
  // Format: "ssh-rsa" + length-prefixed e + length-prefixed n
  const keyType = Buffer.from('ssh-rsa');

  const buffer = Buffer.concat([
    writeSSHString(keyType),
    writeSSHString(e),
    writeSSHString(n),
  ]);

  return `ssh-rsa ${buffer.toString('base64')} ${comment}`;
}

function readASN1Length(buffer: Buffer, offset: number): { length: number; bytesRead: number } {
  const firstByte = buffer[offset];
  if ((firstByte & 0x80) === 0) {
    return { length: firstByte, bytesRead: 1 };
  }
  const numBytes = firstByte & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = (length << 8) | buffer[offset + 1 + i];
  }
  return { length, bytesRead: 1 + numBytes };
}

function writeSSHString(data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, data]);
}
