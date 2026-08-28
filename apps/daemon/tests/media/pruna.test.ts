import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateMedia } from '../../src/media/index.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');
const MP4_BYTES = Buffer.from('000000186674797069736f6d0000020069736f6d', 'hex');

type Call = { url: string; init: RequestInit | undefined };

describe('pruna media generation', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  const realFetch = globalThis.fetch;
  const originalMediaConfigDir = process.env.OD_MEDIA_CONFIG_DIR;
  const originalDataDir = process.env.OD_DATA_DIR;
  // PRUNA_API_KEY is the canonical upstream env name, so a developer running
  // the suite on a machine that exports it for the Pruna SDK would otherwise
  // satisfy the no-credential case from the ambient environment.
  const originalPrunaKey = process.env.PRUNA_API_KEY;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-pruna-'));
    projectRoot = path.join(root, 'project-root');
    projectsRoot = path.join(projectRoot, '.od', 'projects');
    await mkdir(path.join(projectsRoot, 'project-1'), { recursive: true });
    delete process.env.OD_MEDIA_CONFIG_DIR;
    delete process.env.OD_DATA_DIR;
    delete process.env.OD_MEDIA_MODEL_ALIASES;
    delete process.env.PRUNA_API_KEY;
    process.env.OD_PRUNA_API_KEY = 'pruna-test-key';
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    delete process.env.OD_PRUNA_API_KEY;
    delete process.env.OD_MEDIA_MODEL_ALIASES;
    if (originalPrunaKey == null) {
      delete process.env.PRUNA_API_KEY;
    } else {
      process.env.PRUNA_API_KEY = originalPrunaKey;
    }
    if (originalMediaConfigDir == null) {
      delete process.env.OD_MEDIA_CONFIG_DIR;
    } else {
      process.env.OD_MEDIA_CONFIG_DIR = originalMediaConfigDir;
    }
    if (originalDataDir == null) {
      delete process.env.OD_DATA_DIR;
    } else {
      process.env.OD_DATA_DIR = originalDataDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * Stub the Pruna surface: POST /files, POST /predictions,
   * GET /predictions/status/:id, and the authenticated delivery URL.
   * `pollStatuses` drives how many in-flight polls precede success.
   */
  function stubPruna(options: {
    calls: Call[];
    deliveryUrl: string;
    outputBytes: Buffer;
    pollStatuses?: string[];
    submitBody?: Record<string, unknown>;
    uploadUrl?: string;
  }) {
    const remaining = [...(options.pollStatuses ?? [])];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      options.calls.push({ url, init });
      if (url.endsWith('/files')) {
        return jsonResponse({
          id: 'file-abc123',
          urls: { get: options.uploadUrl ?? 'https://api.pruna.ai/v1/files/file-abc123' },
        });
      }
      if (url.endsWith('/predictions')) {
        return jsonResponse(options.submitBody ?? {
          id: '1zww7deyssrme0csqwr90phzzr',
          model: 'p-image',
          get_url: 'https://api.pruna.ai/v1/predictions/status/1zww7deyssrme0csqwr90phzzr',
        });
      }
      if (url.includes('/predictions/status/')) {
        const next = remaining.shift();
        if (next) return jsonResponse({ status: next, message: 'Generation in progress' });
        return jsonResponse({ status: 'succeeded', generation_url: options.deliveryUrl });
      }
      return new Response(options.outputBytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('submits the model in the Model header and the key in apikey, then polls', async () => {
    const calls: Call[] = [];
    stubPruna({
      calls,
      deliveryUrl: 'https://api.pruna.ai/v1/predictions/delivery/xezq/abc/output.jpg',
      outputBytes: PNG_BYTES,
      pollStatuses: ['starting', 'processing'],
    });

    const result = await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'p-image',
      prompt: 'A majestic lion on a rocky cliff at sunset',
      aspect: '16:9',
      output: 'lion.png',
    });

    expect(result.providerId).toBe('pruna');
    expect(result.providerNote).toContain('pruna/p-image');
    expect(result.providerNote).toContain('16:9');

    const submit = calls.find((c) => c.url.endsWith('/predictions'));
    expect(submit?.url).toBe('https://api.pruna.ai/v1/predictions');
    expect(submit?.init?.method).toBe('POST');
    // The model travels in a header, not the body, and the credential is a
    // bare apikey header rather than a Bearer token.
    expect(submit?.init?.headers).toMatchObject({
      apikey: 'pruna-test-key',
      'content-type': 'application/json',
      Model: 'p-image',
    });
    expect(submit?.init?.headers).not.toHaveProperty('authorization');
    // Sync mode is never requested: the docs cap it at 60s and warn about 504s.
    expect(submit?.init?.headers).not.toHaveProperty('Try-Sync');
    expect(JSON.parse(String(submit?.init?.body))).toEqual({
      input: {
        prompt: 'A majestic lion on a rocky cliff at sunset',
        aspect_ratio: '16:9',
      },
    });

    const polls = calls.filter((c) => c.url.includes('/predictions/status/'));
    expect(polls.length).toBe(3);

    const bytes = await readFile(path.join(projectsRoot, 'project-1', 'lion.png'));
    expect(bytes.equals(PNG_BYTES)).toBe(true);
  });

  it('sends the apikey header when downloading the delivery URL', async () => {
    const calls: Call[] = [];
    stubPruna({
      calls,
      deliveryUrl: 'https://api.pruna.ai/v1/predictions/delivery/xezq/abc/output.jpg',
      outputBytes: PNG_BYTES,
    });

    await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'p-image',
      prompt: 'A studio photo of a lemon',
      output: 'lemon.png',
    });

    const download = calls.find((c) => c.url.includes('/predictions/delivery/'));
    expect(download).toBeDefined();
    // The delivery endpoint is authenticated; a bare fetch returns 401.
    expect(download?.init?.headers).toMatchObject({ apikey: 'pruna-test-key' });
  });

  it('resolves a root-relative generation_url against the configured base', async () => {
    const calls: Call[] = [];
    stubPruna({
      calls,
      deliveryUrl: '/v1/predictions/delivery/xezq/abc/output.jpg',
      outputBytes: PNG_BYTES,
    });

    await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'p-image',
      prompt: 'A single red apple',
      output: 'apple.png',
    });

    const download = calls.find((c) => c.url.includes('/predictions/delivery/'));
    expect(download?.url).toBe('https://api.pruna.ai/v1/predictions/delivery/xezq/abc/output.jpg');
  });

  it('strips the -pruna disambiguation suffix from the wire model name', async () => {
    const calls: Call[] = [];
    stubPruna({
      calls,
      deliveryUrl: 'https://api.pruna.ai/v1/predictions/delivery/xezq/abc/output.jpg',
      outputBytes: PNG_BYTES,
    });

    const result = await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'flux-dev-pruna',
      prompt: 'A quiet harbour at dawn',
      output: 'harbour.png',
    });

    const submit = calls.find((c) => c.url.endsWith('/predictions'));
    expect(submit?.init?.headers).toMatchObject({ Model: 'flux-dev' });
    expect(result.providerNote).toContain('pruna/flux-dev');
    expect(result.providerNote).not.toContain('flux-dev-pruna');
  });

  it('lets a configured model alias override the suffix mapping', async () => {
    process.env.OD_MEDIA_MODEL_ALIASES = JSON.stringify({ 'flux-dev-pruna': 'z-image-turbo' });
    const calls: Call[] = [];
    stubPruna({
      calls,
      deliveryUrl: 'https://api.pruna.ai/v1/predictions/delivery/xezq/abc/output.jpg',
      outputBytes: PNG_BYTES,
    });

    await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'flux-dev-pruna',
      prompt: 'A quiet harbour at dawn',
      output: 'aliased.png',
    });

    const submit = calls.find((c) => c.url.endsWith('/predictions'));
    expect(submit?.init?.headers).toMatchObject({ Model: 'z-image-turbo' });
  });

  it('uploads reference images and passes them as an images array for p-image-edit', async () => {
    const refAbs = path.join(projectsRoot, 'project-1', 'ref.png');
    await writeFile(refAbs, PNG_BYTES);
    const calls: Call[] = [];
    stubPruna({
      calls,
      deliveryUrl: 'https://api.pruna.ai/v1/predictions/delivery/xezq/abc/output.jpg',
      outputBytes: PNG_BYTES,
      uploadUrl: 'https://api.pruna.ai/v1/files/file-xyz789',
    });

    await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'p-image-edit',
      prompt: 'Turn this into a watercolour painting',
      image: 'ref.png',
      output: 'edited.png',
    });

    const upload = calls.find((c) => c.url.endsWith('/files'));
    expect(upload?.init?.method).toBe('POST');
    expect(upload?.init?.headers).toMatchObject({ apikey: 'pruna-test-key' });
    // Multipart: the body must be FormData, and content-type must be left to
    // fetch so the boundary is generated.
    expect(upload?.init?.body).toBeInstanceOf(FormData);
    expect(upload?.init?.headers).not.toHaveProperty('content-type');

    const submit = calls.find((c) => c.url.endsWith('/predictions'));
    const body = JSON.parse(String(submit?.init?.body));
    // The API has no data-URL input, so the uploaded URL must replace it.
    expect(body.input.images).toEqual(['https://api.pruna.ai/v1/files/file-xyz789']);
    expect(JSON.stringify(body)).not.toContain('data:image');
    // The dispatcher's imageRefs already leads with the primary --image, so
    // reading both fields would upload the same file twice.
    expect(calls.filter((c) => c.url.endsWith('/files')).length).toBe(1);
  });

  it('uploads every distinct reference image once for a multi-image edit', async () => {
    await writeFile(path.join(projectsRoot, 'project-1', 'a.png'), PNG_BYTES);
    await writeFile(path.join(projectsRoot, 'project-1', 'b.png'), PNG_BYTES);
    const calls: Call[] = [];
    stubPruna({
      calls,
      deliveryUrl: 'https://api.pruna.ai/v1/predictions/delivery/xezq/abc/output.jpg',
      outputBytes: PNG_BYTES,
    });

    await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'p-image-edit',
      prompt: 'Blend these two frames',
      image: 'a.png',
      // 'a.png' repeated: the dispatcher dedupes by absolute path.
      images: ['a.png', 'b.png'],
      output: 'blended.png',
    });

    expect(calls.filter((c) => c.url.endsWith('/files')).length).toBe(2);
    const submit = calls.find((c) => c.url.endsWith('/predictions'));
    const body = JSON.parse(String(submit?.init?.body));
    expect(body.input.images).toHaveLength(2);
  });

  it('clamps video duration to the 20s Pruna ceiling and reports the clamp', async () => {
    const calls: Call[] = [];
    stubPruna({
      calls,
      deliveryUrl: 'https://api.pruna.ai/v1/predictions/delivery/xezq/abc/output.mp4',
      outputBytes: MP4_BYTES,
      submitBody: { id: 'vid1', model: 'p-video', get_url: 'https://api.pruna.ai/v1/predictions/status/vid1' },
    });

    const result = await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'video',
      model: 'p-video',
      prompt: 'A sports car drifting through a neon-lit city',
      aspect: '16:9',
      // VIDEO_LENGTHS_SEC allows 30; Pruna caps at 20.
      length: 30,
      resolution: '1080p',
      output: 'car.mp4',
    });

    const submit = calls.find((c) => c.url.endsWith('/predictions'));
    const body = JSON.parse(String(submit?.init?.body));
    expect(body.input.duration).toBe(20);
    expect(body.input.resolution).toBe('1080p');
    expect(body.input.aspect_ratio).toBe('16:9');
    expect(result.providerNote).toContain('clamped to 20s');
  });

  it('omits aspect_ratio for image-to-video because the API ignores it', async () => {
    const refAbs = path.join(projectsRoot, 'project-1', 'still.png');
    await writeFile(refAbs, PNG_BYTES);
    const calls: Call[] = [];
    stubPruna({
      calls,
      deliveryUrl: 'https://api.pruna.ai/v1/predictions/delivery/xezq/abc/output.mp4',
      outputBytes: MP4_BYTES,
      submitBody: { id: 'vid2', model: 'p-video', get_url: 'https://api.pruna.ai/v1/predictions/status/vid2' },
    });

    await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'video',
      model: 'p-video',
      prompt: 'The camera slowly pushes in',
      aspect: '9:16',
      image: 'still.png',
      output: 'push-in.mp4',
    });

    const submit = calls.find((c) => c.url.endsWith('/predictions'));
    const body = JSON.parse(String(submit?.init?.body));
    expect(body.input.image).toBe('https://api.pruna.ai/v1/files/file-abc123');
    expect(body.input).not.toHaveProperty('aspect_ratio');
  });

  it('surfaces a failed prediction instead of polling to the ceiling', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/predictions')) {
        return jsonResponse({ id: 'bad1', get_url: 'https://api.pruna.ai/v1/predictions/status/bad1' });
      }
      return jsonResponse({
        status: 'failed',
        message: 'Prediction failed',
        error: 'Number of samples, -5, must be non-negative.',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'p-image',
      prompt: 'A broken request',
      output: 'broken.png',
    })).rejects.toThrow(/pruna task failed: Number of samples/);
  });

  it('refuses to generate without a credential', async () => {
    delete process.env.OD_PRUNA_API_KEY;
    const fetchMock = vi.fn(async () => {
      throw new Error('network should not be reached without a key');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'p-image',
      prompt: 'No key configured',
      output: 'nokey.png',
    })).rejects.toThrow(/no Pruna API key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
