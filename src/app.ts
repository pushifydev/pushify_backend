import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';

import { registerMiddleware } from './middleware';
import { registerRoutes } from './routes';
import { openApiConfig, registerSecuritySchemes } from './config/openapi';
import type { AppEnv } from './types';

// Re-export types for convenience
export type { AppEnv, AppContext } from './types';

// Create app
const app = new OpenAPIHono<AppEnv>();

// Setup
registerMiddleware(app);
registerRoutes(app);
registerSecuritySchemes(app);

// OpenAPI documentation
app.doc('/api/v1/doc', openApiConfig);

// Swagger UI
app.get('/api/docs', swaggerUI({ url: '/api/v1/doc' }));

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found',
      },
    },
    404
  );
});

export { app };
