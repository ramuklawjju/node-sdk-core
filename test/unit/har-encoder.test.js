/**
 * (C) Copyright IBM Corp. 2025.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, PassThrough } = require('stream');

const { mkdtempSync, rmSync } = fs;
const logger = require('../../dist/lib/logger').default;
const { HAREncoder } = require('../../dist/lib/har-encoder');

jest.spyOn(logger, 'info').mockImplementation(() => {});
jest.spyOn(logger, 'warn').mockImplementation(() => {});
jest.spyOn(logger, 'error').mockImplementation(() => {});

const sampleUrl = 'https://example.com/api?foo=bar';

function createTempHarPath() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'har-test-'));
  return { dir, file: path.join(dir, 'test.har') };
}

function resetEnv() {
  delete process.env.HAR_ENABLED;
  delete process.env.HAR_FILE_PATH;
  HAREncoder.reset();
}

function readArchive(file) {
  const data = fs.readFileSync(file, 'utf8');
  return JSON.parse(data);
}

function makeReadable(content) {
  const r = new Readable({ read() {} });
  r.push(Buffer.isBuffer(content) ? content : Buffer.from(content));
  r.push(null);
  return r;
}

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

describe('HAREncoder enablement', () => {
  beforeAll(() => {
    resetEnv();
  });

  afterEach(() => {
    resetEnv();
  });

  it('is disabled by default', () => {
    const encoder = HAREncoder.getInstance();
    expect(encoder.isEnabled()).toBe(false);
  });

  it('enabled state is cached after first check', () => {
    process.env.HAR_ENABLED = '1';
    const encoder = HAREncoder.getInstance();
    expect(encoder.isEnabled()).toBe(true);
    // Changing the env var after initialisation must not affect the cached state
    delete process.env.HAR_ENABLED;
    expect(encoder.isEnabled()).toBe(true);
  });

  it('reset() clears the singleton so next getInstance() creates a fresh one', () => {
    process.env.HAR_ENABLED = '1';
    const first = HAREncoder.getInstance();
    expect(first.isEnabled()).toBe(true);
    HAREncoder.reset();
    delete process.env.HAR_ENABLED;
    const second = HAREncoder.getInstance();
    expect(second.isEnabled()).toBe(false);
    expect(second).not.toBe(first);
  });

  it('does not write a file when disabled', async () => {
    const { dir, file } = createTempHarPath();
    // HAR_ENABLED is not set
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: sampleUrl,
      headers: {},
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });
    expect(fs.existsSync(file)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the default filename ibm-node-sdk-core.har when HAR_FILE_PATH is not set', async () => {
    const expectedFile = path.join(os.tmpdir(), 'ibm-node-sdk-core.har');
    // Remove any stale file first
    try { fs.unlinkSync(expectedFile); } catch (_) { /* ignore */ }

    process.env.HAR_ENABLED = '1';
    delete process.env.HAR_FILE_PATH;
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: sampleUrl,
      headers: {},
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });
    expect(fs.existsSync(expectedFile)).toBe(true);
    fs.unlinkSync(expectedFile);
  });

  it('enables when HAR_ENABLED is set and writes an entry', async () => {
    const { dir, file } = createTempHarPath();
    process.env.HAR_ENABLED = '1';
    process.env.HAR_FILE_PATH = file;
    const encoder = HAREncoder.getInstance();

    expect(encoder.isEnabled()).toBe(true);

    await encoder.record({
      method: 'GET',
      url: sampleUrl,
      headers: {},
      queryParams: {},
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    expect(archive.log.entries).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// HAR structure
// ---------------------------------------------------------------------------

describe('HAREncoder HAR structure', () => {
  let dir;
  let file;

  beforeEach(() => {
    const tmp = createTempHarPath();
    dir = tmp.dir;
    file = tmp.file;
    process.env.HAR_ENABLED = '1';
    process.env.HAR_FILE_PATH = file;
    HAREncoder.reset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetEnv();
  });

  it('produces a valid HAR 1.2 skeleton', async () => {
    const encoder = HAREncoder.getInstance();
    const start = new Date('2025-01-15T10:00:00Z');
    const end = new Date('2025-01-15T10:00:00.123Z');

    await encoder.record({
      method: 'GET',
      url: 'https://example.com/api',
      headers: { accept: 'application/json' },
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' } },
      responseBody: Buffer.from('{"ok":true}'),
      responseContentType: 'application/json',
      startTime: start,
      endTime: end,
    });

    const archive = readArchive(file);
    expect(archive.log.version).toBe('1.2');
    expect(archive.log.creator.name).toBe('ibm-node-sdk-core');
    expect(Array.isArray(archive.log.entries)).toBe(true);

    const entry = archive.log.entries[0];
    expect(entry.startedDateTime).toBe(start.toISOString());
    expect(entry.time).toBe(123);
    expect(entry.request.method).toBe('GET');
    expect(entry.request.url).toBe('https://example.com/api');
    expect(entry.request.httpVersion).toBe('HTTP/1.1');
    expect(entry.request.headersSize).toBe(-1);
    expect(entry.request.bodySize).toBe(0);
    expect(entry.response.status).toBe(200);
    expect(entry.response.statusText).toBe('OK');
    expect(entry.response.redirectURL).toBe('');
    expect(entry.cache).toEqual({});
    expect(entry.timings.send).toBe(-1);
    expect(entry.timings.receive).toBe(-1);
    expect(entry.timings.wait).toBe(123);
  });

  it('accumulates multiple entries across sequential records', async () => {
    const encoder = HAREncoder.getInstance();
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await encoder.record({
        method: 'GET',
        url: `https://example.com/item/${i}`,
        headers: {},
        requestBody: Buffer.from(''),
        response: { status: 200, statusText: 'OK', headers: {} },
        responseBody: Buffer.from(''),
        startTime: new Date(),
        endTime: new Date(),
      });
    }
    const archive = readArchive(file);
    expect(archive.log.entries).toHaveLength(3);
    expect(archive.log.entries[2].request.url).toBe('https://example.com/item/2');
  });

  it('serialises concurrent records without losing entries', async () => {
    const encoder = HAREncoder.getInstance();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        encoder.record({
          method: 'GET',
          url: `https://example.com/concurrent/${i}`,
          headers: {},
          requestBody: Buffer.from(''),
          response: { status: 200, statusText: 'OK', headers: {} },
          responseBody: Buffer.from(''),
          startTime: new Date(),
          endTime: new Date(),
        })
      )
    );
    const archive = readArchive(file);
    expect(archive.log.entries).toHaveLength(10);
  });

  it('records query string from URL, not duplicated with params', async () => {
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: 'https://example.com/api?version=2023-05-01&limit=10',
      headers: {},
      queryParams: { version: '2023-05-01', limit: '10' },
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    const qs = archive.log.entries[0].request.queryString;
    const versionEntries = qs.filter((p) => p.name === 'version');
    expect(versionEntries).toHaveLength(1);
    expect(versionEntries[0].value).toBe('2023-05-01');
  });

  it('falls back to params when URL has no query string', async () => {
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: 'https://example.com/api',
      headers: {},
      queryParams: { page: '1', size: '20' },
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    const qs = archive.log.entries[0].request.queryString;
    expect(qs.find((p) => p.name === 'page')?.value).toBe('1');
    expect(qs.find((p) => p.name === 'size')?.value).toBe('20');
  });

  it('captures redirect URL for 3xx responses', async () => {
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: 'https://example.com/old',
      headers: {},
      requestBody: Buffer.from(''),
      response: {
        status: 301,
        statusText: 'Moved Permanently',
        headers: { location: 'https://example.com/new' },
        redirectURL: 'https://example.com/new',
      },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    const entry = archive.log.entries[0];
    expect(entry.response.status).toBe(301);
    expect(entry.response.redirectURL).toBe('https://example.com/new');
  });

  it('sets status 0 and error message for network errors', async () => {
    const encoder = HAREncoder.getInstance();
    const networkError = new Error('connect ECONNREFUSED');

    await encoder.record({
      method: 'POST',
      url: 'https://unreachable.example.com/api',
      headers: {},
      requestBody: Buffer.from('{}'),
      requestContentType: 'application/json',
      response: undefined,
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
      error: networkError,
    });

    const archive = readArchive(file);
    const entry = archive.log.entries[0];
    expect(entry.response.status).toBe(0);
    expect(entry.response.statusText).toBe('connect ECONNREFUSED');
  });

  it('handles 4xx/5xx errors that include an HTTP response', async () => {
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: 'https://example.com/api',
      headers: {},
      requestBody: Buffer.from(''),
      response: {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'content-type': 'application/json' },
      },
      responseBody: Buffer.from(JSON.stringify({ error: 'Insufficient permissions' })),
      responseContentType: 'application/json',
      startTime: new Date(),
      endTime: new Date(),
      error: new Error('Request failed with status code 403'),
    });

    const archive = readArchive(file);
    const entry = archive.log.entries[0];
    expect(entry.response.status).toBe(403);
    expect(entry.response.content.text).toContain('Insufficient permissions');
  });
});

