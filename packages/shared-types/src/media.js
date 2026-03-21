"use strict";
/**
 * Media-related types for Mention social network
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaStatus = exports.MediaType = void 0;
var MediaType;
(function (MediaType) {
    MediaType["IMAGE"] = "image";
    MediaType["VIDEO"] = "video";
    MediaType["AUDIO"] = "audio";
    MediaType["GIF"] = "gif";
    MediaType["DOCUMENT"] = "document";
})(MediaType || (exports.MediaType = MediaType = {}));
var MediaStatus;
(function (MediaStatus) {
    MediaStatus["UPLOADING"] = "uploading";
    MediaStatus["PROCESSING"] = "processing";
    MediaStatus["READY"] = "ready";
    MediaStatus["FAILED"] = "failed";
    MediaStatus["DELETED"] = "deleted";
})(MediaStatus || (exports.MediaStatus = MediaStatus = {}));
