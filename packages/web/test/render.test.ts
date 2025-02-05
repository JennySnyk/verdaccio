import { JSDOM } from 'jsdom';
import path from 'path';
import supertest from 'supertest';

import { HEADERS, HEADER_TYPE, HTTP_STATUS } from '@verdaccio/core';
import { setup } from '@verdaccio/logger';

import { initializeServer } from './helper';

setup([]);

const mockManifest = jest.fn();
jest.mock('@verdaccio/ui-theme', () => mockManifest());

describe('test web server', () => {
  beforeAll(() => {
    mockManifest.mockReturnValue(() => ({
      manifestFiles: {
        js: ['runtime.js', 'vendors.js', 'main.js'],
      },
      staticPath: path.join(__dirname, 'static'),
      manifest: require('./partials/manifest/manifest.json'),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
    mockManifest.mockClear();
  });

  describe('render', () => {
    describe('output', () => {
      const render = async (config = 'default-test.yaml') => {
        const response = await supertest(await initializeServer(config))
          .get('/')
          .set('Accept', HEADERS.TEXT_HTML)
          .expect(HEADER_TYPE.CONTENT_TYPE, HEADERS.TEXT_HTML_UTF8)
          .expect(HTTP_STATUS.OK);
        return new JSDOM(response.text, { runScripts: 'dangerously' });
      };

      test('should match render set ui properties', async () => {
        const {
          window: { __VERDACCIO_BASENAME_UI_OPTIONS },
        } = await render('web.yaml');
        expect(__VERDACCIO_BASENAME_UI_OPTIONS).toEqual(
          expect.objectContaining({
            showInfo: true,
            showSettings: true,
            showThemeSwitch: true,
            showFooter: true,
            showSearch: true,
            showDownloadTarball: true,
            darkMode: false,
            url_prefix: '/prefix',
            basename: '/prefix/',
            primaryColor: '#ffffff',
            // FIXME: mock these values, avoid random
            // base: 'http://127.0.0.1:60864/prefix/',
            // version: '6.0.0-6-next.28',
            logoURI: '',
            flags: { searchRemote: true },
            login: true,
            pkgManagers: ['pnpm', 'yarn'],
            title: 'verdaccio web',
            scope: '@scope',
            language: 'es-US',
          })
        );
      });

      test.todo('test default title');
      test.todo('test need html cache');
    });

    describe('status', () => {
      test('should return the http status 200 for root', async () => {
        return supertest(await initializeServer('default-test.yaml'))
          .get('/')
          .set('Accept', HEADERS.TEXT_HTML)
          .expect(HEADER_TYPE.CONTENT_TYPE, HEADERS.TEXT_HTML_UTF8)
          .expect(HTTP_STATUS.OK);
      });

      test('should return the body for a package detail page', async () => {
        return supertest(await initializeServer('default-test.yaml'))
          .get('/-/web/section/some-package')
          .set('Accept', HEADERS.TEXT_HTML)
          .expect(HEADER_TYPE.CONTENT_TYPE, HEADERS.TEXT_HTML_UTF8)
          .expect(HTTP_STATUS.OK);
      });

      test('should static file not found', async () => {
        return supertest(await initializeServer('default-test.yaml'))
          .get('/-/static/not-found.js')
          .set('Accept', HEADERS.TEXT_HTML)
          .expect(HTTP_STATUS.NOT_FOUND);
      });

      test('should static file found', async () => {
        return supertest(await initializeServer('default-test.yaml'))
          .get('/-/static/main.js')
          .set('Accept', HEADERS.TEXT_HTML)
          .expect(HTTP_STATUS.OK);
      });
    });
  });
});
