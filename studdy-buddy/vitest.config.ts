import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const r = (p: string) => resolve(__dirname, p);

export default defineConfig({
  resolve: {
    alias: {
      '@studdy/shared': r('packages/shared/src/index.ts'),
      '@studdy/database': r('packages/database/src/index.ts'),
      '@studdy/ai-router': r('packages/ai-router/src/index.ts'),
      '@studdy/agent-core': r('packages/agent-core/src/index.ts'),
      '@studdy/learning-engine': r('packages/learning-engine/src/index.ts'),
      '@studdy/quiz-engine': r('packages/quiz-engine/src/index.ts'),
      '@studdy/curriculum': r('packages/curriculum/src/index.ts'),
      '@studdy/packet-tracer': r('packages/packet-tracer/src/index.ts'),
      '@studdy/voice-engine': r('packages/voice-engine/src/index.ts'),
      '@studdy/mascot': r('packages/mascot/src/index.ts'),
      '@studdy/screen-overlay': r('packages/screen-overlay/src/index.ts'),
      '@studdy/chat-ui': r('packages/chat-ui/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    reporters: ['default'],
  },
});
