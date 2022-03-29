import { Router } from 'express';
import _ from 'lodash';
import mime from 'mime';

import { IAuth } from '@verdaccio/auth';
import { VerdaccioError, constants } from '@verdaccio/core';
import { allow, media } from '@verdaccio/middleware';
import { Storage } from '@verdaccio/store';

import { $NextFunctionVer, $RequestExtend, $ResponseExtend } from '../types/custom';

export default function (route: Router, auth: IAuth, storage: Storage): void {
  const can = allow(auth);
  const addTagPackageVersionMiddleware = function (
    req: $RequestExtend,
    res: $ResponseExtend,
    next: $NextFunctionVer
  ): $NextFunctionVer {
    if (_.isString(req.body) === false) {
      return next('route');
    }

    const tags = {};
    tags[req.params.tag] = req.body;
    storage.mergeTags(req.params.package, tags, function (err: Error): $NextFunctionVer {
      if (err) {
        return next(err);
      }
      res.status(constants.HTTP_STATUS.CREATED);
      return next({ ok: constants.API_MESSAGE.TAG_ADDED });
    });
  };

  // tagging a package.
  route.put(
    '/:package/:tag',
    can('publish'),
    media(mime.getType('json')),
    addTagPackageVersionMiddleware
  );

  route.post(
    '/-/package/:package/dist-tags/:tag',
    can('publish'),
    media(mime.getType('json')),
    addTagPackageVersionMiddleware
  );

  route.put(
    '/-/package/:package/dist-tags/:tag',
    can('publish'),
    media(mime.getType('json')),
    addTagPackageVersionMiddleware
  );

  route.delete(
    '/-/package/:package/dist-tags/:tag',
    can('publish'),
    function (req: $RequestExtend, res: $ResponseExtend, next: $NextFunctionVer): void {
      const tags = {};
      tags[req.params.tag] = null;
      storage.mergeTags(req.params.package, tags, function (err: VerdaccioError): $NextFunctionVer {
        if (err) {
          return next(err);
        }
        res.status(constants.HTTP_STATUS.CREATED);
        return next({
          ok: constants.API_MESSAGE.TAG_REMOVED,
        });
      });
    }
  );

  route.get(
    '/-/package/:package/dist-tags',
    can('access'),
    async function (
      req: $RequestExtend,
      res: $ResponseExtend,
      next: $NextFunctionVer
    ): Promise<void> {
      const name = req.params.package;
      const requestOptions = {
        protocol: req.protocol,
        headers: req.headers as any,
        // FIXME: if we migrate to req.hostname, the port is not longer included.
        host: req.host,
        remoteAddress: req.socket.remoteAddress,
      };
      try {
        const manifest = await storage.getPackageByOptions({
          name,
          uplinksLook: true,
          requestOptions,
        });
        next(manifest[constants.DIST_TAGS]);
      } catch (err) {
        next(err);
      }
    }
  );

  route.post(
    '/-/package/:package/dist-tags',
    can('publish'),
    function (req: $RequestExtend, res: $ResponseExtend, next: $NextFunctionVer): void {
      storage.mergeTags(
        req.params.package,
        req.body,
        function (err: VerdaccioError): $NextFunctionVer {
          if (err) {
            return next(err);
          }
          res.status(constants.HTTP_STATUS.CREATED);
          return next({
            ok: constants.API_MESSAGE.TAG_UPDATED,
          });
        }
      );
    }
  );
}
