import argon2 from 'argon2';

// Argon2id settings (OWASP recommended)
const hashOptions: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3, // 3 iterations
  parallelism: 4, // 4 parallel threads
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, hashOptions);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
