import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { aiService, type ChatMessage } from '../services/ai.service';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

const aiRouter = new Hono<AppEnv>();

// All routes require authentication
aiRouter.use('*', authMiddleware);

// Check if AI is available
aiRouter.get('/status', (c) => {
  return c.json({ data: { available: aiService.isAvailable() } });
});

// Stream chat response via SSE
aiRouter.post('/chat', async (c) => {
  if (!aiService.isAvailable()) {
    return c.json({ error: { message: 'AI assistant is not configured' } }, 503);
  }

  const body = await c.req.json<{
    messages: ChatMessage[];
    context?: string;
  }>();

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: { message: 'Messages array is required' } }, 400);
  }

  // Validate message format
  for (const msg of body.messages) {
    if (!msg.role || !msg.content || !['user', 'assistant'].includes(msg.role)) {
      return c.json({ error: { message: 'Invalid message format' } }, 400);
    }
  }

  return streamSSE(c, async (stream) => {
    try {
      for await (const text of aiService.streamChat(body.messages, body.context)) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'text', content: text }) });
      }
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
    } catch (error: any) {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', content: error.message || 'An error occurred' }),
      });
    }
  });
});

export { aiRouter as aiRoutes };
