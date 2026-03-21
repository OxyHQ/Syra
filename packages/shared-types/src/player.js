"use strict";
/**
 * Player-related types for Syra music streaming app
 * Playback state, queue, now playing
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RepeatMode = exports.PlaybackState = void 0;
/**
 * Playback state
 */
var PlaybackState;
(function (PlaybackState) {
    PlaybackState["PLAYING"] = "playing";
    PlaybackState["PAUSED"] = "paused";
    PlaybackState["STOPPED"] = "stopped";
    PlaybackState["BUFFERING"] = "buffering";
    PlaybackState["ERROR"] = "error";
})(PlaybackState || (exports.PlaybackState = PlaybackState = {}));
/**
 * Repeat mode
 */
var RepeatMode;
(function (RepeatMode) {
    RepeatMode["OFF"] = "off";
    RepeatMode["ALL"] = "all";
    RepeatMode["ONE"] = "one";
})(RepeatMode || (exports.RepeatMode = RepeatMode = {}));
