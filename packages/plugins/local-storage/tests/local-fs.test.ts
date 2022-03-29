import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

import { fileUtils } from '@verdaccio/core';
import { createTempFolder } from '@verdaccio/test-helper';
import { ILocalPackageManager, Logger, Manifest, Package } from '@verdaccio/types';

import LocalDriver, { fSError, fileExist, noSuchFile, resourceNotAvailable } from '../src/local-fs';
import pkg from './__fixtures__/pkg';

let localTempStorage: string;
const pkgFileName = 'package.json';

// returns a promise which resolves true if file exists:
function checkFileExists(filepath) {
  return new Promise((resolve) => {
    fs.access(filepath, fs.constants.F_OK, (error) => {
      resolve(!error);
    });
  });
}

const logger: Logger = {
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
  warn: jest.fn(),
  http: jest.fn(),
  trace: jest.fn(),
};

describe('Local FS test', () => {
  let tmpFolder;
  beforeEach(async () => {
    tmpFolder = await fileUtils.createTempFolder('local-fs');
    localTempStorage = path.join(tmpFolder, './_storage');
  });

  describe('savePackage() group', () => {
    test('savePackage()', (done) => {
      const data = {};
      const localFs = new LocalDriver(path.join(localTempStorage, 'first-package'), logger);

      localFs.savePackage('pkg.1.0.0.tar.gz', data as Package, (err) => {
        expect(err).toBeNull();
        done();
      });
    });
  });

  describe('readPackage() group', () => {
    test('readPackage() success', (done) => {
      const localFs: ILocalPackageManager = new LocalDriver(
        path.join(__dirname, '__fixtures__/readme-test'),
        logger
      );

      localFs.readPackage(pkgFileName, (err) => {
        expect(err).toBeNull();
        done();
      });
    });

    test('readPackage() fails', (done) => {
      const localFs: ILocalPackageManager = new LocalDriver(
        path.join(__dirname, '__fixtures__/readme-testt'),
        logger
      );

      localFs.readPackage(pkgFileName, (err) => {
        expect(err).toBeTruthy();
        done();
      });
    });

    test('readPackage() fails corrupt', (done) => {
      const localFs: ILocalPackageManager = new LocalDriver(
        path.join(__dirname, '__fixtures__/readme-test-corrupt'),
        logger
      );

      localFs.readPackage('corrupt.js', (err) => {
        expect(err).toBeTruthy();
        done();
      });
    });
  });

  describe('createPackage() group', () => {
    test('createPackage()', (done) => {
      const localFs = new LocalDriver(path.join(localTempStorage, 'createPackage'), logger);

      localFs.createPackage(path.join(localTempStorage, 'package5'), pkg, (err) => {
        expect(err).toBeNull();
        done();
      });
    });

    test('createPackage() fails by fileExist', (done) => {
      const localFs = new LocalDriver(path.join(localTempStorage, 'createPackage'), logger);

      localFs.createPackage(path.join(localTempStorage, 'package5'), pkg, () => {
        localFs.createPackage(path.join(localTempStorage, 'package5'), pkg, (err) => {
          expect(err).not.toBeNull();
          expect(err.code).toBe(fileExist);
          done();
        });
      });
    });

    describe.skip('deletePackage() group', () => {
      test('should delete a package', async () => {
        const localFs = new LocalDriver(path.join(localTempStorage, 'createPackage'), logger);
        await localFs.createPackagNext('createPackage', pkg as unknown as Manifest);
        // verdaccio removes the package.json instead the package name
        await localFs.deletePackage('package.json');
        // verify if the `package.json` does not exist anymore
        // note: the folder still remains
        await expect(checkFileExists(localFs._getStorage('package.json'))).resolves.toBeFalsy();
      });
      test('should fails on delete a package', async () => {
        const localFs = new LocalDriver(path.join(localTempStorage, 'createPackage'), logger);
        // verdaccio removes the package.json instead the package name
        await expect(localFs.deletePackage('package.json')).rejects.toThrow('ENOENT');
      });
    });
  });

  describe('removePackage() group', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(localTempStorage, '_toDelete'), { recursive: true });
    });

    test('should successfully remove the package', async () => {
      const localFs: ILocalPackageManager = new LocalDriver(
        path.join(localTempStorage, '_toDelete'),
        logger
      );

      await expect(localFs.removePackage()).resolves.toBeUndefined();
    });

    test('removePackage() fails', async () => {
      const localFs: ILocalPackageManager = new LocalDriver(
        path.join(localTempStorage, '_toDelete_fake'),
        logger
      );
      await expect(localFs.removePackage()).rejects.toThrow(/ENOENT/);
    });
  });

  describe('writeTarballNext', () => {
    test('should write a tarball', (done) => {
      const abort = new AbortController();
      const tmp = createTempFolder('local-fs-write-tarball');
      const localFs = new LocalDriver(tmp, logger);
      const readableStream = Readable.from('foooo');
      // TODO: verify file exist
      localFs.writeTarballNext('juan-1.0.0.tgz', { signal: abort.signal }).then((stream) => {
        stream.on('finish', () => {
          done();
        });
        readableStream.pipe(stream);
      });
    });
  });

  describe('readTarballNext', () => {
    test('should read a tarball', (done) => {
      const abort = new AbortController();
      const localFs = new LocalDriver(
        path.join(__dirname, '__fixtures__/readme-test-next'),
        logger
      );
      localFs.readTarballNext('test-readme-0.0.0.tgz', { signal: abort.signal }).then((stream) => {
        stream.on('data', (data) => {
          expect(data.length).toEqual(352);
        });
        stream.on('end', () => {
          done();
        });
      });
    });

    test('should aboort read a tarball', (done) => {
      const abort = new AbortController();
      const localFs = new LocalDriver(
        path.join(__dirname, '__fixtures__/readme-test-next'),
        logger
      );
      localFs.readTarballNext('test-readme-0.0.0.tgz', { signal: abort.signal }).then((stream) => {
        stream.on('error', (error: any) => {
          expect(error.code).toEqual('ABORT_ERR');
          done();
        });
        abort.abort();
      });
    });

    test('fails on read a tarball doex not exist', (done) => {
      const abort = new AbortController();

      const localFs = new LocalDriver(
        path.join(__dirname, '__fixtures__/readme-test-next'),
        logger
      );
      localFs
        .readTarballNext('does-not-exist-0.0.0.tgz', { signal: abort.signal })
        .then((stream) => {
          stream.on('error', (error: any) => {
            expect(error.code).toEqual('ENOENT');
            done();
          });
        });
    });

    test('should return content-length', (done) => {
      const localFs = new LocalDriver(
        path.join(__dirname, '__fixtures__/readme-test-next'),
        logger
      );
      const abort = new AbortController();

      localFs.readTarballNext('test-readme-0.0.0.tgz', { signal: abort.signal }).then((stream) => {
        stream.on('data', (data) => {
          expect(data.length).toEqual(352);
        });
        stream.on('content-length', (content) => {
          expect(content).toEqual(352);
          done();
        });
      });
    });
  });

  describe('readTarball (deprecated)', () => {
    test('should read tarball successfully', (done) => {
      const localFs: ILocalPackageManager = new LocalDriver(
        path.join(__dirname, '__fixtures__/readme-test'),
        logger
      );
      const readTarballStream = localFs.readTarball('test-readme-0.0.0.tgz');

      readTarballStream.on('error', function (err) {
        expect(err).toBeNull();
      });

      readTarballStream.on('content-length', function (content) {
        expect(content).toBe(352);
      });

      readTarballStream.on('end', function () {
        done();
      });

      readTarballStream.on('data', function (data) {
        expect(data).toBeDefined();
      });
    });

    test('readTarball() fails', (done) => {
      const localFs: ILocalPackageManager = new LocalDriver(
        path.join(__dirname, '__fixtures__/readme-test'),
        logger
      );
      const readTarballStream = localFs.readTarball('file-does-not-exist-0.0.0.tgz');

      readTarballStream.on('error', function (err) {
        expect(err).toBeTruthy();
        done();
      });
    });
  });

  describe('updatePackage() group', () => {
    const updateHandler = jest.fn((name, cb) => {
      cb();
    });
    const onWrite = jest.fn((name, data, cb) => {
      cb();
    });
    const transform = jest.fn();

    beforeEach(() => {
      jest.clearAllMocks();
      jest.resetModules();
    });

    test('updatePackage() success', (done) => {
      jest.doMock('@verdaccio/file-locking', () => {
        return {
          readFile: (name, _options, cb): any => cb(null, { name }),
          unlockFile: (_something, cb): any => cb(null),
        };
      });

      const LocalDriver = require('../src/local-fs').default;
      const localFs: ILocalPackageManager = new LocalDriver(
        path.join(__dirname, '__fixtures__/update-package'),
        logger
      );

      localFs.updatePackage('updatePackage', updateHandler, onWrite, transform, () => {
        expect(transform).toHaveBeenCalledTimes(1);
        expect(updateHandler).toHaveBeenCalledTimes(1);
        expect(onWrite).toHaveBeenCalledTimes(1);
        done();
      });
    });

    describe('updatePackage() failures handler', () => {
      test('updatePackage() whether locking fails', (done) => {
        jest.doMock('@verdaccio/file-locking', () => {
          return {
            readFile: (name, _options, cb): any => cb(Error('whateverError'), { name }),
            unlockFile: (_something, cb): any => cb(null),
          };
        });
        require('../src/local-fs').default;
        const localFs: ILocalPackageManager = new LocalDriver(
          path.join(__dirname, '__fixtures__/update-package'),
          logger
        );

        localFs.updatePackage('updatePackage', updateHandler, onWrite, transform, (err) => {
          expect(err).not.toBeNull();
          expect(transform).toHaveBeenCalledTimes(0);
          expect(updateHandler).toHaveBeenCalledTimes(0);
          expect(onWrite).toHaveBeenCalledTimes(0);
          done();
        });
      });

      test('updatePackage() unlock a missing package', (done) => {
        jest.doMock('@verdaccio/file-locking', () => {
          return {
            readFile: (name, _options, cb): any => cb(fSError(noSuchFile, 404), { name }),
            unlockFile: (_something, cb): any => cb(null),
          };
        });
        const LocalDriver = require('../src/local-fs').default;
        const localFs: ILocalPackageManager = new LocalDriver(
          path.join(__dirname, '__fixtures__/update-package'),
          logger
        );

        localFs.updatePackage('updatePackage', updateHandler, onWrite, transform, (err) => {
          expect(err).not.toBeNull();
          expect(transform).toHaveBeenCalledTimes(0);
          expect(updateHandler).toHaveBeenCalledTimes(0);
          expect(onWrite).toHaveBeenCalledTimes(0);
          done();
        });
      });

      test('updatePackage() unlock a resource non available', (done) => {
        jest.doMock('@verdaccio/file-locking', () => {
          return {
            readFile: (name, _options, cb): any => cb(fSError(resourceNotAvailable, 503), { name }),
            unlockFile: (_something, cb): any => cb(null),
          };
        });
        const LocalDriver = require('../src/local-fs').default;
        const localFs: ILocalPackageManager = new LocalDriver(
          path.join(__dirname, '__fixtures__/update-package'),
          logger
        );

        localFs.updatePackage('updatePackage', updateHandler, onWrite, transform, (err) => {
          expect(err).not.toBeNull();
          expect(transform).toHaveBeenCalledTimes(0);
          expect(updateHandler).toHaveBeenCalledTimes(0);
          expect(onWrite).toHaveBeenCalledTimes(0);
          done();
        });
      });

      test('updatePackage() if updateHandler fails', (done) => {
        jest.doMock('@verdaccio/file-locking', () => {
          return {
            readFile: (name, _options, cb): any => cb(null, { name }),
            unlockFile: (_something, cb): any => cb(null),
          };
        });

        const LocalDriver = require('../src/local-fs').default;
        const localFs: ILocalPackageManager = new LocalDriver(
          path.join(__dirname, '__fixtures__/update-package'),
          logger
        );
        const updateHandler = jest.fn((_name, cb) => {
          cb(fSError('something wrong', 500));
        });

        localFs.updatePackage('updatePackage', updateHandler, onWrite, transform, (err) => {
          expect(err).not.toBeNull();
          expect(transform).toHaveBeenCalledTimes(0);
          expect(updateHandler).toHaveBeenCalledTimes(1);
          expect(onWrite).toHaveBeenCalledTimes(0);
          done();
        });
      });
    });
  });
});
