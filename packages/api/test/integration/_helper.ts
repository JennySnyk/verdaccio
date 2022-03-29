import { Application } from 'express';
import path from 'path';
import supertest from 'supertest';

import { parseConfigFile } from '@verdaccio/config';
import { HEADERS, HEADER_TYPE, HTTP_STATUS } from '@verdaccio/core';
import { setup } from '@verdaccio/logger';
import { Storage } from '@verdaccio/store';
import {
  generatePackageMetadata,
  initializeServer as initializeServerHelper,
} from '@verdaccio/test-helper';
import { GenericBody } from '@verdaccio/types';
import { generateRandomHexString } from '@verdaccio/utils';

import apiMiddleware from '../../src';

setup();

export const getConf = (conf) => {
  const configPath = path.join(__dirname, 'config', conf);
  const config = parseConfigFile(configPath);
  // custom config to avoid conflict with other tests
  config.auth.htpasswd.file = `${config.auth.htpasswd.file}-${generateRandomHexString()}`;
  return config;
};

export async function initializeServer(configName): Promise<Application> {
  return initializeServerHelper(getConf(configName), [apiMiddleware], Storage);
}

export function createUser(app, name: string, password: string): supertest.Test {
  return supertest(app)
    .put(`/-/user/org.couchdb.user:${name}`)
    .send({
      name: name,
      password: password,
    })
    .expect(HEADER_TYPE.CONTENT_TYPE, HEADERS.JSON_CHARSET)
    .expect(HTTP_STATUS.CREATED);
}

export function publishVersion(
  app,
  pkgName: string,
  version: string,
  distTags?: GenericBody
): supertest.Test {
  const pkgMetadata = generatePackageMetadata(pkgName, version, distTags);

  return supertest(app)
    .put(`/${encodeURIComponent(pkgName)}`)
    .set(HEADER_TYPE.CONTENT_TYPE, HEADERS.JSON)
    .send(JSON.stringify(pkgMetadata))
    .set('accept', HEADERS.GZIP)
    .set(HEADER_TYPE.ACCEPT_ENCODING, HEADERS.JSON)
    .set(HEADER_TYPE.CONTENT_TYPE, HEADERS.JSON);
}
