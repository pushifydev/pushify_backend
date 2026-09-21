import { describe, it, expect } from 'vitest';
import { classifyDeployFailure } from './deploy-failure-classify';

describe('classifyDeployFailure — repository access', () => {
  it.each([
    "Failed to clone repository: Cloning into '/tmp/pushify-x/repo'...\nfatal: could not read Username for 'https://github.com': No such device or address",
    'Pushify has no access to github.com/acme/site. Connect the GitHub account that can see it',
    "remote: Repository not found.\nfatal: repository 'https://github.com/acme/site/' not found",
    "fatal: Authentication failed for 'https://github.com/acme/site/'",
  ])('recognises %j', (message) => {
    const result = classifyDeployFailure('', message);
    expect(result.category).toBe('repository_access');
    expect(result.blame).toBe('project');
  });

  it('wins over categories whose keywords a clone log can contain', () => {
    // "killed" would otherwise read as out-of-memory
    const result = classifyDeployFailure('process killed', 'fatal: could not read Username');
    expect(result.category).toBe('repository_access');
  });
});
