import assert from 'assert';
import { ChildProcess, fork } from 'child_process';
import buildDebug from 'debug';
import { writeFile } from 'fs/promises';
import getPort from 'get-port';
import got, { HTTPAlias, Response, Headers as gotHeaders } from 'got';
import { isNil, isObject, isRegExp } from 'lodash';
import path from 'path';

import { fromJStoYAML } from '@verdaccio/config';
import { API_MESSAGE, HEADERS, HTTP_STATUS, TOKEN_BEARER, fileUtils } from '@verdaccio/core';
import { generatePackageMetadata } from '@verdaccio/test-helper';
import { ConfigYaml } from '@verdaccio/types';
import { buildToken } from '@verdaccio/utils';

const buildAuthHeader = (token: string): string => {
  return buildToken(TOKEN_BEARER, token);
};

const debug = buildDebug('verdaccio:registry');

type Options = {
  url: string;
  method: HTTPAlias;
  headers: gotHeaders;
  encoding?: string;
  json: boolean;
  body?: any;
};

type RegistryResponse = {
  ok: string;
  error: null | string;
};

export const CREDENTIALS = {
  user: 'fooooo',
  password: 'sms_8tn>V%zPZ_+6', // pragma: allowlist secret
};

export interface ResponseAssert {
  status(reason: any): any;
  body_ok(reason: any): any;
  body_error(reason: any): any;
  request(reason: any): any;
  response(reason: any): any;
  send(reason: any): any;
}

class RequestAssert {
  private response: Response<RegistryResponse>;
  public constructor(response: Response<RegistryResponse>) {
    this.response = response;
  }

  public status(code: number) {
    debug('expected check status %s vs response code %s', code, this.response.statusCode);
    assert(code === this.response.statusCode);
    return this;
  }

  public equal_body(expected: string | RegExp) {
    assert.strictEqual(expected, this.response.body);
  }

  public body_ok(expected: string | RegExp) {
    debug('body expect ok %s', expected);
    if (isRegExp(expected)) {
      assert(this.response.body?.ok?.match(expected));
      assert(
        this.response.body?.ok.match(expected),
        `'${this.response.body.ok}' doesn't match " ${expected}`
      );
    } else if (typeof expected === 'string') {
      assert.equal(this.response.body?.ok, expected);
    } else {
      assert.deepEqual(this.response.body, expected);
    }
  }

  public body_error(expected: string | RegExp) {
    debug('body expect error %s', expected);
    if (isRegExp(expect)) {
      assert(
        this.response?.body?.error?.match(expected),
        `${this.response.body?.error} doesn't match ${expected}`
      );
    }
    assert.equal(this.response.body?.ok, null);
  }
}

export async function createRequest(options: Options): Promise<any> {
  debug('options %s', JSON.stringify(options));
  let body = undefined;
  if (isNil(options.body) === false) {
    body = isObject(options.body) === false ? JSON.stringify(options.body) : options.body;
  }

  const method = options?.method?.toLocaleLowerCase();
  if (method === 'get') {
    return got(options.url, {
      isStream: false,
      resolveBodyOnly: false,
      throwHttpErrors: false,
      // @ts-ignore
      responseType: options.encoding ?? 'json',
      headers: options.headers,
      method: options.method,
      body,
      retry: { limit: 0 },
      // @ts-ignore
    }).then((response) => {
      return new RequestAssert(response as any);
    });
  } else if (method === 'put') {
    return (
      got
        .put(options.url, {
          throwHttpErrors: false,
          responseType: 'json',
          headers: options.headers,
          json: options.body ? options.body : undefined,
          retry: { limit: 0 },
        })
        // @ts-ignore
        .then((response) => {
          return new RequestAssert(response as any);
        })
    );
  } else if (method === 'delete') {
    return (
      got
        .delete(options.url, {
          throwHttpErrors: false,
          responseType: 'json',
          headers: options.headers,
          retry: { limit: 0 },
        })
        // @ts-ignore
        .then((response) => {
          return new RequestAssert(response as any);
        })
    );
  }
}

