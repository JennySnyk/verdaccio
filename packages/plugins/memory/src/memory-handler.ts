/* eslint-disable @typescript-eslint/no-unused-vars */
import buildDebug from 'debug';
import { fs } from 'memfs';
import { Stats } from 'memfs/lib/Stats';
import path from 'path';
import { PassThrough, Writable, addAbortSignal } from 'stream';
import { pipeline } from 'stream/promises';

import { VerdaccioError, errorUtils } from '@verdaccio/core';
import { ReadTarball, UploadTarball } from '@verdaccio/streams';
import {
  CallbackAction,
  IPackageStorageManager,
  IReadTarball,
  IUploadTarball,
  Logger,
  Manifest,
  Package,
  PackageTransformer,
  ReadPackageCallback,
  StorageUpdateCallback,
  StorageWriteCallback,
} from '@verdaccio/types';

import { parsePackage, stringifyPackage } from './utils';

const debug = buildDebug('verdaccio:plugin:storage:memory-storage');

function fstatPromise(fd): Promise<Stats | undefined> {
  return new Promise((resolve, reject) => {
    fs.fstat(fd, function (err, stats) {
      if (err) {
        return reject(err);
      }
      return resolve(stats);
    });
  });
}

export type DataHandler = {
  [key: string]: string;
};

class MemoryHandler implements IPackageStorageManager {
  private data: DataHandler;
  private name: string;
  private path: string;
  public logger: Logger;

  public constructor(packageName: string, data: DataHandler, logger: Logger) {
    // this is not need it
    this.data = data;
    this.name = packageName;
    this.logger = logger;
    this.path = `/${packageName}`;
    debug('initialized');
  }

  public updatePackage(
    pkgFileName: string,
    updateHandler: StorageUpdateCallback,
    onWrite: StorageWriteCallback,
    transformPackage: PackageTransformer,
    onEnd: CallbackAction
  ): void {
    const json: string = this._getStorage(pkgFileName);
    let pkg: Package;

    try {
      pkg = parsePackage(json) as Package;
    } catch (err: any) {
      return onEnd(err);
    }

    updateHandler(pkg, (err: VerdaccioError) => {
      if (err) {
        return onEnd(err);
      }
      try {
        onWrite(pkgFileName, transformPackage(pkg), onEnd);
      } catch (err: any) {
        return onEnd(errorUtils.getInternalError('error on parse the metadata'));
      }
    });
  }

  public async writeTarballNext(pkgName: string, { signal }): Promise<Writable> {
    // @ts-ignore
    return new WritableStream({ write: () => {} });
  }

  public async hasTarball(fileName: string): Promise<boolean> {
    throw new Error('not  implemented');
  }

  public async hasPackage(): Promise<boolean> {
    return false;
  }

  public deletePackage(pkgName: string) {
    delete this.data[pkgName];
    return Promise.resolve();
  }

  public removePackage() {
    return Promise.resolve();
  }

  public async createPackageNext(name: string, manifest: Manifest): Promise<void> {
    return;
  }

  public createPackage(name: string, value: Package, cb: CallbackAction): void {
    debug('create package %o', name);
    this.savePackage(name, value, cb);
  }

  public savePackage(name: string, value: Package, cb: CallbackAction): void {
    try {
      debug('save package %o', name);
      this.data[name] = stringifyPackage(value);
      return cb(null);
    } catch (err: any) {
      return cb(errorUtils.getInternalError(err.message));
    }
  }

  public async readPackageNext(name: string): Promise<Package> {
    const json = this._getStorage(name);
    try {
      return typeof json === 'undefined' ? errorUtils.getNotFound() : null, parsePackage(json);
    } catch (err: any) {
      throw errorUtils.getNotFound();
    }
  }

  public readPackage(name: string, cb: ReadPackageCallback): void {
    debug('read package %o', name);
    const json = this._getStorage(name);
    const isJson = typeof json === 'undefined';

    try {
      return cb(isJson ? errorUtils.getNotFound() : null, parsePackage(json));
    } catch (err: any) {
      return cb(errorUtils.getNotFound());
    }
  }

  public writeTarball(name: string): IUploadTarball {
    const uploadStream: IUploadTarball = new UploadTarball({});
    const temporalName = `${this.path}/${name}`;
    debug('write tarball %o', temporalName);

    process.nextTick(function () {
      fs.mkdirp(path.dirname(temporalName), (mkdirpError) => {
        if (mkdirpError) {
          return uploadStream.emit('error', mkdirpError);
        }
        fs.stat(temporalName, function (fileError, stats) {
          if (!fileError && stats) {
            return uploadStream.emit('error', errorUtils.getConflict());
          }

          try {
            const file = fs.createWriteStream(temporalName);

            uploadStream.pipe(file);

            uploadStream.done = function (): void {
              const onEnd = function (): void {
                uploadStream.emit('success');
              };

              uploadStream.on('end', onEnd);
            };

            uploadStream.abort = function (): void {
              uploadStream.emit('error', errorUtils.getBadRequest('transmision aborted'));
              file.end();
            };

            uploadStream.emit('open');
            return;
          } catch (err: any) {
            uploadStream.emit('error', err);
            return;
          }
        });
      });
    });

    return uploadStream;
  }

  public async readTarballNext(pkgName: string, { signal }): Promise<PassThrough> {
    const pathName: string = this._getStorage(pkgName);
    const passStream = new PassThrough();
    const readStream = addAbortSignal(signal, fs.createReadStream(pathName));
    readStream.on('open', async function (fileDescriptor) {
      const stats = await fstatPromise(fileDescriptor);
      passStream.emit('content-length', stats?.size);
    });
    readStream.on('error', (err) => {
      passStream.emit('error', err);
    });

    await pipeline(readStream, passStream);

    return passStream;
  }

  public readTarball(name: string): IReadTarball {
    const pathName = `${this.path}/${name}`;
    debug('read tarball %o', pathName);

    const readTarballStream: IReadTarball = new ReadTarball({});

    process.nextTick(function () {
      fs.stat(pathName, function (error, stats) {
        if (error && !stats) {
          return readTarballStream.emit('error', errorUtils.getNotFound());
        }

        try {
          const readStream = fs.createReadStream(pathName);

          readTarballStream.emit('content-length', stats?.size);
          readTarballStream.emit('open');
          readStream.pipe(readTarballStream);
          readStream.on('error', (error: VerdaccioError) => {
            readTarballStream.emit('error', error);
          });

          readTarballStream.abort = function (): void {
            readStream.destroy(errorUtils.getBadRequest('read has been aborted'));
          };
          return;
        } catch (err: any) {
          readTarballStream.emit('error', err);
          return;
        }
      });
    });

    return readTarballStream;
  }

  private _getStorage(name = ''): string {
    debug('get storage %o', name);
    return this.data[name];
  }

  // migration pending
  public async updatePackageNext(
    packageName: string,
    handleUpdate: (manifest: Package) => Promise<Package>
  ): Promise<Package> {
    debug(packageName);
    // @ts-expect-error
    await handleUpdate({});
    // @ts-expect-error
    return Promise.resolve({});
  }

  public async savePackageNext(name: string, value: Package): Promise<void> {
    debug(name);
    debug(value);
  }
}

export default MemoryHandler;
