import type { MarketplaceTemplate } from '../types';

export const codeServer: MarketplaceTemplate = {
  id: 'code-server',
  name: 'code-server',
  description: 'VS Code in your browser — full IDE accessible from anywhere',
  longDescription: `code-server is VS Code running on a remote server, accessible through the browser.

- **Full VS Code** experience — extensions, themes, settings sync
- **Code from anywhere** — iPad, Chromebook, low-power devices
- **Consistent dev environment** across machines
- **Long-running tasks** keep running when you close the browser
- **Test your apps** in the same network as your servers
- 70K+ stars on GitHub
- Made by **Coder** (the people behind VS Code's remote extension protocol)`,
  icon: 'Terminal',
  category: 'devtools',
  tags: ['ide', 'vscode', 'editor', 'remote-development'],
  website: 'https://github.com/coder/code-server',
  documentation: 'https://coder.com/docs/code-server',

  deploymentType: 'single-container',
  dockerImage: 'codercom/code-server:latest',
  port: 8080,
  healthCheckPath: '/healthz',
  envVars: [
    {
      key: 'PASSWORD',
      label: 'Login Password',
      description: 'Password for accessing your code-server instance',
      required: true,
      type: 'password',
      generate: 'password',
    },
    {
      key: 'SUDO_PASSWORD',
      label: 'Sudo Password',
      description: 'Password for sudo commands inside the editor terminal',
      required: false,
      type: 'password',
      generate: 'password',
      hidden: true,
    },
    {
      key: 'DOCKER_USER',
      label: 'User',
      description: 'User to run code-server as',
      required: false,
      type: 'text',
      default: 'coder',
      hidden: true,
    },
  ],
  minMemoryMb: 1024,
  minDiskGb: 5,
  version: '1.0.0',
  appVersion: 'latest',
  featured: true,
  volumes: ['/home/coder'],
};
