/**
 * MAJIN — vision.
 * Bild in, textual analys ut. Endast en fil-läsning + en chat-anrop med image_url,
 * så det fungerar mot alla OpenAI-kompatibla modeller som kan bilder.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { complete } from './provider/chat.js';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

export async function analyzeImage({ cfg, imagePath, question = 'What is in the image?', maxBytes = 8 * 1024 * 1024 }) {
  const st = await fs.stat(imagePath);
  if (st.size > maxBytes) throw new Error(`the image is ${Math.round(st.size / 1e6)} MB — max ${Math.round(maxBytes / 1e6)} MB`);
  const buf = await fs.readFile(imagePath);
  const mime = MIME[path.extname(imagePath).toLowerCase()] || 'application/octet-stream';
  const route = cfg.resolveModel(cfg.get('models.routes.vision'), 'vision');
  const res = await complete({
    route,
    job: 'vision',
    stream: false,
    maxTokens: 1400,
    temperature: 0.1,
    messages: [
      { role: 'system', content: 'You describe images factually and concretely. Never guess beyond what the pixels support. Answer in the language the user used.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
        ],
      },
    ],
  });
  return res.text || '(empty answer)';
}