export class ServerQuery {
  private userAgent: string;
  private url: string;
  public constructor(url) {
    this.url = url.replace(/\/$/, '');
    debug('server url %s', this.url);
    this.userAgent = 'node/v8.1.2 linux x64';
  }

  private request(options: any): Promise<ResponseAssert> {
    return createRequest({
      ...options,
      url: `${this.url}${options.uri}`,
    });
  }

  public debug(): Promise<ResponseAssert> {
    return this.request({
      uri: '/-/_debug',
      method: 'get',
      headers: {
        [HEADERS.CONTENT_TYPE]: HEADERS.JSON,
      },
    });
  }

  /**
   *
   *
   * @param {{ name: string; password: string }} { name, password }
   * @return {*}  {Promise<ResponseAssert>}
   * @memberof ServerQuery
   * @deprecated use createUser instead
   */
  public auth({ name, password }: { name: string; password: string }): Promise<ResponseAssert> {
    return this.createUser(name, password);
  }

  public createUser(name, password): Promise<ResponseAssert> {
    return this.request({
      uri: `/-/user/org.couchdb.user:${encodeURIComponent(name)}`,
      method: 'PUT',
      body: {
        name,
        password,
        _id: `org.couchdb.user:${name}`,
        type: 'user',
        roles: [],
        date: new Date(),
      },
    });
  }

  public logout(token: string) {
    return this.request({
      uri: `/-/user/token/${encodeURIComponent(token)}`,
      method: 'DELETE',
    });
  }

  public getPackage(name: string) {
    return this.request({
      uri: `/${encodeURIComponent(name)}`,
      method: 'get',
    });
  }

  public getTarball(name: string, filename: string) {
    return this.request({
      uri: `/${encodeURIComponent(name)}/-/${encodeURIComponent(filename)}`,
      method: 'GET',
      encoding: 'buffer',
    });
  }

  /**
   * Remove entire package.
   * @param name package name
   * @param rev revision id
   * @returns
   */
  public removePackage(name: string, rev) {
    return this.request({
      uri: `/${encodeURIComponent(name)}/-rev/${rev}`,
      method: 'DELETE',
      headers: {
        [HEADERS.CONTENT_TYPE]: HEADERS.JSON_CHARSET,
      },
    });
  }

  public removeSingleTarball(name: string, filename: string) {
    return this.request({
      uri: `/${encodeURIComponent(name)}/-/${filename}/-rev/whatever`,
      method: 'DELETE',
      headers: {
        [HEADERS.CONTENT_TYPE]: HEADERS.JSON_CHARSET,
      },
    });
  }

