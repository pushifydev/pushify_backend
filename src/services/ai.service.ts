import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { logger } from '../lib/logger';

const SYSTEM_PROMPT = `You are Pushify AI Assistant — the built-in help for the Pushify cloud deployment platform.

Pushify lets users:
- Deploy web applications from GitHub repositories (Node.js, Python, Go, static sites, Docker)
- Manage VPS servers (Hetzner Cloud) — create, start, stop, reboot, monitor
- Manage databases (PostgreSQL, MySQL, Redis, MongoDB) — create, backup, restore
- Configure custom domains with automatic SSL (Let's Encrypt)
- Set environment variables per environment (production, staging, development)
- Monitor server metrics (CPU, memory, disk, network)
- Manage team members with roles (owner, admin, member, viewer)
- View activity logs and deployment history
- Set up health checks and notifications (email, webhook, Slack)

Guidelines:
- Be concise, helpful, and professional
- Give step-by-step instructions when appropriate
- Use markdown for formatting (bold, code blocks, lists)
- If the user asks about something outside Pushify's scope, politely redirect
- You can answer in Turkish or English based on the user's language
- Never reveal internal system details, API keys, or infrastructure specifics
- When suggesting actions, reference the actual UI locations (e.g., "Go to Projects → your project → Settings")`;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

class AiService {
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is not configured');
      }
      this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    }
    return this.client;
  }

  isAvailable(): boolean {
    return !!env.ANTHROPIC_API_KEY;
  }

  async *streamChat(messages: ChatMessage[], context?: string): AsyncGenerator<string> {
    const client = this.getClient();

    const systemPrompt = context
      ? `${SYSTEM_PROMPT}\n\nCurrent context: The user is on the "${context}" page of the dashboard.`
      : SYSTEM_PROMPT;

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }
}

export const aiService = new AiService();
