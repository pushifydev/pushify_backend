import { describe, it, expect } from 'vitest';
import {
  validateVolumeName,
  validateContainerPath,
  buildVolumeMount,
  volumeDockerName,
} from './volume-validate';

describe('validateVolumeName', () => {
  it('accepts simple lowercase names', () => {
    expect(validateVolumeName('data')).toBeNull();
    expect(validateVolumeName('uploads-2')).toBeNull();
    expect(validateVolumeName('a')).toBeNull();
  });

  it('rejects uppercase, spaces, and shell metacharacters', () => {
    expect(validateVolumeName('Data')).not.toBeNull();
    expect(validateVolumeName('my data')).not.toBeNull();
    expect(validateVolumeName('x;rm -rf /')).not.toBeNull();
    expect(validateVolumeName('$(whoami)')).not.toBeNull();
    expect(validateVolumeName('')).not.toBeNull();
  });

  it('rejects names over 31 chars', () => {
    expect(validateVolumeName('a'.repeat(32))).not.toBeNull();
    expect(validateVolumeName('a'.repeat(31))).toBeNull();
  });
});

describe('validateContainerPath', () => {
  it('accepts normal app data paths', () => {
    expect(validateContainerPath('/app/data')).toBeNull();
    expect(validateContainerPath('/var/lib/sqlite')).toBeNull();
    expect(validateContainerPath('/uploads')).toBeNull();
  });

  it('rejects relative paths and traversal', () => {
    expect(validateContainerPath('data')).not.toBeNull();
    expect(validateContainerPath('/app/../etc')).not.toBeNull();
  });

  it('rejects system mount targets', () => {
    expect(validateContainerPath('/')).not.toBeNull();
    expect(validateContainerPath('/etc')).not.toBeNull();
    expect(validateContainerPath('/proc/self')).not.toBeNull();
    expect(validateContainerPath('/dev/shm')).not.toBeNull();
    expect(validateContainerPath('/sys')).not.toBeNull();
  });

  it('rejects shell metacharacters and whitespace', () => {
    expect(validateContainerPath('/app/da ta')).not.toBeNull();
    expect(validateContainerPath("/app/'; rm -rf /")).not.toBeNull();
    expect(validateContainerPath('/app/$(x)')).not.toBeNull();
  });
});

describe('mount string builders', () => {
  it('builds prefixed docker volume names and mount strings', () => {
    expect(volumeDockerName('yeli-web', 'data')).toBe('pushify-vol-yeli-web-data');
    expect(buildVolumeMount('yeli-web', 'data', '/app/data')).toBe(
      'pushify-vol-yeli-web-data:/app/data'
    );
  });
});