  /**
   *
   * @param name
   * @param tag
   * @param version
   * @returns
   */
  public addTag(name: string, tag: string, version: string) {
    return this.request({
      uri: `/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
      method: 'PUT',
      body: version,
      headers: {
        [HEADERS.CONTENT_TYPE]: HEADERS.JSON,
      },
    });
  }

  public putVersion(name: string, version: string, data: any) {
    return this.request({
      uri: `/${encodeURIComponent(name)}/${encodeURIComponent(version)}/-tag/latest`,
      method: 'PUT',
      body: data,
      headers: {
        [HEADERS.CONTENT_TYPE]: HEADERS.JSON,
      },
    });
  }

  public putPackage(name: string, data) {
    return this.request({
      uri: `/${encodeURIComponent(name)}`,
      method: 'PUT',
      body: data,
      headers: {
        [HEADERS.CONTENT_TYPE]: HEADERS.JSON,
      },
    });
  }

  public async addPackage(name: string, version: string = '1.0.0'): Promise<ResponseAssert> {
    return (await this.putPackage(name, generatePackageMetadata(name, version)))
      .status(HTTP_STATUS.CREATED)
      .body_ok(API_MESSAGE.PKG_CREATED);
  }

  public async addPackageAssert(name: string, version: string = '1.0.0'): Promise<ResponseAssert> {
    return this.putPackage(name, generatePackageMetadata(name, version));
  }

  public async whoami() {
    debug('request whoami');
    return await this.request({
      uri: '/-/whoami',
      method: 'get',
    });
  }

  public async ping() {
    return (
      await this.request({
        uri: '/-/ping',
        method: 'get',
      })
    ).status(HTTP_STATUS.OK);
  }
}

export class Registry {
  private childFork: any;
  private configPath: string;
  private domain: string;
  private authstr: string | null = null;
  private port: number;
  private token: string | null = null;
  public constructor(configPath: string, domain: string = 'localhost', port: number = 8080) {
    this.configPath = configPath;
    this.port = port;
    this.domain = domain;
  }

  public static async fromConfigToPath(
    config: Partial<ConfigYaml>
  ): Promise<{ tempFolder: string; configPath: string; yamlContent: string }> {
    debug(`fromConfigToPath`);
    const tempFolder = await fileUtils.createTempFolder('registry-');
    debug(`tempFolder %o`, tempFolder);
    const yamlContent = fromJStoYAML(config) as string;
    const configPath = path.join(tempFolder, 'registry.yaml');
    await writeFile(configPath, yamlContent);
    debug(`configPath %o`, configPath);
    return {
      tempFolder,
      configPath,
      yamlContent,
    };
  }

  public init(verdaccioPath: string): Promise<ChildProcess> {
    return this._start(verdaccioPath);
  }

  public getToken() {
    return this.token;
  }

  public getAuthStr() {
    return this.authstr;
  }

  public getPort() {
    return this.port;
  }

  public getDomain() {
    return this.domain;
  }

  public getRegistryUrl() {
    return `http://${this.getDomain()}:${this.getPort()}`;
  }

  private _start(
    verdaccioPath: string = path.join(__dirname, '../../bin/verdaccio')
  ): Promise<ChildProcess> {
    debug('_start %o', verdaccioPath);
    return getPort().then((port: number) => {
      this.port = port;
      debug('port %o', port);
      return new Promise((resolve, reject) => {
        let childOptions = {
          silent: false,
        };

        // @ts-ignore
        const debugPort = parseInt(port, 10) + 5;

        childOptions = Object.assign({}, childOptions, {
          execArgv: [`--inspect=${debugPort}`],
          env: {
            DEBUG: 'verdaccio*',
          },
        });

        const { configPath } = this;
        debug('configPath %s', configPath);
        debug('port %s', port);
        this.childFork = fork(verdaccioPath, ['-c', configPath, '-l', String(port)], childOptions);

        this.childFork.on('message', async (msg: any) => {
          // verdaccio_started is a message that comes from verdaccio in debug mode that
          // notify has been started
          try {
            if ('verdaccio_started' in msg) {
              const server = new ServerQuery(`http://${this.domain}:` + port);
              // const req = await server.debug();
              // req.status(HTTP_STATUS.OK);
              const user = await server.createUser(CREDENTIALS.user, CREDENTIALS.password);
              user.status(HTTP_STATUS.CREATED).body_ok(new RegExp(CREDENTIALS.user));
              // @ts-ignore
              this.token = user?.response?.body.token;
              this.authstr = buildAuthHeader(this.token as string);
              return resolve(this.childFork);
            } else {
              // eslint-disable-next-line no-console
              console.log('msg =>', msg);
            }
          } catch (e) {
            // eslint-disable-next-line prefer-promise-reject-errors
            return reject([e, this]);
          }
        });

        this.childFork.on('error', (err) => {
          debug('error  %s', err);
          // eslint-disable-next-line prefer-promise-reject-errors
          reject([err, this]);
        });
        this.childFork.on('disconnect', (err) => {
          // eslint-disable-next-line prefer-promise-reject-errors
          reject([err, this]);
        });
        this.childFork.on('exit', (err) => {
          // eslint-disable-next-line prefer-promise-reject-errors
          reject([err, this]);
        });
      });
    });
  }

  public stop(): void {
    return this.childFork.kill('SIGINT');
  }
}
