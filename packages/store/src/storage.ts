import buildDebug from 'debug';
import _ from 'lodash';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';

import { API_ERROR, DIST_TAGS, HEADER_TYPE, HTTP_STATUS, errorUtils } from '@verdaccio/core';
import {
  convertDistRemoteToLocalTarballUrls,
  convertDistVersionToLocalTarballsUrl,
} from '@verdaccio/tarball';
import {
  Callback,
  CallbackAction,
  Config,
  GenericBody,
  IUploadTarball,
  Manifest,
  StringValue,
  Version,
} from '@verdaccio/types';

import AbstractStorage from './abstract-storage';
import { STORAGE } from './storage-utils';
import { IGetPackageOptionsNext } from './type';
import { getVersion } from './versions-utils';

const debug = buildDebug('verdaccio:storage');
class Storage extends AbstractStorage {
  public constructor(config: Config) {
    super(config);
    debug('uplinks available %o', Object.keys(this.uplinks));
  }

  /**
   * Add a new version of package {name} to a system
   Used storages: local (write)
   @deprecated use addVersionNext
   */
  public addVersion(
    name: string,
    version: string,
    metadata: Version,
    tag: StringValue,
    callback: CallbackAction
  ): void {
    debug('add the version %o for package %o', version, name);
    this.localStorage.addVersion(name, version, metadata, tag, callback);
  }

  /**
   * Change an existing package (i.e. unpublish one version)
   Function changes a package info from local storage and all uplinks with write access./
   Used storages: local (write)
   */
  public changePackage(
    name: string,
    metadata: Manifest,
    revision: string,
    callback: Callback
  ): void {
    debug('change existing package for package %o revision %o', name, revision);
    this.localStorage.changePackage(name, metadata, revision, callback);
  }

  /**
   * Change an existing package (i.e. unpublish one version)
   Function changes a package info from local storage and all uplinks with write access./
   Used storages: local (write)
   */
  public async changePackageNext(
    name: string,
    metadata: Manifest,
    revision: string
  ): Promise<void> {
    debug('change existing package for package %o revision %o', name, revision);
    this.localStorage.changePackageNext(name, metadata, revision);
  }

  /**
   * Remove a package from a system
   Function removes a package from local storage
   Used storages: local (write)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async removePackage(name: string, _rev: string): Promise<void> {
    // FIXME: use _rev for validate the metadata is updated
    debug('remove packagefor package %o', name);
    return this.localStorage.removePackage(name);
  }

  /**
   Remove a tarball from a system
   Function removes a tarball from local storage.
   Tarball in question should not be linked to in any existing
   versions, i.e. package version should be unpublished first.
   Used storage: local (write)
   */
  public removeTarball(
    name: string,
    filename: string,
    revision: string,
    callback: CallbackAction
  ): void {
    this.localStorage.removeTarball(name, filename, revision, callback);
  }

  /**
   * Upload a tarball for {name} package
   Function is synchronous and returns a WritableStream
   Used storages: local (write)
   */
  public addTarball(name: string, filename: string): IUploadTarball {
    debug('add tarball for package %o', name);
    return this.localStorage.addTarball(name, filename);
  }