// ---------------------------------------------------------------------------
// Content and redaction
// ---------------------------------------------------------------------------

describe('HAREncoder content and redaction', () => {
  let dir;
  let file;

  beforeEach(() => {
    const tmp = createTempHarPath();
    dir = tmp.dir;
    file = tmp.file;
    process.env.HAR_ENABLED = '1';
    process.env.HAR_FILE_PATH = file;
    HAREncoder.reset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetEnv();
  });

  it('redacts sensitive headers and JSON bodies', async () => {
    const encoder = HAREncoder.getInstance();
    const start = new Date();
    const end = new Date(start.getTime() + 5);

    await encoder.record({
      method: 'POST',
      url: sampleUrl,
      headers: { Authorization: 'Bearer secret-token', 'X-Api-Key': 'abc123' },
      requestContentType: 'application/json',
      queryParams: { foo: 'bar' },
      requestBody: Buffer.from(
        JSON.stringify({ password: 'mypassword', nested: { api_key: 'key123' } })
      ),
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'set-cookie': 'sessionid=abcdefghijkl' },
      },
      responseContentType: 'application/json',
      responseBody: Buffer.from(JSON.stringify({ token: 'super-secret-token' })),
      startTime: start,
      endTime: end,
    });

    const archive = readArchive(file);
    const entry = archive.log.entries[0];

    const authHeader = entry.request.headers.find((h) => h.name.toLowerCase() === 'authorization');
    expect(authHeader.value).toContain('[REDACTED_BEARER_TOKEN]');

    expect(entry.request.postData.text).toContain('[REDACTED_PASSWORD]');
    expect(entry.response.content.text).toContain('[REDACTED_TOKEN]');
    expect(entry.response.headers[0].value).toContain('[REDACTED_COOKIE]');
  });

  it('base64 encodes binary request body and marks encoding', async () => {
    const encoder = HAREncoder.getInstance();
    const payload = Buffer.from([0, 255, 4, 10, 26, 80, 90, 0, 0, 0]);
    const start = new Date();
    const end = new Date(start.getTime() + 10);

    await encoder.record({
      method: 'PUT',
      url: sampleUrl,
      headers: {},
      requestContentType: 'application/octet-stream',
      requestBody: payload,
      response: { status: 204, statusText: 'No Content', headers: {} },
      responseBody: Buffer.from(''),
      startTime: start,
      endTime: end,
    });

    const archive = readArchive(file);
    const entry = archive.log.entries[0];
    expect(entry.request.postData.encoding).toBe('base64');
    expect(entry.request.postData.text).toBe(payload.toString('base64'));
  });

  it('base64 encodes binary response body and marks encoding', async () => {
    const encoder = HAREncoder.getInstance();
    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header

    await encoder.record({
      method: 'GET',
      url: sampleUrl,
      headers: {},
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: binaryData,
      responseContentType: 'image/png',
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    const content = archive.log.entries[0].response.content;
    expect(content.encoding).toBe('base64');
    expect(content.text).toBe(binaryData.toString('base64'));
    expect(content.mimeType).toBe('image/png');
  });

  it('stores plain-text response body without encoding', async () => {
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: sampleUrl,
      headers: {},
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from('Hello, World!'),
      responseContentType: 'text/plain',
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    const content = archive.log.entries[0].response.content;
    expect(content.text).toBe('Hello, World!');
    expect(content.encoding).toBe('');
  });

  it('does not add postData when request body is empty', async () => {
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: sampleUrl,
      headers: {},
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    expect(archive.log.entries[0].request.postData).toBeUndefined();
  });

  it('redacts Authorization header in non-JSON bodies', async () => {
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'POST',
      url: sampleUrl,
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      requestContentType: 'text/plain',
      requestBody: Buffer.from('some plain text'),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    const entry = archive.log.entries[0];
    const authHeader = entry.request.headers.find((h) => h.name === 'Authorization');
    expect(authHeader.value).not.toContain('dXNlcjpwYXNz');
    expect(authHeader.value).toContain('[REDACTED');
  });

  it('handles multi-value headers', async () => {
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: sampleUrl,
      headers: { accept: ['application/json', 'text/html'] },
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    const acceptHeaders = archive.log.entries[0].request.headers.filter(
      (h) => h.name === 'accept'
    );
    expect(acceptHeaders).toHaveLength(2);
    expect(acceptHeaders.map((h) => h.value)).toContain('application/json');
    expect(acceptHeaders.map((h) => h.value)).toContain('text/html');
  });
});

