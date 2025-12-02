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

  it('enables when HAR_ENABLED is set', async () => {
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

  it('base64 encodes binary bodies', async () => {
    const encoder = HAREncoder.getInstance();
    const payload = Buffer.from([0, 255, 4, 10, 26, 80, 90, 0, 0, 0]);
    const start = new Date();
    const end = new Date(start.getTime() + 10);

    await encoder.record({
      method: 'PUT',
      url: sampleUrl,
      headers: {},
      queryParams: {},
      requestContentType: 'application/octet-stream',
      requestBody: payload,
      response: { status: 204, statusText: 'No Content', headers: {} },
      responseBody: Buffer.from(''),
      startTime: start,
      endTime: end,
    });

    const archive = readArchive(file);
    const entry = archive.log.entries[0];
    expect(entry.request.postData.encoding).toBeUndefined();
    expect(entry.request.postData.text).toBe(payload.toString('base64'));
  });
});

describe('HAREncoder rotation', () => {
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
      queryParams: {},
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
});
