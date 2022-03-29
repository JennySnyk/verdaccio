/* eslint-disable @typescript-eslint/no-unused-vars */
import assert from 'assert';
import buildDebug from 'debug';
import _, { isNil } from 'lodash';
import { PassThrough, Readable, Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';

import { hasProxyTo } from '@verdaccio/config';
import { API_ERROR, DIST_TAGS, HTTP_STATUS, errorUtils, validatioUtils } from '@verdaccio/core';
import { logger } from '@verdaccio/logger';
import { IProxy, ISyncUplinksOptions, ProxyList, ProxyStorage } from '@verdaccio/proxy';
import {
  Author,
  Callback,
  CallbackAction,
  Config,
  DistFile,
  GenericBody,
  IPackageStorage,
  IPackageStorageManager,
  IReadTarball,
  IUploadTarball,
  Logger,
  Manifest,
  MergeTags,
  Package,
  StringValue,
  Token,
  TokenFilter,
  Version,
} from '@verdaccio/types';
import { createTarballHash, getLatestVersion, normalizeContributors } from '@verdaccio/utils';

import {
  PublishOptions,
  UpdateManifestOptions,
  cleanUpReadme,
  isDeprecatedManifest,
  tagVersion,
  tagVersionNext,
} from '.';
import { LocalStorage } from './local-storage';
import { SearchManager } from './search';
import { isPublishablePackage } from './star-utils';
import {
  STORAGE,
  cleanUpLinksRef,
  generatePackageTemplate,
  generateRevision,
  mergeUplinkTimeIntoLocal,
  mergeUplinkTimeIntoLocalNext,
  mergeVersions,
  normalizeDistTags,
  normalizePackage,
  updateUpLinkMetadata,
} from './storage-utils';
import { IGetPackageOptionsNext, IPluginFilters } from './type';
import { ProxyInstanceList, setupUpLinks, updateVersionsHiddenUpLinkNext } from './uplink-util';

const debug = buildDebug('verdaccio:storage:abstract');

export const noSuchFile = 'ENOENT';
export const resourceNotAvailable = 'EAGAIN';
export const PROTO_NAME = '__proto__';

class AbstractStorage {
  public localStorage: LocalStorage;
  public searchManager: SearchManager | null;
  public filters: IPluginFilters;
  public readonly config: Config;
  public readonly logger: Logger;
  public readonly uplinks: ProxyInstanceList;
  public constructor(config: Config) {
    this.config = config;
    this.uplinks = setupUpLinks(config);
    this.logger = logger.child({ module: 'storage' });
    this.filters = [];
    // @ts-ignore
    this.localStorage = null;
    this.searchManager = null;
  }

  /**
   * Initialize the storage asyncronously.
   * @param config Config
   * @param filters IPluginFilters
   * @returns Storage instance
   */
  public async init(config: Config, filters: IPluginFilters = []): Promise<void> {
    if (this.localStorage === null) {
      this.filters = filters || [];
      debug('filters available %o', filters);
      this.localStorage = new LocalStorage(this.config, logger);
      await this.localStorage.init();
      debug('local init storage initialized');
      await this.localStorage.getSecret(config);
      debug('local storage secret initialized');
      this.searchManager = new SearchManager(this.uplinks, this.localStorage);
    } else {
      debug('storage has been already initialized');
    }
    return;
  }

  /**
   * Retrieve a wrapper that provide access to the package location.
   * @param {Object} pkgName package name.
   * @return {Object}
   */
  protected getPrivatePackageStorage(pkgName: string): IPackageStorage {
    debug('get local storage for %o', pkgName);
    return this.localStorage.getStoragePlugin().getPackageStorage(pkgName);
  }

  /**
   * Create a tarball stream from a package.
   * @param name
   * @param filename
   * @param options
   * @returns
   */
  public async getLocalTarball(
    pkgName: string,
    filename: string,
    { signal }: { signal: AbortSignal }
  ): Promise<Readable> {
    assert(validatioUtils.validateName(filename));
    const storage: IPackageStorage = this.getPrivatePackageStorage(pkgName);
    if (typeof storage === 'undefined') {
      return this.createFailureStreamResponseNext();
    }

    return await storage.readTarballNext(filename, { signal });
  }

  /**
   * Get a package local manifest.
   *
   * Fails if package is not found.
   * @param name package name
   * @param revision of package
   * @returns local manifest
   */
  public async getPackageLocalMetadata(name: string, revision?: string): Promise<Manifest> {
    const storage: IPackageStorage = this.getPrivatePackageStorage(name);
    debug('get package metadata for %o', name);
    if (typeof storage === 'undefined') {
      throw errorUtils.getNotFound();
    }

    try {
      const result: Manifest = await storage.readPackageNext(name);
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
   * Fail the stream response with an not found error.
   * @returns
   */
  private createFailureStreamResponseNext(): PassThrough {
    const stream: PassThrough = new PassThrough();

    // we ensure fails on the next tick into the event loop
    process.nextTick((): void => {
      stream.emit('error', errorUtils.getNotFound(API_ERROR.NO_SUCH_FILE));
    });

    return stream;
  }

  public readTokens(filter: TokenFilter): Promise<Token[]> {
    return this.localStorage.readTokens(filter);
  }

  public saveToken(token: Token): Promise<void> {
    return this.localStorage.saveToken(token);
  }

  public deleteToken(user: string, tokenKey: string): Promise<any> {
    return this.localStorage.deleteToken(user, tokenKey);
  }

  /**
   * Update a package and merge tags
   * @param name package name
   * @param tags list of dist-tags
   */
  public async mergeTagsNext(name: string, tags: MergeTags): Promise<Manifest> {
    return await this.updatePackageNext(name, async (data: Manifest): Promise<Manifest> => {
      let newData: Manifest = { ...data };
      for (const tag of Object.keys(tags)) {
        // this handle dist-tag rm command
        if (_.isNull(tags[tag])) {
          delete newData[DIST_TAGS][tag];
          continue;
        }

        if (_.isNil(newData.versions[tags[tag]])) {
          throw errorUtils.getNotFound(API_ERROR.VERSION_NOT_EXIST);
        }
        const version: string = tags[tag];
        newData = tagVersionNext(newData, version, tag);
      }

      return newData;
    });
  }

  /**
   * Tags a package version with a provided tag
     Used storages: local (write)
   */
  public mergeTags(name: string, tagHash: MergeTags, callback: CallbackAction): void {
    debug('merge tags for package %o tags %o', name, tagHash);
    this.localStorage.mergeTags(name, tagHash, callback);
  }

  protected getUpLinkForDistFile(pkgName: string, distFile: DistFile): IProxy {
    let uplink: IProxy | null = null;

    for (const uplinkId in this.uplinks) {
      // refer to https://github.com/verdaccio/verdaccio/issues/1642
      if (hasProxyTo(pkgName, uplinkId, this.config.packages)) {
        uplink = this.uplinks[uplinkId];
      }
    }

    if (uplink == null) {
      debug('upstream not found creating one for %o', pkgName);
      uplink = new ProxyStorage(
        {
          url: distFile.url,
          cache: true,
        },
        this.config
      );
    }
    return uplink;
  }

  public async updateLocalMetadata(pkgName: string) {
    const storage = this.getPrivatePackageStorage(pkgName);

    if (!storage) {
      throw errorUtils.getNotFound();
    }
  }

  public async updateManifest(manifest: Manifest, options: UpdateManifestOptions): Promise<void> {
    if (isDeprecatedManifest(manifest)) {
      // if the manifest is deprecated, we need to update the package.json
      await this.deprecate(manifest, {
        ...options,
      });
    } else if (
      isPublishablePackage(manifest) === false &&
      validatioUtils.isObject(manifest.users)
    ) {
      // if user request to apply a star to the manifest
      await this.star(manifest, {
        ...options,
      });
    } else if (validatioUtils.validatePublishSingleVersion(manifest)) {
      // if continue, the version to be published does not exist
      // we create a new package
      const [mergedManifest, version] = await this.publishANewVersion(manifest, {
        ...options,
      });
      // send notification of publication (notification step, non transactional)
      try {
        const { name } = mergedManifest;
        await this.notify(mergedManifest, `${name}@${version}`);
        logger.info({ name, version }, 'notify for @{name}@@{version} has been sent');
      } catch (error: any) {
        logger.error({ error: error.message }, 'notify batch service has failed: @{error}');
      }
    } else {
      debug('invalid body format');
      logger.info(
        { packageName: options.name },
        `wrong package format on publish a package @{packageName}`
      );
      throw errorUtils.getBadRequest(API_ERROR.UNSUPORTED_REGISTRY_CALL);
    }
  }

  protected async deprecate(body: Manifest, options: PublishOptions): Promise<void> {
    // // const storage: IPackageStorage = this.getPrivatePackageStorage(opname);

    // if (typeof storage === 'undefined') {
    //   throw errorUtils.getNotFound();
    // }
    throw errorUtils.getInternalError('no implemenation ready for npm deprecate');
  }

  protected async star(body: Manifest, options: PublishOptions): Promise<void> {
    // // const storage: IPackageStorage = this.getPrivatePackageStorage(opname);

    // if (typeof storage === 'undefined') {
    //   throw errorUtils.getNotFound();
    // }

    throw errorUtils.getInternalError('no implemenation ready for npm star');
  }

  /**
   * Get local package, on fails return null.
   * Errors are considered package not found.
   * @param name
   * @returns
   */
  private async getPackagelocalByNameNext(name: string): Promise<Manifest | null> {
    try {
      return await this.getPackageLocalMetadata(name);
    } catch (err: any) {
      debug('local package %s not found', name);
      return null;
    }
  }

  /**
   * Convert tarball as string into a Buffer and validate the length.
   * @param data the tarball data as string
   * @returns
   */
  private getBufferManifest(data: string): Buffer {
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) {
      throw errorUtils.getBadData('refusing to accept zero-length file');
    }
    return buffer;
  }

  /**
   * Verify if the package exists in the local storage
   * (the package refers to the package.json), directory would return false.
   * @param pkgName package name
   * @returns boolean
   */
  private async hasPackage(pkgName: string): Promise<boolean> {
    const storage: IPackageStorage = this.getPrivatePackageStorage(pkgName);
    if (typeof storage === 'undefined') {
      throw errorUtils.getNotFound();
    }
    const hasPackage = await storage.hasPackage();
    debug('has package %o for %o', pkgName, hasPackage);
    return hasPackage;
  }

  /**
   * Create a new package.
   * This situation happens only of the package does not exist on the cache.
   *
   * @param body package metadata
   * @param options
   * @returns
   */
  protected async publishANewVersion(
    body: Manifest,
    options: PublishOptions
  ): Promise<[Manifest, string]> {
    const { name } = options;
    debug('publishing a new package for %o', name);
    const manifest: Manifest = { ...validatioUtils.validateMetadata(body, name) };
    const { _attachments, versions } = manifest;
    // get the unique version available
    const [versionToPublish] = Object.keys(versions);

    // at this point document is either created or existed before
    const [firstAttachmentKey] = Object.keys(_attachments);
    const buffer = this.getBufferManifest(body._attachments[firstAttachmentKey].data as string);

    try {
      // we check if package exist already locally
      const manifest = await this.getPackagelocalByNameNext(name);
      // if continue, the version to be published does not exist
      if (manifest?.versions[versionToPublish] != null) {
        debug('%s version %s already exists', name, versionToPublish);
        throw errorUtils.getConflict();
      }

      // if execution get here, package does not exist locally, we search upstream
      const remoteManifest = await this.checkPackageRemote(name, this.isAllowPublishOffline());
      if (remoteManifest?.versions[versionToPublish] != null) {
        debug('%s version %s already exists', name, versionToPublish);
        throw errorUtils.getConflict();
      }

      const hasPackageInStorage = await this.hasPackage(name);
      if (!hasPackageInStorage) {
        await this.createNewLocalCachePackage(name, versionToPublish);
      }
    } catch (err: any) {
      debug('error on change or update a package with %o', err.message);
      logger.error({ err: err.message }, 'error on create package: @{err}');
      throw err;
    }

    // 1. after tarball has been successfully uploaded, we update the version
    try {
      // TODO: review why do this
      versions[versionToPublish].readme =
        _.isNil(manifest.readme) === false ? String(manifest.readme) : '';
      await this.addVersionNext(name, versionToPublish, versions[versionToPublish], null);
    } catch (err: any) {
      logger.error({ err: err.message }, 'updated version has failed: @{err}');
      debug('error on create a version for %o with error %o', name, err.message);
      // TODO: remove tarball if add version fails
      throw err;
    }

    // 2. update and merge tags
    let mergedManifest;
    try {
      // note: I could merge this with addVersionNext
      // 1. add version
      // 2. merge versions
      // 3. upload tarball
      // 3.update once to the storage (easy peasy)
      mergedManifest = await this.mergeTagsNext(name, manifest[DIST_TAGS]);
    } catch (err: any) {
      logger.error({ err: err.message }, 'merge version has failed: @{err}');
      debug('error on create a version for %o with error %o', name, err.message);
      // TODO: undo if this fails
      // 1. remove tarball
      // 2. remove updated version
      throw err;
    }

    // 3. upload the tarball to the storage
    try {
      const readable = Readable.from(buffer);
      await this.uploadTarball(name, firstAttachmentKey, readable, {
        signal: options.signal,
      });
    } catch (err: any) {
      logger.error({ err: err.message }, 'upload tarball has failed: @{err}');
      throw err;
    }

    logger.info(
      { name, version: versionToPublish },
      'package @{name}@@{version} has been published'
    );

    return [mergedManifest, versionToPublish];
  }

  // TODO: pending implementation
  private async notify(manifest: Manifest, message: string): Promise<void> {
    return;
  }

  /**
   * Wrap uploadTarballAsStream into a promise.
   * @param name package name
   * @param fileName tarball name
   * @param contentReadable content as readable stream
   * @param options
   * @returns
   */
  public async uploadTarball(
    name: string,
    fileName: string,
    contentReadable: Readable,
    { signal }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      (async () => {
        const stream: Writable = await this.uploadTarballAsStream(name, fileName, {
          signal,
        });

        stream.on('error', (err) => {
          debug(
            'error on stream a tarball %o for %o with error %o',
            'foo.tar.gz',
            name,
            err.message
          );
          reject(err);
        });
        stream.on('success', () => {
          this.logger.debug(
            { fileName, name },
            'file @{fileName} for package @{name} has been succesfully uploaded'
          );
          resolve();
        });

        await pipeline(contentReadable, stream, { signal });
      })().catch((err) => {
        reject(err);
      });
    });
  }

  public async uploadTarballAsStream(
    pkgName: string,
    filename: string,
    { signal }
  ): Promise<PassThrough> {
    debug(`add a tarball for %o`, pkgName);
    assert(validatioUtils.validateName(filename));

    const shaOneHash = createTarballHash();
    const transformHash = new Transform({
      transform(chunk: any, encoding: string, callback: any): void {
        // measure the length for validation reasons
        shaOneHash.update(chunk);
        callback(null, chunk);
      },
    });
    const uploadStream = new PassThrough();
    const storage = this.getPrivatePackageStorage(pkgName);

    // FUTURE: this validation could happen even before
    if (pkgName === PROTO_NAME) {
      process.nextTick((): void => {
        uploadStream.emit('error', errorUtils.getForbidden());
      });
      return uploadStream;
    }

    // FIXME: this condition will never met, storage is always defined
    if (!storage) {
      process.nextTick((): void => {
        uploadStream.emit('error', "can't upload this package storage is missing");
      });
      return uploadStream;
    }

    const fileDoesExist = await storage.hasTarball(filename);
    if (fileDoesExist) {
      process.nextTick((): void => {
        uploadStream.emit('error', errorUtils.getConflict());
      });
    } else {
      const localStorageWriteStream = await storage.writeTarballNext(filename, { signal });

      localStorageWriteStream.on('open', async () => {
        await pipeline(uploadStream, transformHash, localStorageWriteStream, { signal });
      });

      // once the file descriptor has been closed
      localStorageWriteStream.on('close', async () => {
        try {
          debug('uploaded tarball %o for %o', filename, pkgName);
          // update the package metadata
          await this.updatePackageNext(pkgName, async (data: Manifest): Promise<Manifest> => {
            const newData: Manifest = { ...data };
            debug('added _attachment for %o', pkgName);
            newData._attachments[filename] = {
              // TODO:  add integrity hash here
              shasum: shaOneHash.digest('hex'),
            };

            return newData;
          });
          debug('emit success for %o', pkgName);
          uploadStream.emit('success');
        } catch (err: any) {
          // FUTURE: if the update package fails, remove tarball to avoid left
          // orphan tarballs
          debug(
            'something has failed on upload tarball %o for %o : %s',
            filename,
            pkgName,
            err.message
          );
          uploadStream.emit('error', err);
        }
      });

      // something went wrong writing into the local storage
      localStorageWriteStream.on('error', async (err: any) => {
        uploadStream.emit('error', err);
      });
    }

    return uploadStream;
  }

  /**
   * Add a new version to a package.
   * @param name package name
   * @param version version
   * @param metadata version metadata
   * @param tag tag of the version
   */
  public async addVersionNext(
    name: string,
    version: string,
    metadata: Version,
    tag: StringValue
  ): Promise<void> {
    debug(`add version %s package for %s`, version, name);
    await this.updatePackageNext(name, async (data: Manifest): Promise<Manifest> => {
      // keep only one readme per package
      data.readme = metadata.readme;
      debug('%s` readme mutated', name);
      // TODO: lodash remove
      metadata = cleanUpReadme(metadata);
      metadata.contributors = normalizeContributors(metadata.contributors as Author[]);
      debug('%s` contributors normalized', name);

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
          data._attachments[tarball].version = version;
        }

        // if the time field doesn't exist, we create it, some old storage
        // might not have it
        // https://github.com/verdaccio/verdaccio/issues/740
        if (_.isNil(data.time)) {
          this.logger.warn(
            { name },
            'time field could not be found, it has been recreated for @{name}'
          );
          data.time = {};
        }

        // populate the time field  with the date of the version
        const currentDate = new Date().toISOString();
        data.time.modified = currentDate;
        if (!data.time?.created) {
          data.time.created = currentDate;
        }

        if (typeof data.time[version] === 'string') {
          // this should not h appen, but we keep this check to avoid or easy bug report
          this.logger.warn(
            { name, version },
            'the time for the version @{version} already exists, it has been overwritten for package @{name}'
          );
        }
        data.time[version] = currentDate;
        debug('time added for %s version %s', name, version);
      }

      data.versions[version] = metadata;
      // TODO: review this method, it's a bit ugly
      tagVersion(data, version, tag);

      try {
        debug('%s` add on database', name);
        await this.localStorage.getStoragePlugin().add(name);
        this.logger.debug({ name, version }, 'version @{version} added to database for @{name}');
      } catch (err: any) {
        throw errorUtils.getBadData(err.message);
      }
      return data;
    });
  }

  /**
   * Create an empty new local cache package without versions.
   * @param name name of the package
   * @returns
   */
  private async createNewLocalCachePackage(name: string, latestVersion: string): Promise<void> {
    const storage: IPackageStorage = this.getPrivatePackageStorage(name);

    if (!storage) {
      debug(`storage is missing for %o package cannot be added`, name);
      throw errorUtils.getNotFound('this package cannot be added');
    }

    const currentTime = new Date().toISOString();
    const packageData: Manifest = {
      ...generatePackageTemplate(name),
      time: {
        created: currentTime,
        modified: currentTime,
        [latestVersion]: currentTime,
      },
    };

    try {
      await storage.createPackageNext(name, packageData);
      this.logger.info({ name }, 'created new package @{name}');
      return;
    } catch (err: any) {
      if (
        _.isNull(err) === false &&
        (err.code === STORAGE.FILE_EXIST_ERROR || err.code === HTTP_STATUS.CONFLICT)
      ) {
        debug(`error on creating a package for %o with error %o`, name, err.message);
        throw errorUtils.getConflict();
      }
      return;
    }
  }

  protected isAllowPublishOffline(): boolean {
    return (
      typeof this.config.publish !== 'undefined' &&
      _.isBoolean(this.config.publish.allow_offline) &&
      this.config.publish.allow_offline
    );
  }

  /**
   *
   * @param name package name
   * @param uplinksLook
   * @returns
   */
  private async checkPackageRemote(name: string, uplinksLook: boolean): Promise<Manifest | null> {
    try {
      // we provide a null manifest, thus the manifest returned will be the remote one
      const [remoteManifest, upLinksErrors] = await this.syncUplinksMetadataNext(name, null, {
        uplinksLook,
      });

      // checking package exist already
      if (isNil(remoteManifest) === false) {
        throw errorUtils.getConflict(API_ERROR.PACKAGE_EXIST);
      }

      for (let errorItem = 0; errorItem < upLinksErrors.length; errorItem++) {
        // checking error
        // if uplink fails with a status other than 404, we report failure
        if (isNil(upLinksErrors[errorItem][0]) === false) {
          if (upLinksErrors[errorItem][0].status !== HTTP_STATUS.NOT_FOUND) {
            if (upLinksErrors) {
              return null;
            }

            throw errorUtils.getServiceUnavailable(API_ERROR.UPLINK_OFFLINE_PUBLISH);
          }
        }
      }
      return remoteManifest;
    } catch (err: any) {
      if (err && err.status !== HTTP_STATUS.NOT_FOUND) {
        throw err;
      }
      return null;
    }
  }

  private setDefaultRevision(json: Manifest): Manifest {
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

  private async writePackageNext(name: string, json: Package): Promise<void> {
    const storage: any = this.getPrivatePackageStorage(name);
    if (_.isNil(storage)) {
      // TODO: replace here 500 error
      throw errorUtils.getBadData();
    }
    await storage.savePackageNext(name, this.setDefaultRevision(json));
  }

  /**
   * @param {*} name package name
   * @param {*} updateHandler function(package, cb) - update function
   * @param {*} callback callback that gets invoked after it's all updated
   * @return {Function}
   */
  private async updatePackageNext(
    name: string,
    updateHandler: (manifest: Manifest) => Promise<Manifest>
  ): Promise<Manifest> {
    const storage: IPackageStorage = this.getPrivatePackageStorage(name);

    if (!storage) {
      throw errorUtils.getNotFound();
    }

    // we update the package on the local storage
    const updatedManifest: Manifest = await storage.updatePackageNext(name, updateHandler);
    // after correctly updated write to the storage
    try {
      await this.writePackageNext(name, normalizePackage(updatedManifest));
      return updatedManifest;
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
   *
   * @protected
   * @param {IGetPackageOptionsNext} options
   * @return {*}  {Promise<[Manifest, any[]]>}
   * @memberof AbstractStorage
   */
  protected async getPackageNext(options: IGetPackageOptionsNext): Promise<[Manifest, any[]]> {
    const { name } = options;
    debug('get package for %o', name);
    let data: Manifest | null = null;

    try {
      data = await this.getPackageLocalMetadata(name);
    } catch (err: any) {
      // if error code is higher than 500 stop here
      if (err && (!err.status || err.status >= HTTP_STATUS.INTERNAL_ERROR)) {
        throw err;
      }
    }

    // if we can't get the local metadata, we try to get the remote metadata
    // if we do to have local metadata, we try to update it with the upstream registry
    debug('sync uplinks for %o', name);
    const [remoteManifest, upLinksErrors] = await this.syncUplinksMetadataNext(name, data, {
      uplinksLook: options.uplinksLook,
      retry: options.retry,
      remoteAddress: options.requestOptions.remoteAddress,
      // etag??
    });

    // if either local data and upstream data are empty, we throw an error
    if (!remoteManifest && _.isNull(data)) {
      throw errorUtils.getNotFound(`${API_ERROR.NOT_PACKAGE_UPLINK}: ${name}`);
      // if the remote manifest is empty, we return local data
    } else if (!remoteManifest && !_.isNull(data)) {
      // no data on uplinks
      return [data as Manifest, upLinksErrors];
    }

    // if we have local data, we try to update it with the upstream registry
    const normalizedPkg = Object.assign({}, remoteManifest, {
      // FIXME: clean up  mutation within cleanUpLinksRef method
      ...normalizeDistTags(cleanUpLinksRef(remoteManifest as Manifest, options.keepUpLinkData)),
      _attachments: {},
    });

    debug('no. sync uplinks errors %o for %s', upLinksErrors?.length, name);
    return [normalizedPkg, upLinksErrors];
  }

  /**
   * Function fetches package metadata from uplinks and synchronizes it with local data
     if package is available locally, it MUST be provided in pkginfo.

    Using this example:

    "jquery":
      access: $all
      publish: $authenticated
      unpublish: $authenticated
      # two uplinks setup
      proxy: ver npmjs
      # one uplink setup
      proxy: npmjs

    A package requires uplinks syncronization if enables the proxy section, uplinks
    can be more than one, the more are the most slow request will take, the request
    are made in serie and if 1st call fails, the second will be triggered, otherwise
    the 1st will reply and others will be discareded. The order is important.

    Errors on upkinks are considered are, time outs, connection fails and http status 304,
    in that case the request returns empty body and we want ask next on the list if has fresh
    updates.
   */
  public async syncUplinksMetadataNext(
    name: string,
    localManifest: Manifest | null,
    options: ISyncUplinksOptions = {}
  ): Promise<[Manifest | null, any]> {
    let found = true;
    let syncManifest: Manifest | null = null;
    const upLinks: string[] = [];
    const hasToLookIntoUplinks = _.isNil(options.uplinksLook) || options.uplinksLook;
    debug('is sync uplink enabled %o', hasToLookIntoUplinks);

    for (const uplink in this.uplinks) {
      if (hasProxyTo(name, uplink, this.config.packages) && hasToLookIntoUplinks) {
        debug('sync uplink %o', uplink);
        upLinks.push(uplink);
      }
    }

    //  if none uplink match we return the local manifest
    if (upLinks.length === 0) {
      debug('no uplinks found for %o upstream update aborted', name);
      return [localManifest, []];
    }

    const errors: any[] = [];
    // we resolve uplinks async in serie, first come first serve
    for (const uplink of upLinks) {
      try {
        const tempManifest = _.isNil(localManifest)
          ? generatePackageTemplate(name)
          : { ...localManifest };
        syncManifest = (await this.mergeCacheRemoteMetadata(
          this.uplinks[uplink],
          tempManifest,
          options
        )) as Manifest;
        debug('syncing on uplink %o', syncManifest.name);
        found = true;
        break;
      } catch (err: any) {
        debug('error captured on uplink %o', err.message);
        errors.push(err);
        // enforce use next uplink on the list
        continue;
      }
    }

    if (found && syncManifest !== null) {
      // updates the local cache manifest with fresh data
      let updatedCacheManifest = await this.localStorage.updateVersionsNext(name, syncManifest);
      // plugin filter applied to the manifest
      const [filteredManifest, filtersErrors] = await this.applyFilters(updatedCacheManifest);
      return [{ ...updatedCacheManifest, ...filteredManifest }, [...errors, ...filtersErrors]];
    } else {
      // if is not found, calculate the right error to return
      debug('uplinks sync failed with %o errors', errors.length);
      for (const err of errors) {
        const { code } = err;
        if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNRESET') {
          debug('uplinks sync failed with timeout error');
          throw errorUtils.getServiceUnavailable(err.code);
        }
        // we bubble up the 304 special error case
        if (code === HTTP_STATUS.NOT_MODIFIED) {
          debug('uplinks sync failed with 304 error');
          throw err;
        }
      }
      debug('uplinks sync failed with no package found');
      throw errorUtils.getNotFound(API_ERROR.NO_PACKAGE);
    }
  }

  /**
   * Merge a manifest with a remote manifest.
   *
   * If the uplinks are not available, the local manifest is returned.
   * If the uplinks are available, the local manifest is merged with the remote one.
   *
   *
   * @param uplink uplink instance
   * @param cachedManifest the local cached manifest
   * @param options options
   * @returns Returns a promise that resolves with the merged manifest.
   */
  public async mergeCacheRemoteMetadata(
    uplink: IProxy,
    cachedManifest: Manifest,
    options: ISyncUplinksOptions
  ): Promise<Manifest> {
    // we store which uplink is updating the manifest
    const upLinkMeta = cachedManifest._uplinks[uplink.upname];
    let _cacheManifest = { ...cachedManifest };

    if (validatioUtils.isObject(upLinkMeta)) {
      const fetched = upLinkMeta.fetched;

      // we check the uplink cache is fresh
      if (fetched && Date.now() - fetched < uplink.maxage) {
        return cachedManifest;
      }
    }

    const remoteOptions = Object.assign({}, options, {
      etag: upLinkMeta?.etag,
    });

    // get the latest metadata from the uplink
    const [remoteManifest, etag] = await uplink.getRemoteMetadataNext(
      _cacheManifest.name,
      remoteOptions
    );

    try {
      _cacheManifest = validatioUtils.validateMetadata(remoteManifest, _cacheManifest.name);
    } catch (err: any) {
      this.logger.error(
        {
          err: err,
        },
        'package.json validating error @{!err?.message}\n@{err.stack}'
      );
      throw err;
    }
    // updates the _uplink metadata fields, cache, etc
    _cacheManifest = updateUpLinkMetadata(uplink.upname, _cacheManifest, etag);
    // merge time field cache and remote
    _cacheManifest = mergeUplinkTimeIntoLocalNext(_cacheManifest, remoteManifest);
    // update the _uplinks field in the cache
    _cacheManifest = updateVersionsHiddenUpLinkNext(cachedManifest, uplink);
    try {
      // merge versions from remote into the cache
      _cacheManifest = mergeVersions(_cacheManifest, remoteManifest);
      return _cacheManifest;
    } catch (err: any) {
      this.logger.error(
        {
          err: err,
        },
        'package.json mergin has failed @{!err?.message}\n@{err.stack}'
      );
      throw err;
    }
  }

  /**
   * Apply filters to manifest.
   * @param manifest
   * @returns
   */
  public async applyFilters(manifest: Manifest): Promise<[Manifest, any]> {
    if (this.filters.length === 0) {
      return [manifest, []];
    }

    let filterPluginErrors: any[] = [];
    let filteredManifest = { ...manifest };
    for (const filter of this.filters) {
      // These filters can assume it's save to modify packageJsonLocal
      // and return it directly for
      // performance (i.e. need not be pure)
      try {
        filteredManifest = await filter.filter_metadata(manifest);
      } catch (err: any) {
        this.logger.error({ err: err.message }, 'filter has failed @{err}');
        filterPluginErrors.push(err);
      }
    }
    return [filteredManifest, filterPluginErrors];
  }
}

export default AbstractStorage;
