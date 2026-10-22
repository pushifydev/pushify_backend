import { describe, it, expect } from 'vitest';
import { parseServerAddress, sshConnectHost, buildSshConnectCommand } from './server-address';

describe('parseServerAddress', () => {
  it('accepts an IPv4 address', () => {
    expect(parseServerAddress('203.0.113.7')).toEqual({ address: '203.0.113.7', family: 4 });
    expect(parseServerAddress('  203.0.113.7 ')).toEqual({ address: '203.0.113.7', family: 4 });
  });

  it('accepts an IPv6 address, bare or in brackets, lowercased', () => {
    expect(parseServerAddress('2001:db8::1')).toEqual({ address: '2001:db8::1', family: 6 });
    expect(parseServerAddress('[2001:db8::1]')).toEqual({ address: '2001:db8::1', family: 6 });
    expect(parseServerAddress(' [2A01:4F8:C0C:1234::1] ')).toEqual({ address: '2a01:4f8:c0c:1234::1', family: 6 });
    expect(parseServerAddress('::ffff:203.0.113.7')).toEqual({ address: '::ffff:203.0.113.7', family: 6 });
  });

  it('fits the varchar(45) column at the longest IPv6 form', () => {
    const longest = '0000:0000:0000:0000:0000:ffff:255.255.255.255';
    expect(parseServerAddress(`[${longest}]`)?.address).toBe(longest);
  });

  it('rejects what is not an IP literal', () => {
    for (const value of [
      '',
      '   ',
      'server.example.com',
      '203.0.113',
      '203.0.113.256',
      '[203.0.113.7]',
      '2001:db8::1/64',
      '2001:db8:::1',
      '[2001:db8::1',
      'fe80::1%eth0',
      '[fe80::1%eth0]',
      '203.0.113.7:22',
      '[2001:db8::1]:22',
      undefined,
      null,
      42,
    ]) {
      expect(parseServerAddress(value), String(value)).toBeNull();
    }
  });
});

describe('sshConnectHost', () => {
  it('drops the brackets around an IPv6 literal', () => {
    expect(sshConnectHost('[2001:db8::1]')).toBe('2001:db8::1');
  });

  it('leaves IPv4, bare IPv6 and hostnames unchanged', () => {
    expect(sshConnectHost('203.0.113.7')).toBe('203.0.113.7');
    expect(sshConnectHost('2001:db8::1')).toBe('2001:db8::1');
    expect(sshConnectHost('127.0.0.1')).toBe('127.0.0.1');
    expect(sshConnectHost('[not-an-ip]')).toBe('[not-an-ip]');
  });
});

describe('buildSshConnectCommand', () => {
  it('builds the IPv4 command exactly as before', () => {
    expect(buildSshConnectCommand({ keyFile: 'pushify_web.pem', host: '203.0.113.7' })).toBe(
      'ssh -i pushify_web.pem root@203.0.113.7'
    );
  });

  it('puts an IPv6 address in bare, since OpenSSH reads `user@[…]` as a hostname', () => {
    expect(buildSshConnectCommand({ keyFile: 'pushify_web.pem', host: '2001:db8::1' })).toBe(
      'ssh -i pushify_web.pem root@2001:db8::1'
    );
    expect(buildSshConnectCommand({ keyFile: 'pushify_web.pem', host: '[2001:db8::1]' })).toBe(
      'ssh -i pushify_web.pem root@2001:db8::1'
    );
  });

  it('passes a non-default port and user with flags, for both families', () => {
    expect(buildSshConnectCommand({ keyFile: 'k.pem', host: '203.0.113.7', username: 'deploy', port: 2222 })).toBe(
      'ssh -i k.pem -p 2222 deploy@203.0.113.7'
    );
    expect(buildSshConnectCommand({ keyFile: 'k.pem', host: '2001:db8::1', port: 2222 })).toBe(
      'ssh -i k.pem -p 2222 root@2001:db8::1'
    );
  });
});
