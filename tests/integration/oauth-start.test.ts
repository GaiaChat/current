import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

describe('oauth start route', () => {
  it('requires a handle', async () => {
    const { app, close } = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/start',
    });

    expect(response.statusCode).toBe(400);

    await close();
  });
});