  private async getTarballFromUpstream(name: string, filename: string, { signal }) {
    let cachedManifest: Manifest | null = null;
    try {
      cachedManifest = await this.getPackageLocalMetadata(name);
    } catch (err) {
      debug('error on get package local metadata %o', err);
    }
    // dist url should be on local cache metadata
    if (
      cachedManifest?._distfiles &&
      typeof cachedManifest?._distfiles[filename]?.url === 'string'
    ) {
      debug('dist file found, using it %o', cachedManifest?._distfiles[filename].url);
      // dist file found, proceed to download
      const distFile = cachedManifest._distfiles[filename];

      let current_length = 0;
      let expected_length;
      const passThroughRemoteStream = new PassThrough();
      const proxy = this.getUpLinkForDistFile(name, distFile);
      const remoteStream = proxy.fetchTarballNext(distFile.url, {});

      remoteStream.on('request', async () => {
        try {
          debug('remote stream request');
          const storage = this.getPrivatePackageStorage(name) as any;
          if (proxy.config.cache === true && storage) {
            const localStorageWriteStream = await storage.writeTarballNext(filename, {
              signal,
            });

            await pipeline(remoteStream, passThroughRemoteStream, localStorageWriteStream, {
              signal,
            });
          } else {
            await pipeline(remoteStream, passThroughRemoteStream, {
              signal,
            });
          }
        } catch (err: any) {
          debug('error on pipeline downloading tarball for package %o', name);
          passThroughRemoteStream.emit('error', err);
        }
      });

      remoteStream
        .on('response', async (res) => {
          if (res.statusCode === HTTP_STATUS.NOT_FOUND) {
            debug('remote stream response 404');
            passThroughRemoteStream.emit(
              'error',
              errorUtils.getNotFound(errorUtils.API_ERROR.NOT_FILE_UPLINK)
            );
            return;
          }

          if (
            !(res.statusCode >= HTTP_STATUS.OK && res.statusCode < HTTP_STATUS.MULTIPLE_CHOICES)
          ) {
            debug('remote stream response ok');
            passThroughRemoteStream.emit(
              'error',
              errorUtils.getInternalError(`bad uplink status code: ${res.statusCode}`)
            );
            return;
          }

          if (res.headers[HEADER_TYPE.CONTENT_LENGTH]) {
            expected_length = res.headers[HEADER_TYPE.CONTENT_LENGTH];
            debug('remote stream response content length %o', expected_length);
            passThroughRemoteStream.emit(
              HEADER_TYPE.CONTENT_LENGTH,
              res.headers[HEADER_TYPE.CONTENT_LENGTH]
            );
          }
        })
        .on('downloadProgress', (progress) => {
          current_length = progress.transferred;
          if (typeof expected_length === 'undefined' && progress.total) {
            expected_length = progress.total;
          }
        })
        .on('end', () => {
          if (expected_length && current_length != expected_length) {
            debug('stream end, but length mismatch %o %o', current_length, expected_length);
            passThroughRemoteStream.emit(
              'error',
              errorUtils.getInternalError(API_ERROR.CONTENT_MISMATCH)
            );
          }
          debug('remote stream end');
        })
        .on('error', (err) => {
          debug('remote stream error %o', err);
          passThroughRemoteStream.emit('error', err);
        });
      return passThroughRemoteStream;
    } else {
      debug('dist file not found, proceed update upstream');
      // no dist url found, proceed to fetch from upstream
      // should not be the case
      const passThroughRemoteStream = new PassThrough();
      // ensure get the latest data
      const [updatedManifest] = await this.syncUplinksMetadataNext(name, cachedManifest, {
        uplinksLook: true,
      });
      const distFile = (updatedManifest as Manifest)._distfiles[filename];

      if (updatedManifest === null || !distFile) {
        debug('remote tarball not found');
        throw errorUtils.getNotFound(API_ERROR.NO_SUCH_FILE);
      }

      const proxy = this.getUpLinkForDistFile(name, distFile);
      const remoteStream = proxy.fetchTarballNext(distFile.url, {});
      remoteStream.on('response', async () => {
        try {
          const storage = this.getPrivatePackageStorage(name);
          if (proxy.config.cache === true && storage) {
            debug('cache remote tarball enabled');
            const localStorageWriteStream = await storage.writeTarballNext(filename, {
              signal,
            });
            await pipeline(remoteStream, passThroughRemoteStream, localStorageWriteStream, {
              signal,
            });
          } else {
            debug('cache remote tarball disabled');
            await pipeline(remoteStream, passThroughRemoteStream, { signal });
          }
        } catch (err) {
          debug('error on pipeline downloading tarball for package %o', name);
          passThroughRemoteStream.emit('error', err);
        }
      });
      return passThroughRemoteStream;
    }
  }

  /**
   *
   * @param name
   * @param filename
   * @param param2
   * @returns
   */
  public async getTarballNext(name: string, filename: string, { signal }): Promise<PassThrough> {
    debug('get tarball for package %o filename %o', name, filename);
    // TODO: check if isOpen is need it after all.
    let isOpen = false;
    const localTarballStream = new PassThrough();
    const localStream = await this.getLocalTarball(name, filename, { signal });
    localStream.on('open', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      isOpen = true;
      await pipeline(localStream, localTarballStream, { signal });
    });

    localStream.on('error', (err: any) => {
      // eslint-disable-next-line no-console
      if (err.code === STORAGE.NO_SUCH_FILE_ERROR || err.code === HTTP_STATUS.NOT_FOUND) {
        this.getTarballFromUpstream(name, filename, { signal })
          .then((uplinkStream) => {
            pipeline(uplinkStream, localTarballStream, { signal })
              .then(() => {
                debug('successfully downloaded tarball for package %o filename %o', name, filename);
              })
              .catch((err) => {
                localTarballStream.emit('error', err);
              });
          })
          .catch((err) => {
            localTarballStream.emit('error', err);
          });
      } else {
        this.logger.error({ err: err.message }, 'some error on fatal @{err}');
        localTarballStream.emit('error', err);
      }
    });

