import supertest from 'supertest';

import { HEADERS, HEADER_TYPE, HTTP_STATUS } from '@verdaccio/core';

import { initializeServer, publishVersion } from './_helper';

describe('package', () => {
  let app;
  beforeEach(async () => {
    app = await initializeServer('package.yaml');
  });

  test('should return a foo private package', () => {
    return publishVersion(app, 'foo', '1.0.0').then(
      () =>
        new Promise((resolve) => {
          supertest(app)
            .get('/foo')
            .set('Accept', HEADERS.JSON)
            .expect(HEADER_TYPE.CONTENT_TYPE, HEADERS.JSON_CHARSET)
            .expect(HTTP_STATUS.OK)
            .then((response) => {
              expect(response.body.name).toEqual('foo');
              resolve(response);
            });
        })
    );
  });

  test('should return a foo private package by version', () => {
    return publishVersion(app, 'foo', '1.0.0').then(
      () =>
        new Promise((resolve) => {
          supertest(app)
            .get('/foo/1.0.0')
            .set('Accept', HEADERS.JSON)
            .expect(HEADER_TYPE.CONTENT_TYPE, HEADERS.JSON_CHARSET)
            .expect(HTTP_STATUS.OK)
            .then((response) => {
              expect(response.body.name).toEqual('foo');
              resolve(response);
            });
        })
    );
  });

  // FIXME: investigate the 404
  test('should return a package by dist-tag', (done) => {
    publishVersion(app, '@verdaccio/foo-tagged', '1.0.0').then(() => done());
    // await publishVersion(app, '@verdaccio/foo-tagged', '1.0.1', { test: '1.0.1' });
    // const response = await supertest(app)
    //   .get('/@verdaccio/foo-tagged/1.0.1')
    //   .set('Accept', HEADERS.JSON)
    //   .expect(HEADER_TYPE.CONTENT_TYPE, HEADERS.JSON_CHARSET)
    //   .expect(HTTP_STATUS.OK);

    // expect(response.body.name).toEqual('@verdaccio/foo-tagged');
  });

  // test('should return 404', async () => {
  //   return supertest(app)
  //     .get('/404-not-found')
  //     .set('Accept', HEADERS.JSON)
  //     .expect(HEADER_TYPE.CONTENT_TYPE, HEADERS.JSON_CHARSET)
  //     .expect(HTTP_STATUS.NOT_FOUND);
  // });
});
