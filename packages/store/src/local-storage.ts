import assert from 'assert';
import buildDebug from 'debug';
import _ from 'lodash';
import { PassThrough } from 'stream';
import { default as URL } from 'url';

import { errorUtils, pkgUtils, pluginUtils, searchUtils, validatioUtils } from '@verdaccio/core';
import {
  API_ERROR,
  DIST_TAGS,
  HTTP_STATUS,
  SUPPORT_ERRORS,
  USERS,
  VerdaccioError,
} from '@verdaccio/core';
import { loadPlugin } from '@verdaccio/loaders';
import LocalDatabase from '@verdaccio/local-storage';
import {
  Author,
  Callback,
  CallbackAction,
  Config,
  DistFile,
  IPackageStorage,
  Logger,
  Manifest,
  MergeTags,
  Package,
  StorageUpdateCallback,
  StringValue,
  Token,
  TokenFilter,
  Version,
} from '@verdaccio/types';
import { isObject } from '@verdaccio/utils';
import { normalizeContributors } from '@verdaccio/utils';

import {
  STORAGE,
  cleanUpReadme,
  generatePackageTemplate,
  generateRevision,
  getLatestReadme,
  normalizePackage,
} from './storage-utils';
import { tagVersion } from './versions-utils';

const debug = buildDebug('verdaccio:storage:local');

export const noSuchFile = 'ENOENT';
export const resourceNotAvailable = 'EAGAIN';
export type IPluginStorage = pluginUtils.IPluginStorage<Config>;

export function normalizeSearchPackage(
  pkg: Package,
  searchItem: searchUtils.SearchItem
): searchUtils.SearchPackageBody {
  const latest = pkgUtils.getLatest(pkg);
  const version: Version = pkg.versions[latest];
  const result: searchUtils.SearchPackageBody = {
    name: version.name,
    scope: '',
    description: version.description,
    version: latest,
    keywords: version.keywords,
    date: pkg.time[latest],
    // FIXME: type
    author: version.author as any,
    // FIXME: not possible fill this out from a private package
    publisher: {},
    // FIXME: type
    maintainers: version.maintainers as any,
    links: {
      npm: '',
      homepage: version.homepage,
      repository: version.repository,
      bugs: version.bugs,
    },
  };

  if (typeof searchItem.package.scoped === 'string') {
    result.scope = searchItem.package.scoped;
  }

  return result;
}

export const PROTO_NAME = '__proto__';

/**
 * Implements Storage interface (same for storage.js, local-storage.js, up-storage.js).
 */
class LocalStorage {
  public config: Config;
  public storagePlugin: IPluginStorage;
  public logger: Logger;

  public constructor(config: Config, logger: Logger) {
    debug('local storage created');
    this.logger = logger.child({ sub: 'fs' });
    this.config = config;
    // @ts-expect-error
    this.storagePlugin = null;
  }

  public async init() {
    if (this.storagePlugin === null) {
      this.storagePlugin = this._loadStorage(this.config, this.logger);
      debug('storage plugin init');
      await this.storagePlugin.init();
      debug('storage plugin initialized');
    } else {
      this.logger.warn('storage plugin has been already initialized');
    }
    return;
  }

  public getStoragePlugin(): IPluginStorage {
    if (this.storagePlugin === null) {
      throw errorUtils.getInternalError('storage plugin is not initialized');
    }

    return this.storagePlugin;
  }

  /**
   * Remove package with all it contents.
   * @deprecated move this to storage or abastract-storage
   */
  public async removePackage(name: string): Promise<void> {
    debug('remove package %s', name);
    const storage: any = this._getLocalStorage(name);

    if (_.isNil(storage)) {
      throw errorUtils.getNotFound();
    }

    return new Promise((resolve, reject) => {
      // FIXME: remove async from promise callback
      storage.readPackage(name, async (err, data: Package): Promise<void> => {
        if (_.isNil(err) === false) {
          if (err.code === STORAGE.NO_SUCH_FILE_ERROR || err.code === HTTP_STATUS.NOT_FOUND) {
            debug(`error on not found %o with error %o`, name, err.message);
            return reject(errorUtils.getNotFound());
          }
          return reject(err);
        }

        data = normalizePackage(data);

        try {
          await this.storagePlugin.remove(name);
          // remove each attachment
          const attachments = Object.keys(data._attachments);
          debug('attachments to remove %s', attachments?.length);
          for (let attachment of attachments) {
            debug('remove attachment %s', attachment);
            await storage.deletePackage(attachment);
          }
          // remove package.json
          debug('remove package.json');
          await storage.deletePackage(STORAGE.PACKAGE_FILE_NAME);
          // remove folder
          debug('remove package folder');
          await storage.removePackage();
          resolve();
        } catch (err: any) {
          this.logger.error({ err }, 'removed package has failed @{err.message}');
          throw errorUtils.getBadData(err.message);
        }
      });
    });
  }

