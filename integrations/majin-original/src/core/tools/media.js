/**
 * Media tools using OpenAI-compatible image/audio endpoints. They use the user's
 * configured provider key, save files locally, and are marked exec-risk because
 * remote generation can incur cost.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { def } from './registry.js';
import { resolveIn } from './files.js';

const IMAGE_LIMIT = 24 * 1024 * 1024;
const AUDIO_LIMIT = 64 * 1024 * 1024;

function endpointFor(route, suffix) {
  if (route.kind === 'anthropic' || route.kind === 'mock') throw new Error(`${route.providerName || route.kind} does not expose OpenAI-compatible media endpoints`);
  const base = String(route.baseUrl || '').replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/i, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('provider baseUrl must be HTTP(S)');
  const versioned = /\/v\d+(?:\/|$)/i.test(new URL(base).pathname) ? base : `${base}/v1`;
  return `${versioned}${suffix}`;
}

async function postJson(route, url, body) {
  if (!route.apiKey) throw new Error(`no API key for ${route.providerName || 'the selected provider'}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${route.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const error = await response.text().catch(() => '');
    throw new Error(`${route.providerName || 'provider'} returned HTTP ${response.status}: ${error.slice(0, 350)}`);
  }
  return response;
}

function privateIp(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const ip = address.toLowerCase();
  if (ip.startsWith('::ffff:')) return privateIp(ip.slice('::ffff:'.length));
  return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
}

async function fetchPublicImage(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('provider returned an unsafe image URL; expected public HTTPS');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('provider returned a local image URL; refusing to fetch it');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => privateIp(address))) throw new Error('provider image URL did not resolve to a public address');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`could not download generated image (HTTP ${response.status})`);
  const contentType = response.headers.get('content-type') || '';
  if (!/^image\/(png|jpeg|webp)$/i.test(contentType)) throw new Error(`provider returned non-image content (${contentType || 'unknown type'})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > IMAGE_LIMIT) throw new Error(`generated image size is invalid (${bytes.length} bytes)`);
  return { bytes, contentType };
}

function extFor(mime) {
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' })[String(mime).split(';')[0].toLowerCase()] || '.png';
}

export const mediaTools = [
  def({
    name: 'media.generate_image',
    group: 'media',
    risk: 'exec',
    desc: 'Generate one image using an OpenAI-compatible provider and save it in the workspace. Requires a configured provider/model that supports /images/generations; remote generation may cost money.',
    params: {
      model: 'string: provider/model, e.g. openai/gpt-image-1',
      prompt: 'string: detailed image description',
      path: 'string?: output filename/path (default generated-images/image-<time>.png)',
      size: 'string?: (optional) image size, e.g. 1024x1024',
      quality: 'string?: (optional) low | medium | high [low|medium|high]',
    },
    required: ['model', 'prompt'],
    async run({ model, prompt, path: outputPath = '', size = '1024x1024', quality = 'medium' }, ctx) {
      const route = ctx.cfg.resolveModel(String(model), 'vision');
      const url = endpointFor(route, '/images/generations');
      const body = { model: route.model, prompt: String(prompt).slice(0, 8000), size: String(size), n: 1 };
      if (/^dall-e-/i.test(route.model)) body.response_format = 'b64_json';
      if (quality && !/^dall-e-/i.test(route.model)) body.quality = quality;
      const response = await postJson(route, url, body);
      const declared = Number(response.headers.get('content-length')) || 0;
      if (declared > IMAGE_LIMIT * 2) throw new Error(`image response is too large (${declared} bytes)`);
      if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('image provider returned a non-JSON response');
      const payload = await response.json();
      const item = payload.data?.[0];
      if (!item) throw new Error('provider response did not contain a generated image');
      let bytes;
      let mime = item.content_type || 'image/png';
      if (item.b64_json) {
        bytes = Buffer.from(item.b64_json, 'base64');
        if (!bytes.length || bytes.length > IMAGE_LIMIT) throw new Error(`generated image size is invalid (${bytes.length} bytes)`);
      } else if (item.url) {
        ({ bytes, contentType: mime } = await fetchPublicImage(item.url));
      } else {
        throw new Error('provider returned neither b64_json nor a downloadable image URL');
      }
      const given = outputPath || `generated-images/image-${Date.now()}${extFor(mime)}`;
      const resolved = resolveIn(ctx, given);
      const finalPath = path.extname(resolved.abs) ? resolved.abs : `${resolved.abs}${extFor(mime)}`;
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.writeFile(finalPath, bytes, { flag: 'wx' });
      ctx.emit?.({ type: 'media:image-generated', model: route.ref, path: finalPath, bytes: bytes.length });
      return { result: `Generated image saved: ${finalPath} (${bytes.length} bytes, ${mime})`, meta: { path: finalPath, bytes: bytes.length, mime, model: route.ref }, summary: `generated image ${path.basename(finalPath)}` };
    },
  }),

  def({
    name: 'media.speak',
    group: 'media',
    risk: 'exec',
    desc: 'Synthesize spoken audio from text with an OpenAI-compatible /audio/speech provider and save it locally. Requires a configured speech model; remote generation may cost money.',
    params: {
      model: 'string: provider/model, e.g. openai/tts-1',
      text: 'string: words to speak (maximum 4000 characters)',
      path: 'string?: output audio file path (default generated-audio/speech-<time>.mp3)',
      voice: 'string?: (optional) voice name, e.g. alloy | echo | fable | onyx | nova | shimmer',
      format: 'string?: (optional) mp3 | opus | aac | flac | wav [mp3|opus|aac|flac|wav]',
      instructions: 'string?: optional voice style instructions where the model supports them',
    },
    required: ['model', 'text'],
    async run({ model, text, path: outputPath = '', voice = 'alloy', format = 'mp3', instructions = '' }, ctx) {
      const input = String(text);
      if (!input.trim() || input.length > 4000) throw new Error('text must contain 1–4000 characters');
      const route = ctx.cfg.resolveModel(String(model), 'vision');
      const url = endpointFor(route, '/audio/speech');
      const body = { model: route.model, input, voice: String(voice), response_format: format };
      if (instructions) body.instructions = String(instructions).slice(0, 1000);
      const response = await postJson(route, url, body);
      const audioType = response.headers.get('content-type') || '';
      if (!/^audio\//i.test(audioType) && !/application\/octet-stream/i.test(audioType)) throw new Error(`speech provider returned non-audio content (${audioType || 'unknown type'})`);
      const declared = Number(response.headers.get('content-length')) || 0;
      if (declared > AUDIO_LIMIT) throw new Error(`generated audio is too large (${declared} bytes)`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > AUDIO_LIMIT) throw new Error(`generated audio size is invalid (${bytes.length} bytes)`);
      const ext = `.${format}`;
      const given = outputPath || `generated-audio/speech-${Date.now()}${ext}`;
      const resolved = resolveIn(ctx, given);
      const finalPath = path.extname(resolved.abs) ? resolved.abs : `${resolved.abs}${ext}`;
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.writeFile(finalPath, bytes, { flag: 'wx' });
      ctx.emit?.({ type: 'media:speech-generated', model: route.ref, path: finalPath, bytes: bytes.length, chars: input.length });
      return { result: `Speech audio saved: ${finalPath} (${bytes.length} bytes, ${format})`, meta: { path: finalPath, bytes: bytes.length, format, model: route.ref }, summary: `generated speech ${path.basename(finalPath)}` };
    },
  }),
];

export { endpointFor, fetchPublicImage };
