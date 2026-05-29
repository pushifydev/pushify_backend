const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

const HEARTBEAT_MS = 20_000;

export type ContainerLogStreamFn = (
  onLog: (line: string) => void,
  signal: AbortSignal
) => Promise<void>;

export function createContainerLogSseResponse(options: {
  containerName: string;
  remote?: boolean;
  stream: ContainerLogStreamFn;
  clientSignal?: AbortSignal;
}): Response {
  const { containerName, remote, stream, clientSignal } = options;

  let streamAbort: AbortController | null = null;

  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const abort = new AbortController();
        streamAbort = abort;

        const linkAbort = () => abort.abort();
        clientSignal?.addEventListener('abort', linkAbort, { once: true });

        const enqueue = (payload: Record<string, unknown>) => {
          if (abort.signal.aborted) return;
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
            );
          } catch {
            abort.abort();
          }
        };

        enqueue({
          type: 'connected',
          containerName,
          live: true,
          ...(remote ? { remote: true } : {}),
        });

        const heartbeat = setInterval(() => {
          enqueue({ type: 'ping' });
        }, HEARTBEAT_MS);

        try {
          await stream((line) => {
            enqueue({ type: 'log', message: line });
          }, abort.signal);
        } catch (error) {
          if (!abort.signal.aborted) {
            enqueue({
              type: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          clearInterval(heartbeat);
          clientSignal?.removeEventListener('abort', linkAbort);
          if (!abort.signal.aborted) {
            enqueue({ type: 'end', message: 'Log stream ended' });
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        streamAbort?.abort();
      },
    }),
    { headers: SSE_HEADERS }
  );
}