  /**
    Updates the local cache with the merge from the remote/client manifest.

    The steps are the following.
    1. Get the latest version of the package from the cache.
    2. If does not exist will return a 

    @param name
    @param remoteManifest
    @returns return a merged manifest.
  */
  public async updateVersionsNext(name: string, remoteManifest: Manifest): Promise<Manifest> {
    debug(`updating versions for package %o`, name);
    let cacheManifest: Manifest = await this.readCreatePackageNext(name);
    let change = false;
    // updating readme
    cacheManifest.readme = getLatestReadme(remoteManifest);
    if (remoteManifest.readme !== cacheManifest.readme) {
      debug('manifest readme updated for %o', name);
      change = true;
    }

    debug('updating new remote versions');
    for (const versionId in remoteManifest.versions) {
      // if detect a new remote version does not exist cache
      if (_.isNil(cacheManifest.versions[versionId])) {
        debug('new version from upstream %o', versionId);
        let version = remoteManifest.versions[versionId];

        // we don't keep readme for package versions,
        // only one readme per package
        // TODO: readme clean up could be  saved in configured eventually
        version = cleanUpReadme(version);
        debug('clean up readme for %o', versionId);
        version.contributors = normalizeContributors(version.contributors as Author[]);

        change = true;
        cacheManifest.versions[versionId] = version;

        if (version?.dist?.tarball) {
          const filename = pkgUtils.extractTarballName(version.dist.tarball);
          // store a fast access to the dist file by tarball name
          // it does NOT overwrite any existing records
          if (_.isNil(cacheManifest?._distfiles[filename])) {
            const hash: DistFile = (cacheManifest._distfiles[filename] = {
              url: version.dist.tarball,
              sha: version.dist.shasum,
            });
            // store cache metadata this the manifest
            const upLink: string = version[Symbol.for('__verdaccio_uplink')];
            if (_.isNil(upLink) === false) {
              this._updateUplinkToRemoteProtocol(hash, upLink);
            }
          }
        }
      } else {
        debug('no new versions from upstream %s', name);
      }
    }

    debug('update dist-tags');
    for (const tag in remoteManifest[DIST_TAGS]) {
      if (
        !cacheManifest[DIST_TAGS][tag] ||
        cacheManifest[DIST_TAGS][tag] !== remoteManifest[DIST_TAGS][tag]
      ) {
        change = true;
        cacheManifest[DIST_TAGS][tag] = remoteManifest[DIST_TAGS][tag];
      }
    }

    for (const up in remoteManifest._uplinks) {
      if (Object.prototype.hasOwnProperty.call(remoteManifest._uplinks, up)) {
        const need_change =
          !isObject(cacheManifest._uplinks[up]) ||
          remoteManifest._uplinks[up].etag !== cacheManifest._uplinks[up].etag ||
          remoteManifest._uplinks[up].fetched !== cacheManifest._uplinks[up].fetched;

        if (need_change) {
          change = true;
          cacheManifest._uplinks[up] = remoteManifest._uplinks[up];
        }
      }
    }

    debug('update time');
    if ('time' in remoteManifest && !_.isEqual(cacheManifest.time, remoteManifest.time)) {
      cacheManifest.time = remoteManifest.time;
      change = true;
    }

    if (change) {
      debug('updating package info %o', name);
      await this.writePackageNext(name, cacheManifest);
      return cacheManifest;
    } else {
      return cacheManifest;
    }
  }