// ---------------------------------------------------------------------------
// captureRequestBody / captureResponseBody
// ---------------------------------------------------------------------------

describe('HAREncoder body capture', () => {
  it('captures a Buffer request body', async () => {
    const encoder = HAREncoder.getInstance();
    const buf = Buffer.from('hello');
    const result = encoder.captureRequestBody(buf);
    expect(result.data).toBe(buf);
    const captured = await result.collect();
    expect(captured).toEqual(buf);
  });

  it('captures a string request body', async () => {
    const encoder = HAREncoder.getInstance();
    const result = encoder.captureRequestBody('hello');
    expect(result.data).toBe('hello');
    const captured = await result.collect();
    expect(captured).toEqual(Buffer.from('hello'));
  });

  it('captures a plain object request body as JSON', async () => {
    const encoder = HAREncoder.getInstance();
    const obj = { key: 'value' };
    const result = encoder.captureRequestBody(obj);
    const captured = await result.collect();
    expect(JSON.parse(captured.toString())).toEqual(obj);
  });

  it('returns empty buffer for null/undefined request body', async () => {
    const encoder = HAREncoder.getInstance();
    const result = encoder.captureRequestBody(null);
    const captured = await result.collect();
    expect(captured.length).toBe(0);
  });

  it('tees a readable stream request body so both caller and HAR can read it', async () => {
    const encoder = HAREncoder.getInstance();
    const content = 'streamed content';
    const stream = makeReadable(content);

    const result = encoder.captureRequestBody(stream);
    expect(result.data).toBeInstanceOf(PassThrough);

    const [callerData, harData] = await Promise.all([
      new Promise((resolve) => {
        const chunks = [];
        result.data.on('data', (c) => chunks.push(c));
        result.data.on('end', () => resolve(Buffer.concat(chunks).toString()));
      }),
      result.collect(),
    ]);

    expect(callerData).toBe(content);
    expect(harData.toString()).toBe(content);
  });

  it('returns empty buffer for FormData stream (cannot capture multipart body)', async () => {
    const encoder = HAREncoder.getInstance();
    const fakeFormData = new Readable({ read() {} });
    fakeFormData.getBoundary = () => 'boundary';
    const result = encoder.captureRequestBody(fakeFormData);
    const captured = await result.collect();
    expect(captured.length).toBe(0);
  });

  it('captures a Buffer response body without modifying response.data', async () => {
    const encoder = HAREncoder.getInstance();
    const buf = Buffer.from('response body');
    const response = { data: buf };
    const result = encoder.captureResponseBody(response);
    expect(result.data).toBe(buf);
    const captured = await result.collect();
    expect(captured).toEqual(buf);
  });

  it('captures a string response body', async () => {
    const encoder = HAREncoder.getInstance();
    const response = { data: 'some text' };
    const result = encoder.captureResponseBody(response);
    const captured = await result.collect();
    expect(captured.toString()).toBe('some text');
  });

  it('tees a stream response body and updates response.data', async () => {
    const encoder = HAREncoder.getInstance();
    const content = 'streamed response';
    const stream = makeReadable(content);
    const response = { data: stream };

    const result = encoder.captureResponseBody(response);
    expect(response.data).toBeInstanceOf(PassThrough);

    const [callerData, harData] = await Promise.all([
      new Promise((resolve) => {
        const chunks = [];
        response.data.on('data', (c) => chunks.push(c));
        response.data.on('end', () => resolve(Buffer.concat(chunks).toString()));
      }),
      result.collect(),
    ]);

    expect(callerData).toBe(content);
    expect(harData.toString()).toBe(content);
  });

  it('returns empty buffer when response.data is null', async () => {
    const encoder = HAREncoder.getInstance();
    const response = { data: null };
    const result = encoder.captureResponseBody(response);
    const captured = await result.collect();
    expect(captured.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// File operations: recovery and rotation
// ---------------------------------------------------------------------------

describe('HAREncoder file operations', () => {
  let dir;
  let file;

  beforeEach(() => {
    const tmp = createTempHarPath();
    dir = tmp.dir;
    file = tmp.file;
    process.env.HAR_ENABLED = '1';
    process.env.HAR_FILE_PATH = file;
    HAREncoder.reset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetEnv();
  });

  it('recovers from a corrupt HAR file by starting fresh', async () => {
    fs.writeFileSync(file, 'this is not valid json {{{');
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: sampleUrl,
      headers: {},
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    expect(archive.log.entries).toHaveLength(1);
  });

  it('recovers from an empty HAR file', async () => {
    fs.writeFileSync(file, '');
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'DELETE',
      url: sampleUrl,
      headers: {},
      requestBody: Buffer.from(''),
      response: { status: 204, statusText: 'No Content', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const archive = readArchive(file);
    expect(archive.log.entries).toHaveLength(1);
    expect(archive.log.entries[0].request.method).toBe('DELETE');
  });

  it('rotates when maximum entries are exceeded', async () => {
    const encoder = HAREncoder.getInstance();

    const archive = {
      log: {
        version: '1.2',
        creator: { name: 'ibm-node-sdk-core', version: 'test' },
        pages: [],
        entries: [],
      },
    };

    const sampleEntry = {
      pageref: 'page_1',
      startedDateTime: new Date().toISOString(),
      time: 0,
      request: {
        method: 'GET',
        url: sampleUrl,
        httpVersion: 'HTTP/1.1',
        headers: [],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [],
        content: { size: 0, mimeType: '' },
        redirectURL: '',
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { send: -1, wait: 0, receive: -1 },
    };

    for (let i = 0; i < 10000; i += 1) {
      archive.log.entries.push(sampleEntry);
    }

    fs.writeFileSync(file, JSON.stringify(archive));

    await encoder.record({
      method: 'GET',
      url: sampleUrl,
      headers: {},
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const files = fs.readdirSync(dir);
    const rotated = files.find((name) => name.startsWith('test_') && name.endsWith('.har'));
    expect(rotated).toBeDefined();

    const newArchive = readArchive(file);
    expect(newArchive.log.entries).toHaveLength(1);
  });

  it('writes the HAR file with restricted permissions (0o600)', async () => {
    const encoder = HAREncoder.getInstance();
    await encoder.record({
      method: 'GET',
      url: sampleUrl,
      headers: {},
      requestBody: Buffer.from(''),
      response: { status: 200, statusText: 'OK', headers: {} },
      responseBody: Buffer.from(''),
      startTime: new Date(),
      endTime: new Date(),
    });

    const stat = fs.statSync(file);
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
