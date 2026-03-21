"use strict";
/**
 * Playlist-related types for Syra music streaming app
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlaylistVisibility = void 0;
/**
 * Playlist visibility
 */
var PlaylistVisibility;
(function (PlaylistVisibility) {
    PlaylistVisibility["PUBLIC"] = "public";
    PlaylistVisibility["PRIVATE"] = "private";
    PlaylistVisibility["UNLISTED"] = "unlisted"; // accessible via link but not searchable
})(PlaylistVisibility || (exports.PlaylistVisibility = PlaylistVisibility = {}));
