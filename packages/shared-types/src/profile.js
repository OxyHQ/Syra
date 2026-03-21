"use strict";
/**
 * Profile-related types shared across Mention frontend and backend
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileType = exports.ProfileVisibility = void 0;
var ProfileVisibility;
(function (ProfileVisibility) {
    ProfileVisibility["PUBLIC"] = "public";
    ProfileVisibility["PRIVATE"] = "private";
    ProfileVisibility["FOLLOWERS_ONLY"] = "followers_only";
})(ProfileVisibility || (exports.ProfileVisibility = ProfileVisibility = {}));
var ProfileType;
(function (ProfileType) {
    ProfileType["PERSONAL"] = "personal";
    ProfileType["BUSINESS"] = "business";
    ProfileType["CREATOR"] = "creator";
    ProfileType["VERIFIED"] = "verified";
})(ProfileType || (exports.ProfileType = ProfileType = {}));