  public async addVersionNext(
    name: string,
    version: string,
    metadata: Version,
    tag: StringValue
  ): Promise<void> {
    debug(`add version %s package for %s`, version, name);
    await this.updatePackageNext(name, async (data: Manifest): Promise<Manifest> => {
      debug('%s package is being updated', name);
      // keep only one readme per package
      data.readme = metadata.readme;
      debug('%s` readme mutated', name);
      // TODO: lodash remove
      metadata = cleanUpReadme(metadata);
      metadata.contributors = normalizeContributors(metadata.contributors as Author[]);
      debug('%s` contributors normalized', name);
      const hasVersion = data.versions[version] != null;
      if (hasVersion) {
        debug('%s version %s already exists', name, version);
        throw errorUtils.getConflict();
      }

      // if uploaded tarball has a different shasum, it's very likely that we
      // have some kind of error
      if (validatioUtils.isObject(metadata.dist) && _.isString(metadata.dist.tarball)) {
        const tarball = metadata.dist.tarball.replace(/.*\//, '');

        if (validatioUtils.isObject(data._attachments[tarball])) {
          if (
            _.isNil(data._attachments[tarball].shasum) === false &&
            _.isNil(metadata.dist.shasum) === false
          ) {
            if (data._attachments[tarball].shasum != metadata.dist.shasum) {
              const errorMessage =
                `shasum error, ` +
                `${data._attachments[tarball].shasum} != ${metadata.dist.shasum}`;
              throw errorUtils.getBadRequest(errorMessage);
            }
          }

          const currentDate = new Date().toISOString();

          // some old storage do not have this field #740
          if (_.isNil(data.time)) {
            data.time = {};
          }

          data.time['modified'] = currentDate;

          if ('created' in data.time === false) {
            data.time.created = currentDate;
          }

          data.time[version] = currentDate;
          data._attachments[tarball].version = version;
        }
      }

      data.versions[version] = metadata;
      tagVersion(data, version, tag);

      try {
        debug('%s` add on database', name);
        await this.storagePlugin.add(name);
      } catch (err: any) {
        throw errorUtils.getBadData(err.message);
      }
      return data;
    });

    // this._updatePackage(
    //   name,
    //   async (data, cb: Callback): Promise<void> => {
    //     debug('%s package is being updated', name);
    //     // keep only one readme per package
    //     data.readme = metadata.readme;
    //     debug('%s` readme mutated', name);
    //     // TODO: lodash remove
    //     metadata = cleanUpReadme(metadata);
    //     metadata.contributors = normalizeContributors(metadata.contributors as Author[]);
    //     debug('%s` contributors normalized', name);
    //     const hasVersion = data.versions[version] != null;
    //     if (hasVersion) {
    //       debug('%s version %s already exists', name, version);
    //       return cb(errorUtils.getConflict());
    //     }

    //     // if uploaded tarball has a different shasum, it's very likely that we
    //     // have some kind of error
    //     if (validatioUtils.isObject(metadata.dist) && _.isString(metadata.dist.tarball)) {
    //       const tarball = metadata.dist.tarball.replace(/.*\//, '');

    //       if (validatioUtils.isObject(data._attachments[tarball])) {
    //         if (
    //           _.isNil(data._attachments[tarball].shasum) === false &&
    //           _.isNil(metadata.dist.shasum) === false
    //         ) {
    //           if (data._attachments[tarball].shasum != metadata.dist.shasum) {
    //             const errorMessage =
    //               `shasum error, ` +
    //               `${data._attachments[tarball].shasum} != ${metadata.dist.shasum}`;
    //             return cb(errorUtils.getBadRequest(errorMessage));
    //           }
    //         }

    //         const currentDate = new Date().toISOString();

    //         // some old storage do not have this field #740
    //         if (_.isNil(data.time)) {
    //           data.time = {};
    //         }

    //         data.time['modified'] = currentDate;

    //         if ('created' in data.time === false) {
    //           data.time.created = currentDate;
    //         }

    //         data.time[version] = currentDate;
    //         data._attachments[tarball].version = version;
    //       }
    //     }

    //     data.versions[version] = metadata;
    //     tagVersion(data, version, tag);

    //     try {
    //       debug('%s` add on database', name);
    //       await this.storagePlugin.add(name);
    //       cb();
    //     } catch (err: any) {
    //       cb(errorUtils.getBadData(err.message));
    //     }
    //   },
    //   callback
    // );
  }

  /**
   * Merge a new list of tags for a local packages with the existing one.
   * @param {*} pkgName
   * @param {*} tags
   * @param {*} callback
   */
  public mergeTags(pkgName: string, tags: MergeTags, callback: Callback): void {
    debug(`merge tags for`, pkgName);
    this._updatePackage(
      pkgName,
      (data, cb): void => {
        /* eslint guard-for-in: 0 */
        for (const tag in tags) {
          // this handle dist-tag rm command
          if (_.isNull(tags[tag])) {
            delete data[DIST_TAGS][tag];
            continue;
          }

          if (_.isNil(data.versions[tags[tag]])) {
            return cb(errorUtils.getNotFound(API_ERROR.VERSION_NOT_EXIST));
          }
          const version: string = tags[tag];
          tagVersion(data, version, tag);
        }
        cb(null);
      },
      callback
    );
  }

  /**
   * Update the package metadata, tags and attachments (tarballs).
   * Note: Currently supports unpublishing and deprecation.
   * @param {*} name
   * @param {*} incomingPkg
   * @param {*} revision
   * @param {*} callback
   * @return {Function}
   */
  public async changePackageNext(
    name: string,
    incomingPkg: Manifest,
    revision: string | undefined
  ): Promise<void> {
    debug(`change manifest tags for %o revision %s`, name, revision);
    if (
      !validatioUtils.isObject(incomingPkg.versions) ||
      !validatioUtils.isObject(incomingPkg[DIST_TAGS])
    ) {
      debug(`change manifest bad data for %o`, name);
      throw errorUtils.getBadData();
    }

    debug(`change manifest udapting manifest for %o`, name);
    await this.updatePackageNext(name, async (localData: Manifest): Promise<Manifest> => {
      for (const version in localData.versions) {
        const incomingVersion = incomingPkg.versions[version];
        if (_.isNil(incomingVersion)) {
          this.logger.info({ name: name, version: version }, 'unpublishing @{name}@@{version}');

          // FIXME: I prefer return a new object rather mutate the metadata
          delete localData.versions[version];
          delete localData.time![version];

          for (const file in localData._attachments) {
            if (localData._attachments[file].version === version) {
              delete localData._attachments[file].version;
            }
          }
        } else if (Object.prototype.hasOwnProperty.call(incomingVersion, 'deprecated')) {
          const incomingDeprecated = incomingVersion.deprecated;
          if (incomingDeprecated != localData.versions[version].deprecated) {
            if (!incomingDeprecated) {
              this.logger.info(
                { name: name, version: version },
                'undeprecating @{name}@@{version}'
              );
              delete localData.versions[version].deprecated;
            } else {
              this.logger.info({ name: name, version: version }, 'deprecating @{name}@@{version}');
              localData.versions[version].deprecated = incomingDeprecated;
            }
            localData.time!.modified = new Date().toISOString();
          }
        }
      }

      localData[USERS] = incomingPkg[USERS];
      localData[DIST_TAGS] = incomingPkg[DIST_TAGS];
      return localData;
    });
  }

  /**
   * Remove a tarball.
   * @param {*} name
   * @param {*} filename
   * @param {*} revision
   * @param {*} callback
   */
  public removeTarball(
    name: string,
    filename: string,
    revision: string,
    callback: CallbackAction
  ): void {
    debug('remove tarball %s for %s', filename, name);
    assert(validatioUtils.validateName(filename));
    this._updatePackage(
      name,
      (data, cb): void => {
        if (data._attachments[filename]) {
          // TODO: avoid using delete
          delete data._attachments[filename];
          cb(null);
        } else {
          cb(errorUtils.getNotFound('no such file available'));
        }
      },
      (err: VerdaccioError) => {
        if (err) {
          this.logger.error({ err }, 'remove tarball error @{err.message}');
          return callback(err);
        }
        const storage = this._getLocalStorage(name);

        if (storage) {
          debug('removing %s from storage', filename);
          storage
            .deletePackage(filename)
            .then((): void => {
              debug('package %s removed', filename);
              return callback(null);
            })
            .catch((err) => {
              this.logger.error({ err }, 'error removing %s from storage');
              return callback(null);
            });
        } else {
          callback(errorUtils.getInternalError());
        }
      }
    );
  }

  /**
   * Retrieve a package by name.
   * @param {*} name
   * @param {*} callback
   * @return {Function}
   * @deprecated use abstract this.getPackageLocalMetadata
   */
  public getPackageMetadata(name: string, callback: Callback = (): void => {}): void {
    const storage: IPackageStorage = this._getLocalStorage(name);
    debug('get package metadata for %o', name);
    if (typeof storage === 'undefined') {
      return callback(errorUtils.getNotFound());
    }

    this._readPackage(name, storage, callback);
  }

  public async search(searchStream: PassThrough, query: searchUtils.SearchQuery): Promise<void> {
    debug('search on each package');
    this.logger.info(
      { t: query.text, q: query.quality, p: query.popularity, m: query.maintenance, s: query.size },
      'search by text @{t}| maintenance @{m}| quality @{q}| popularity @{p}'
    );
    const getMetadata = (searchItem: searchUtils.SearchItem) => {
      return new Promise((resolve, reject) => {
        this.getPackageMetadata(
          searchItem?.package?.name,
          (err: VerdaccioError, pkg: Package): void => {
            if (err) {
              this.logger.error(
                { err, pkgName: searchItem?.package?.name },
                'error on load package @{pkgName} metaadata @{err.message}'
              );
              reject(err);
            }

            if (_.isEmpty(pkg?.versions)) {
              return resolve({});
            }

            const searchPackage = normalizeSearchPackage(pkg, searchItem);
            const searchPackageItem: searchUtils.SearchPackageItem = {
              package: searchPackage,
              score: searchItem.score,
              verdaccioPkgCached: searchItem.verdaccioPkgCached,
              verdaccioPrivate: searchItem.verdaccioPrivate,
              flags: searchItem?.flags,
              // FUTURE: find a better way to calculate the score
              searchScore: 1,
            };
            debug('push to stream %o', searchItem?.package?.name);
            resolve(searchPackageItem);
          }
        );
      });
    };

    if (typeof this.storagePlugin.search === 'undefined') {
      this.logger.info('plugin search not implemented yet');
      searchStream.end();
    } else {
      debug('search on each package by plugin');
      const items = await this.storagePlugin.search(query);
      try {
        for (const item of items) {
          const metadata = await getMetadata(item);
          searchStream.write(metadata);
        }
        debug('search local stream end');
        searchStream.end();
      } catch (err) {
        this.logger.error({ err, query }, 'error on search by plugin @{err.message}');
        searchStream.emit('error', err);
      }
    }
  }

  /**
   * Retrieve a wrapper that provide access to the package location.
   * @param {Object} pkgName package name.
   * @return {Object}
   * @deprecated use Abstract Storage:getPrivatePackageStorage
   */
  private _getLocalStorage(pkgName: string): IPackageStorage {
    debug('get local storage for %o', pkgName);
    return this.storagePlugin.getPackageStorage(pkgName);
  }

  /**
   * Read a json file from storage.
   * @param {Object} storage
   * @param {Function} callback
   * @deprecated
   */
  private _readPackage(name: string, storage: any, callback: Callback): void {
    storage.readPackage(name, (err, result): void => {
      if (err) {
        if (err.code === STORAGE.NO_SUCH_FILE_ERROR || err.code === HTTP_STATUS.NOT_FOUND) {
          debug('package %s not found', name);
          return callback(errorUtils.getNotFound());
        }
        return callback(this._internalError(err, STORAGE.PACKAGE_FILE_NAME, 'error reading'));
      }

      callback(err, normalizePackage(result));
    });
  }

  private async _readPackageNext(name: string, storage: any): Promise<Package> {
    try {
      const result: Package = await storage.readPackageNext(name);
      return normalizePackage(result);
    } catch (err: any) {
      if (err.code === STORAGE.NO_SUCH_FILE_ERROR || err.code === HTTP_STATUS.NOT_FOUND) {
        debug('package %s not found', name);
        throw errorUtils.getNotFound();
      }
      this.logger.error(
        { err: err, file: STORAGE.PACKAGE_FILE_NAME },
        `error reading  @{file}: @{!err.message}`
      );

      throw errorUtils.getInternalError();
    }
  }

  /**
   * Retrieve either a previous created local package or a boilerplate.
   * @param {*} pkgName
   * @param {*} callback
   * @return {Function}
   * @deprecated use readCreatePackageNext
   */
  private _readCreatePackage(pkgName: string, callback: Callback): void {
    const storage: any = this._getLocalStorage(pkgName);
    if (_.isNil(storage)) {
      return callback(errorUtils.getInternalError('storage could not be found'));
    }

    storage.readPackage(pkgName, (err, data): void => {
      // TODO: race condition
      if (_.isNil(err) === false) {
        if (err.code === STORAGE.NO_SUCH_FILE_ERROR || err.code === HTTP_STATUS.NOT_FOUND) {
          data = generatePackageTemplate(pkgName);
        } else {
          return callback(this._internalError(err, STORAGE.PACKAGE_FILE_NAME, 'error reading'));
        }
      }

      callback(null, normalizePackage(data));
    });
  }

  /**
   * Create or read a package.
   *
   * If the package already exists, it will be read.
   * If the package is not found, it will be created.
   * If the error is anything else will throw an error
   *
   * @param {*} pkgName
   * @param {*} callback
   * @return {Function}
   */
  private async readCreatePackageNext(pkgName: string): Promise<Manifest> {
    const storage: any = this._getLocalStorage(pkgName);
    if (_.isNil(storage)) {
      throw errorUtils.getInternalError('storage could not be found');
    }

    try {
      const result: Manifest = await storage.readPackageNext(pkgName);
      return normalizePackage(result);
    } catch (err: any) {
      if (err.code === STORAGE.NO_SUCH_FILE_ERROR || err.code === HTTP_STATUS.NOT_FOUND) {
        return this._createNewPackageNext(pkgName);
      } else {
        throw this._internalError(err, STORAGE.PACKAGE_FILE_NAME, 'error reading');
      }
    }
  }

  // @deprecated use _createNewPackageNext
  private _createNewPackage(name: string, callback: Callback): Callback {
    return callback(null, normalizePackage(generatePackageTemplate(name)));
  }

  private _createNewPackageNext(name: string): Manifest {
    return normalizePackage(generatePackageTemplate(name));
  }

  /**
   * Handle internal error
   * @param {*} err
   * @param {*} file
   * @param {*} message
   * @return {Object} Error instance
   */
  private _internalError(err: string, file: string, message: string): VerdaccioError {
    this.logger.error({ err: err, file: file }, `${message}  @{file}: @{!err.message}`);

    return errorUtils.getInternalError();
  }

  /**
   * @param {*} name package name
   * @param {*} updateHandler function(package, cb) - update function
   * @param {*} callback callback that gets invoked after it's all updated
   * @return {Function}
   */
  private _updatePackage(
    name: string,
    updateHandler: StorageUpdateCallback,
    onEnd: Callback
  ): void {
    const storage: IPackageStorage = this._getLocalStorage(name);

    if (!storage) {
      return onEnd(errorUtils.getNotFound());
    }

    storage.updatePackage(
      name,
      updateHandler,
      this._writePackage.bind(this),
      normalizePackage,
      onEnd
    );
  }

  /**
   * @param {*} name package name
   * @param {*} updateHandler function(package, cb) - update function
   * @param {*} callback callback that gets invoked after it's all updated
   * @return {Function}
   * // TODO: Remove, moved to abstract
   * // TODO: Remove, moved to abstract
   * // TODO: Remove, moved to abstract
   */
  private async updatePackageNext(
    name: string,
    updateHandler: (manifest: Manifest) => Promise<Manifest>
  ): Promise<void> {
    const storage: IPackageStorage = this._getLocalStorage(name);

    if (!storage) {
      throw errorUtils.getNotFound();
    }

    // we update the package on the local storage
    const updatedManifest: Package = await storage.updatePackageNext(name, updateHandler);
    // after correctly updated write to the storage
    try {
      await this.writePackageNext(name, normalizePackage(updatedManifest));
    } catch (err: any) {
      if (err.code === resourceNotAvailable) {
        throw errorUtils.getInternalError('resource temporarily unavailable');
      } else if (err.code === noSuchFile) {
        throw errorUtils.getNotFound();
      } else {
        throw err;
      }
    }
  }

  /**
   * Update the revision (_rev) string for a package.
   * @param {*} name
   * @param {*} json
   * @param {*} callback
   * @return {Function}
   * @deprecated use writePackageNext
   */
  private _writePackage(name: string, json: Package, callback: Callback): void {
    const storage: any = this._getLocalStorage(name);
    if (_.isNil(storage)) {
      return callback();
    }
    storage.savePackage(name, this._setDefaultRevision(json), callback);
  }

  // TODO: Remove, moved to abstract
  private async writePackageNext(name: string, json: Package): Promise<void> {
    const storage: any = this._getLocalStorage(name);
    if (_.isNil(storage)) {
      // TODO: replace here 500 error
      throw errorUtils.getBadData();
    }
    await storage.savePackageNext(name, this._setDefaultRevision(json));
  }

  // TODO: Remove, moved to abstract
  private _setDefaultRevision(json: Package): Package {
    // calculate revision from couch db
    if (_.isString(json._rev) === false) {
      json._rev = STORAGE.DEFAULT_REVISION;
    }

    // this is intended in debug mode we do not want modify the store revision
    if (_.isNil(this.config._debug)) {
      json._rev = generateRevision(json._rev);
    }

    return json;
  }

  // private _deleteAttachments(storage: any, attachments: string[], callback: Callback): void {
  //   debug('deleting %o attachments total %o', attachments?.length);
  //   const unlinkNext = function (cb): void {
  //     if (_.isEmpty(attachments)) {
  //       return cb();
  //     }

  //     const attachment = attachments.shift();
  //     storage.deletePackage(attachment, function (): void {
  //       unlinkNext(cb);
  //     });
  //   };

  //   unlinkNext(function (): void {
  //     // try to unlink the directory, but ignore errors because it can fail
  //     storage.removePackage(function (err): void {
  //       callback(err);
  //     });
  //   });
  // }

  /**
   * Ensure the dist file remains as the same protocol
   * @param {Object} hash metadata
   * @param {String} upLinkKey registry key
   * @private
   * @deprecated use _updateUplinkToRemoteProtocolNext
   */
  private _updateUplinkToRemoteProtocol(hash: DistFile, upLinkKey: string): void {
    // if we got this information from a known registry,
    // use the same protocol for the tarball
    const tarballUrl: any = URL.parse(hash.url);
    const uplinkUrl: any = URL.parse(this.config.uplinks[upLinkKey].url);

    if (uplinkUrl.host === tarballUrl.host) {
      tarballUrl.protocol = uplinkUrl.protocol;
      hash.registry = upLinkKey;
      hash.url = URL.format(tarballUrl);
    }
  }

  public async getSecret(config: Config): Promise<void> {
    const secretKey = await this.storagePlugin.getSecret();

    return this.storagePlugin.setSecret(config.checkSecretKey(secretKey));
  }

  private _loadStorage(config: Config, logger: Logger): IPluginStorage {
    const Storage = this._loadStorePlugin();

    if (_.isNil(Storage)) {
      assert(this.config.storage, 'CONFIG: storage path not defined');
      return new LocalDatabase(this.config, logger);
    }
    return Storage as IPluginStorage;
  }

  private _loadStorePlugin(): IPluginStorage | void {
    const plugin_params = {
      config: this.config,
      logger: this.logger,
    };

    const plugins: IPluginStorage[] = loadPlugin<IPluginStorage>(
      this.config,
      this.config.store,
      plugin_params,
      (plugin): IPluginStorage => {
        return plugin.getPackageStorage;
      }
    );

    return _.head(plugins);
  }

  public saveToken(token: Token): Promise<any> {
    if (_.isFunction(this.storagePlugin.saveToken) === false) {
      return Promise.reject(
        errorUtils.getCode(HTTP_STATUS.SERVICE_UNAVAILABLE, SUPPORT_ERRORS.PLUGIN_MISSING_INTERFACE)
      );
    }

    return this.storagePlugin.saveToken(token);
  }

  public deleteToken(user: string, tokenKey: string): Promise<any> {
    if (_.isFunction(this.storagePlugin.deleteToken) === false) {
      return Promise.reject(
        errorUtils.getCode(HTTP_STATUS.SERVICE_UNAVAILABLE, SUPPORT_ERRORS.PLUGIN_MISSING_INTERFACE)
      );
    }

    return this.storagePlugin.deleteToken(user, tokenKey);
  }

  public readTokens(filter: TokenFilter): Promise<Token[]> {
    if (_.isFunction(this.storagePlugin.readTokens) === false) {
      return Promise.reject(
        errorUtils.getCode(HTTP_STATUS.SERVICE_UNAVAILABLE, SUPPORT_ERRORS.PLUGIN_MISSING_INTERFACE)
      );
    }

    return this.storagePlugin.readTokens(filter);
  }
}

export { LocalStorage };