    return localTarballStream;
  }

  public async getPackageByVersion(options: IGetPackageOptionsNext): Promise<Version> {
    const queryVersion = options.version as string;
    if (_.isNil(queryVersion)) {
      throw errorUtils.getNotFound(`${API_ERROR.VERSION_NOT_EXIST}: ${queryVersion}`);
    }

    // we have version, so we need to return specific version
    const [convertedManifest] = await this.getPackageNext(options);

    const version: Version | undefined = getVersion(convertedManifest.versions, queryVersion);

    debug('query by latest version %o and result %o', queryVersion, version);
    if (typeof version !== 'undefined') {
      debug('latest version found %o', version);
      return convertDistVersionToLocalTarballsUrl(
        convertedManifest.name,
        version,
        options.requestOptions,
        this.config.url_prefix
      );
    }

    // the version could be a dist-tag eg: beta, alpha, so we find the matched version
    // on disg-tag list
    if (_.isNil(convertedManifest[DIST_TAGS]) === false) {
      if (_.isNil(convertedManifest[DIST_TAGS][queryVersion]) === false) {
        // the version found as a distag
        const matchedDisTagVersion: string = convertedManifest[DIST_TAGS][queryVersion];
        debug('dist-tag version found %o', matchedDisTagVersion);
        const disTagVersion: Version | undefined = getVersion(
          convertedManifest.versions,
          matchedDisTagVersion
        );
        if (typeof disTagVersion !== 'undefined') {
          debug('dist-tag found %o', disTagVersion);
          return convertDistVersionToLocalTarballsUrl(
            convertedManifest.name,
            disTagVersion,
            options.requestOptions,
            this.config.url_prefix
          );
        }
      }
    } else {
      debug('dist tag not detected');
    }

    // we didn't find the version, not found error
    debug('package version not found %o', queryVersion);
    throw errorUtils.getNotFound(`${API_ERROR.VERSION_NOT_EXIST}: ${queryVersion}`);
  }

  public async getPackageManifest(options: IGetPackageOptionsNext): Promise<Manifest> {
    // convert dist remotes to local bars
    const [manifest] = await this.getPackageNext(options);
    const convertedManifest = convertDistRemoteToLocalTarballUrls(
      manifest,
      options.requestOptions,
      this.config.url_prefix
    );

    return convertedManifest;
  }

  /**
   * Return a manifest or version based on the options.
   * @param options {Object}
   * @returns A package manifest or specific version
   */
  public async getPackageByOptions(options: IGetPackageOptionsNext): Promise<Manifest | Version> {
    // if no version we return the whole manifest
    if (_.isNil(options.version) === false) {
      return this.getPackageByVersion(options);
    } else {
      return this.getPackageManifest(options);
    }
  }

  /**
   * Retrieve only private local packages
   * @param {*} callback
   */
  public getLocalDatabase(callback: Callback): void {
    const self = this;
    debug('get local database');
    if (this.localStorage.storagePlugin !== null) {
      this.localStorage.storagePlugin
        .get()
        .then((locals) => {
          const packages: Version[] = [];
          const getPackage = function (itemPkg): void {
            self.localStorage.getPackageMetadata(
              locals[itemPkg],
              function (err, pkgMetadata: Manifest): void {
                if (_.isNil(err)) {
                  const latest = pkgMetadata[DIST_TAGS].latest;
                  if (latest && pkgMetadata.versions[latest]) {
                    const version: Version = pkgMetadata.versions[latest];
                    const timeList = pkgMetadata.time as GenericBody;
                    const time = timeList[latest];
                    // @ts-ignore
                    version.time = time;

                    // Add for stars api
                    // @ts-ignore
                    version.users = pkgMetadata.users;

                    packages.push(version);
                  } else {
                    self.logger.warn(
                      { package: locals[itemPkg] },
                      'package @{package} does not have a "latest" tag?'
                    );
                  }
                }

                if (itemPkg >= locals.length - 1) {
                  callback(null, packages);
                } else {
                  getPackage(itemPkg + 1);
                }
              }
            );
          };

          if (locals.length) {
            getPackage(0);
          } else {
            callback(null, []);
          }
        })
        .catch((err) => {
          callback(err);
        });
    } else {
      debug('local stora instance is null');
    }
  }
}

export { Storage };
