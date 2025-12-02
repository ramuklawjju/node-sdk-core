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

import fs from 'fs';
import path from 'path';
import os from 'os';
import { PassThrough, Readable } from 'stream';
import logger from './logger';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: sdkVersion } = require('../package.json');

const harMaxEntries = 10000;
const harBinaryThreshold = 0.05;

const bearerTokenPattern = /(bearer\s+)([a-zA-Z0-9\-._~+/]+=*)/gi;
const basicAuthPattern = /(basic\s+)([a-zA-Z0-9+/]+=*)/gi;
const apiKeyPattern = /(apikey[\s:=]+)([a-zA-Z0-9\-._~+/]+)/gi;
const tokenPattern = /(token[\s:=]+)([a-zA-Z0-9\-._~+/]+)/gi;
const iamTokenPattern = /(iam[_-]?token[\s:=]+)([a-zA-Z0-9\-._~+/]+)/gi;
const accessTokenPattern = /(access[_-]?token[\s:=]+)([a-zA-Z0-9\-._~+/]+)/gi;
const sessionTokenPattern = /(session[_-]?token[\s:=]+)([a-zA-Z0-9\-._~+/]+)/gi;
const passwordPattern = /(password[\s:=]+)([^\s&"'<>]+)/gi;
const secretPattern = /(secret[\s:=]+)([a-zA-Z0-9\-._~+/]+)/gi;
const cookiePattern = /(=[^;,\s]{8,})(;|,|$)/g;

export interface HarNameValue {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType: string;
  text?: string;
  params?: Array<{ name: string; value?: string }>;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarNameValue[];
  queryString: HarNameValue[];
  postData?: HarPostData;
  headersSize: number;
  bodySize: number;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: string;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarNameValue[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

export interface HarTimings {
  send: number;
  wait: number;
  receive: number;
}

export interface HarEntry {
  pageref: string;
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: HarTimings;
  serverIPAddress?: string;
  connection?: string;
}

export interface HarLog {
  version: string;
  creator: {
    name: string;
    version: string;
  };
  pages: Array<Record<string, never>>;
  entries: HarEntry[];
}

export interface HarArchive {
  log: HarLog;
}

interface HarRecordInput {
  method: string;
  url: string;
  httpVersion?: string;
  headers: Record<string, any> | Array<[string, string]>;
  queryParams?: Record<string, any>;
  requestBody: Buffer;
  response?: {
    status?: number;
    statusText?: string;
    httpVersion?: string;
    headers?: Record<string, any>;
    redirectURL?: string;
  };
  responseBody: Buffer;
  requestContentType?: string;
  responseContentType?: string;
  startTime: Date;
  endTime: Date;
  error?: Error;
}

interface BodyCaptureResult {
  data: any;
  collect: () => Promise<Buffer>;
}

export class HAREncoder {
  private static instance: HAREncoder;

  private initialized = false;

  private enabled = false;

  private filePath: string;

  private operationQueue: Promise<void> = Promise.resolve();

  public static getInstance(): HAREncoder {
    if (!HAREncoder.instance) {
      HAREncoder.instance = new HAREncoder();
    }
    return HAREncoder.instance;
  }

  public static reset(): void {
    HAREncoder.instance = undefined;
  }

  public isEnabled(): boolean {
    if (!this.initialized) {
      this.enabled = process.env.HAR_ENABLED === '1';
      if (this.enabled) {
        const customPath = process.env.HAR_FILE_PATH;
        this.filePath = customPath || path.join(os.tmpdir(), 'ibm-go-sdk-core.har');
        logger.info(`HAR recording enabled, writing to: ${this.filePath}`);
      }
      this.initialized = true;
    }
    return this.enabled;
  }

  // eslint-disable-next-line class-methods-use-this
  public captureRequestBody(data: any): BodyCaptureResult {
    if (!data) {
      return { data, collect: async () => Buffer.alloc(0) };
    }

    if (isReadableStream(data)) {
      if (isFormDataStream(data)) {
        return { data, collect: async () => Buffer.alloc(0) };
      }
      return teeStream(data);
    }

    if (Buffer.isBuffer(data)) {
      const bufferCopy = Buffer.from(data);
      return { data, collect: async () => bufferCopy };
    }

    if (typeof data === 'string') {
      const bufferCopy = Buffer.from(data);
      return { data, collect: async () => bufferCopy };
    }

    try {
      const serialized = JSON.stringify(data);
      const bufferCopy = Buffer.from(serialized);
      return { data, collect: async () => bufferCopy };
    } catch (err) {
      return { data, collect: async () => Buffer.alloc(0) };
    }
  }

  // eslint-disable-next-line class-methods-use-this
  public captureResponseBody(response: any): BodyCaptureResult {
    if (!response || response.data == null) {
      return { data: response ? response.data : undefined, collect: async () => Buffer.alloc(0) };
    }

    const body = response.data;

    if (isReadableStream(body)) {
      const tracked = teeStream(body);
      response.data = tracked.data;
      return tracked;
    }

    if (Buffer.isBuffer(body)) {
      const bufferCopy = Buffer.from(body);
      return { data: body, collect: async () => bufferCopy };
    }

    if (typeof body === 'string') {
      const bufferCopy = Buffer.from(body);
      return { data: body, collect: async () => bufferCopy };
    }

    try {
      const serialized = JSON.stringify(body);
      const bufferCopy = Buffer.from(serialized);
      return { data: body, collect: async () => bufferCopy };
    } catch (err) {
      return { data: body, collect: async () => Buffer.alloc(0) };
    }
  }

  public async record(input: HarRecordInput): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const harEntry = this.buildEntry(input);
    if (!harEntry) {
      return;
    }

    await this.enqueue(async () => {
      try {
        let archive = await this.readOrCreateArchive();
        if (archive.log.entries.length >= harMaxEntries) {
          logger.warn(`HAR file reached maximum entries (${harMaxEntries}), rotating...`);
          await this.rotateHarFile();
          archive = this.createNewArchive();
        }

        archive.log.entries.push(harEntry);
        await this.writeArchive(archive);
      } catch (err) {
        logger.error(`Failed to append HAR entry: ${err}`);
      }
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.operationQueue = this.operationQueue.then(task, task);
    return this.operationQueue;
  }

  private buildEntry(input: HarRecordInput): HarEntry | null {
    try {
      const start = input.startTime;
      const end = input.endTime;
      const durationMs = end.getTime() - start.getTime();

      const request = this.buildRequest(input);
      const response = this.buildResponse(input);

      return {
        pageref: 'page_1',
        startedDateTime: start.toISOString(),
        time: durationMs,
        request,
        response,
        cache: {},
        timings: {
          send: -1,
          wait: durationMs,
          receive: -1,
        },
      };
    } catch (err) {
      logger.error(`Failed to build HAR entry: ${err}`);
      return null;
    }
  }

  // eslint-disable-next-line class-methods-use-this
  private buildRequest(input: HarRecordInput): HarRequest {
    const url = input.url || '';
    const headers = convertHeaders(input.headers);
    const queryString = convertQueryString(url, input.queryParams);
    const { text, encoding } = processBodyContent(
      input.requestBody,
      true,
      input.requestContentType || ''
    );

    const harReq: HarRequest = {
      method: input.method || '',
      url,
      httpVersion: getHttpVersion(input.httpVersion),
      headers,
      queryString,
      headersSize: -1,
      bodySize: input.requestBody?.length || 0,
    };

    if (input.requestBody && input.requestBody.length > 0 && (text !== '' || encoding !== '')) {
      harReq.postData = {
        mimeType: input.requestContentType || '',
        text,
      };
    }

    return harReq;
  }

  // eslint-disable-next-line class-methods-use-this
  private buildResponse(input: HarRecordInput): HarResponse {
    const status = getStatusCode(input.response?.status, input.error);
    const statusText = getStatusText(input.response?.statusText, input.error);
    const { text, encoding } = processBodyContent(
      input.responseBody,
      false,
      input.responseContentType || ''
    );

    const resp: HarResponse = {
      status,
      statusText,
      httpVersion: getHttpVersionFromResponse(input.response?.httpVersion, input.httpVersion),
      headers: convertHeaders(input.response?.headers),
      content: {
        size: input.responseBody?.length || 0,
        mimeType: input.responseContentType || '',
        text,
        encoding,
      },
      redirectURL:
        input.response &&
        input.response.status &&
        input.response.status >= 300 &&
        input.response.status < 400
          ? input.response.redirectURL || ''
          : '',
      headersSize: -1,
      bodySize: input.responseBody?.length || 0,
    };

    return resp;
  }

  private async readOrCreateArchive(): Promise<HarArchive> {
    try {
      const data = await fs.promises.readFile(this.filePath);
      if (!data || data.length === 0) {
        return this.createNewArchive();
      }

      try {
        const parsed = JSON.parse(data.toString()) as HarArchive;
        if (parsed && parsed.log && Array.isArray(parsed.log.entries)) {
          return parsed;
        }
      } catch (err) {
        logger.warn(`Failed to parse existing HAR file, creating new: ${err}`);
      }
    } catch (err) {
      return this.createNewArchive();
    }

    return this.createNewArchive();
  }

  // eslint-disable-next-line class-methods-use-this
  private createNewArchive(): HarArchive {
    return {
      log: {
        version: '1.2',
        creator: {
          name: 'ibm-node-sdk-core',
          version: sdkVersion,
        },
        pages: [],
        entries: [],
      },
    };
  }

  private async writeArchive(archive: HarArchive): Promise<void> {
    try {
      const data = JSON.stringify(archive, null, 2);
      await fs.promises.writeFile(this.filePath, data, { mode: 0o600 });
    } catch (err) {
      logger.error(`Failed to write HAR file: ${err}`);
    }
  }

  private async rotateHarFile(): Promise<void> {
    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate()
    ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(
      now.getMinutes()
    ).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const backupPath = `${this.filePath.replace(/\.har$/, '')}_${timestamp}.har`;

    try {
      await fs.promises.rename(this.filePath, backupPath);
      logger.info(`Rotated HAR file to: ${backupPath}`);
    } catch (err) {
      logger.error(`Failed to rotate HAR file: ${err}`);
    }
  }
}

function teeStream(stream: Readable): BodyCaptureResult {
  const tee = new PassThrough();
  const chunks: Buffer[] = [];

  tee.on('data', (chunk: Buffer) => {
    chunks.push(Buffer.from(chunk));
  });

  return {
    data: stream.pipe(tee),
    collect: () =>
      new Promise<Buffer>((resolve) => {
        let finished = false;
        const finalize = () => {
          if (!finished) {
            finished = true;
            resolve(Buffer.concat(chunks));
          }
        };
        tee.on('end', finalize);
        tee.on('close', finalize);
        tee.on('error', finalize);
      }),
  };
}

function convertHeaders(headers: any): HarNameValue[] {
  if (!headers) {
    return [];
  }

  const result: HarNameValue[] = [];
  const headerEntries: Array<[string, any]> = Array.isArray(headers)
    ? (headers as Array<[string, any]>)
    : Object.entries(headers);

  headerEntries.forEach(([name, value]) => {
    if (value == null) {
      return;
    }
    const values = Array.isArray(value) ? value : [value];
    values.forEach((val) => {
      const strVal = String(val);
      const redactedValue = isSensitiveHeader(name) ? redactSecretValue(strVal) : strVal;
      result.push({ name, value: redactedValue });
    });
  });

  return result;
}

function convertQueryString(urlValue: string, params?: Record<string, any>): HarNameValue[] {
  const result: HarNameValue[] = [];

  if (params) {
    Object.keys(params).forEach((key) => {
      const value = params[key];
      if (value === undefined || value === null) {
        return;
      }
      const values = Array.isArray(value) ? value : [value];
      values.forEach((val) => result.push({ name: key, value: String(val) }));
    });
  }

  try {
    const parsedUrl = new URL(urlValue);
    parsedUrl.searchParams.forEach((value, name) => {
      result.push({ name, value });
    });
  } catch (err) {
    // ignore parse errors
  }

  return result;
}

function processBodyContent(
  body: Buffer,
  _isRequest: boolean,
  contentType: string
): {
  text: string;
  encoding: string;
} {
  if (!body || body.length === 0) {
    return { text: '', encoding: '' };
  }

  if (isBinaryContent(body)) {
    return { text: body.toString('base64'), encoding: 'base64' };
  }

  let text = body.toString();

  if (
    contentType.toLowerCase().includes('json') ||
    text.trim().startsWith('{') ||
    text.trim().startsWith('[')
  ) {
    const redacted = redactJsonSecrets(text);
    if (redacted !== '') {
      return { text: redacted, encoding: '' };
    }
  }

  text = redactSecretValue(text);
  text = redactGenericSecrets(text);

  return { text, encoding: '' };
}

function redactJsonSecrets(jsonStr: string): string {
  try {
    const data = JSON.parse(jsonStr);
    const redacted = redactJsonValue(data);
    return JSON.stringify(redacted, null, 2);
  } catch (err) {
    return '';
  }
}

function redactJsonValue(val: any): any {
  if (Array.isArray(val)) {
    return val.map((item) => redactJsonValue(item));
  }

  if (val && typeof val === 'object') {
    const result: any = {};
    Object.keys(val).forEach((key) => {
      const lowerKey = key.toLowerCase();
      if (isSensitiveJsonKey(lowerKey)) {
        result[key] = getRedactionLabel(lowerKey);
      } else {
        result[key] = redactJsonValue(val[key]);
      }
    });
    return result;
  }

  if (typeof val === 'string') {
    if (looksLikeToken(val)) {
      return '[REDACTED_TOKEN]';
    }
    return val;
  }

  return val;
}

function isSensitiveJsonKey(key: string): boolean {
  const sensitiveKeys = [
    'token',
    'apikey',
    'api_key',
    'password',
    'secret',
    'authorization',
    'auth',
    'credential',
    'access_token',
    'refresh_token',
    'session_token',
    'bearer',
    'api-key',
    'iam_token',
    'session_id',
    'cookie',
    'sessionid',
  ];

  return sensitiveKeys.some((sensitive) => key.includes(sensitive));
}

function getRedactionLabel(key: string): string {
  if (key.includes('bearer')) {
    return '[REDACTED_BEARER_TOKEN]';
  }
  if (key.includes('apikey') || key.includes('api_key') || key.includes('api-key')) {
    return '[REDACTED_API_KEY]';
  }
  if (key.includes('password')) {
    return '[REDACTED_PASSWORD]';
  }
  if (key.includes('secret')) {
    return '[REDACTED_SECRET]';
  }
  if (key.includes('iam_token') || key.includes('iam-token')) {
    return '[REDACTED_IAM_TOKEN]';
  }
  if (key.includes('access_token') || key.includes('access-token')) {
    return '[REDACTED_ACCESS_TOKEN]';
  }
  if (key.includes('session')) {
    return '[REDACTED_SESSION_TOKEN]';
  }
  if (key.includes('cookie')) {
    return '[REDACTED_COOKIE]';
  }
  return '[REDACTED_TOKEN]';
}

function looksLikeToken(value: string): boolean {
  if (value.length > 32 && /^[A-Za-z0-9\-._~+/]+=*$/.test(value)) {
    return true;
  }
  if (value.split('.').length === 3 && value.length > 50) {
    return true;
  }
  return false;
}

function redactSecretValue(value: string): string {
  let result = value;
  result = result.replace(bearerTokenPattern, '$1[REDACTED_BEARER_TOKEN]');
  result = result.replace(basicAuthPattern, '$1[REDACTED_BASIC_AUTH]');
  result = result.replace(apiKeyPattern, '$1[REDACTED_API_KEY]');
  result = result.replace(iamTokenPattern, '$1[REDACTED_IAM_TOKEN]');
  result = result.replace(accessTokenPattern, '$1[REDACTED_ACCESS_TOKEN]');
  result = result.replace(sessionTokenPattern, '$1[REDACTED_SESSION_TOKEN]');
  result = result.replace(tokenPattern, '$1[REDACTED_TOKEN]');
  result = result.replace(passwordPattern, '$1[REDACTED_PASSWORD]');
  result = result.replace(secretPattern, '$1[REDACTED_SECRET]');
  result = result.replace(cookiePattern, '=[REDACTED_COOKIE]$2');
  return result;
}

function redactGenericSecrets(value: string): string {
  const redactedKeywords = [
    'apikey',
    'api_key',
    'passcode',
    'password',
    'token',
    'aadClientId',
    'aadClientSecret',
    'auth',
    'auth_provider_x509_cert_url',
    'auth_uri',
    'client_email',
    'client_id',
    'client_x509_cert_url',
    'key',
    'project_id',
    'secret',
    'subscriptionId',
    'tenantId',
    'thumbprint',
    'token_uri',
  ];

  const redactedTokens = redactedKeywords.join('|');
  const reAuthHeader = new RegExp(`(?m)^(Authorization|X-Auth\\S*): .*`);
  const rePropertySetting = new RegExp(`(?i)(${redactedTokens})=[^&]*(&|$)`);
  const reJsonField = new RegExp(`(?i)"([^"]*(${redactedTokens})[^"_]*)":\\s*"[^\\,]*"`);

  let redactedString = value;
  redactedString = redactedString.replace(reAuthHeader, '$1: [redacted]');
  redactedString = redactedString.replace(rePropertySetting, '$1=[redacted]$2');
  redactedString = redactedString.replace(reJsonField, '"$1":"[redacted]"');

  return redactedString;
}

function isBinaryContent(data: Buffer): boolean {
  if (!data || data.length === 0) {
    return false;
  }

  let nonPrintable = 0;
  let sampleSize = data.length;
  if (sampleSize > 8192) {
    sampleSize = 8192;
  }

  for (let i = 0; i < sampleSize; i += 1) {
    const byte = data[i];
    if (!(byte === 9 || byte === 10 || byte === 13)) {
      if (byte < 32 || byte > 126) {
        nonPrintable += 1;
      }
    }
  }

  const ratio = nonPrintable / sampleSize;
  return ratio > harBinaryThreshold;
}

function isSensitiveHeader(name: string): boolean {
  const lowerName = (name || '').toLowerCase();
  const sensitivePatterns = [
    'authorization',
    'cookie',
    'set-cookie',
    'token',
    'apikey',
    'api-key',
    'secret',
    'password',
    'credential',
    'session',
    'x-auth',
    'x-api',
  ];

  return sensitivePatterns.some((pattern) => lowerName.includes(pattern));
}

function getHttpVersion(proto?: string): string {
  if (!proto) {
    return 'HTTP/1.1';
  }
  return proto;
}

function getHttpVersionFromResponse(responseProto?: string, requestProto?: string): string {
  if (responseProto) {
    return responseProto;
  }
  if (requestProto) {
    return requestProto;
  }
  return 'HTTP/1.1';
}

function getStatusCode(status?: number, err?: Error): number {
  if (typeof status === 'number') {
    return status;
  }
  if (err) {
    return 0;
  }
  return -1;
}

function getStatusText(statusText?: string, err?: Error): string {
  if (statusText) {
    return statusText;
  }
  if (err) {
    return err.message;
  }
  return '';
}

function isReadableStream(body: any): body is Readable {
  return body && typeof body.pipe === 'function' && typeof body.on === 'function';
}

function isFormDataStream(body: any): boolean {
  return (
    body &&
    typeof body === 'object' &&
    (body.constructor?.name === 'FormData' || typeof body.getBoundary === 'function')
  );
}
