import {
    getCachedRedditListing,
    getCachedRedditUserIcon,
    getCachedSubmission,
    getCachedSubredditColor,
    getCachedSubredditIcon,
    storeCachedRedditListing,
    storeCachedRedditUserIcon,
    storeCachedSubmission,
    storeCachedSubredditColor,
    storeCachedSubredditIcon,
} from "./redis";
import { debug } from "debug";
import fetch from "node-fetch";
import fs from "fs";
import { RedditBotError } from "./error";

const logger = debug("rdb:reddit");

const CACHE_PER_PAGE = 20;
const API_BASE = "https://api.reddit.com";
const DEFAULT_COMMENT_SORT = "top";

export type CommentSortMode = "confidence" | "top" | "new" | "controversial" | "old" | "random";
export type SubredditMode = "hot" | "new" | "random" | "rising" | "hour" | "day" | "week" | "month" | "year" | "all" | "top"; // "hour" | "day" | "month" | "week" | "year" | "all" are top
export const SUBREDDIT_MODES = ["hot", "new", "random", "rising", "hour", "day", "week", "month", "year", "all", "top"];

export type RedditFetchErrorType = "not-found" | "private" | "banned" | "unknown";

// Do not rename these fields! They come directly from the reddit API
export interface Submission {
    id: string;
    stickied: boolean;
    author: string;
    selftext: string;
    created: number;
    title: string;
    url: string;
    subreddit: string;
    over_18: boolean;
    spoiler: boolean;
    permalink: string;
    score: number;
    is_video: boolean;
    comments?: Listing<Comment>;
}

export interface RedditUser {
    name: string;
    icon_img: string;
}

export interface Subreddit {
    name: string;
    icon_img: string;
    key_color: string;
    primary_color: string;
}

export interface Listing<T> {
    after: string;
    before: string;
    limit: number;
    count: number;
    show: string;
    children: {
        kind: string;
        data: T;
    }[];
}

export interface Comment {
    score: number;
    body: string;
    author: string;
    score_hidden: boolean;
    replies: {
        data: Listing<Comment>;
    };
}

export function getRandomDefaultUserIcon() {
    // https://www.reddit.com/user/timawesomeness/comments/813jpq/default_reddit_profile_pictures/
    const randomTextureId = (Math.floor(Math.random() * 20) + 1).toString().padStart(2, "0");
    const possibleColors = [
        "A5A4A4",
        "545452",
        "A06A42",
        "C18D42",
        "FF4500",
        "FF8717",
        "FFB000",
        "FFD635",
        "DDBD37",
        "D4E815",
        "94E044",
        "46A508",
        "46D160",
        "0DD3BB",
        "25B79F",
        "008985",
        "24A0ED",
        "0079D3",
        "7193FF",
        "4856A3",
        "7E53C1",
        "FF66AC",
        "DB0064",
        "EA0027",
        "FF585B",
    ];
    const randomColor = possibleColors[Math.floor(Math.random() * possibleColors.length)];
    return `https://www.redditstatic.com/avatars/avatar_default_${randomTextureId}_${randomColor}.png`;
}

const AFTER_FETCH_REPLACE: any = {
    "&amp;": "&",
    "&quot;": "'",
    "&lt;": "<",
    "&gt;": ">",
};
const AFTER_FETCH_REGEX = new RegExp(Object.keys(AFTER_FETCH_REPLACE).join("|"), "gi");

function parseListing<TListing>(res: any): Listing<TListing> {
    let listing: Listing<TListing> = res.data;
    if (!listing) throw new Error(`No listing was returned`);
    if (!listing.children) throw new Error(`Invalid listing was returned`);
    return listing;
}

function parseArrayListing(res: any): Listing<any>[] {
    if (!Array.isArray(res)) throw new Error("Invalid array listing response.");
    if (res.length === 0 || !res[0].data) throw new Error("Empty array listing response.");
    return res.map((e) => e.data);
}

async function fetchJson(url: string): Promise<any> {
    let res = await fetch(url);
    let text = await res.text();
    // Replace html entities
    let obj = JSON.parse(text.replace(AFTER_FETCH_REGEX, (m) => AFTER_FETCH_REPLACE[m.toLowerCase()]));
    if (res.ok) {
        return obj;
    } else if (res.status === 404) {
        throw RedditBotError.fromReddit404ErrorData(obj);
    } else if (res.status === 403) {
        throw new RedditBotError("private-subreddit");
    } else {
        throw new RedditBotError("unknown-fetch");
    }
}

export async function fetchSubmissions(subreddit: string, query: SubredditMode | string, after?: string): Promise<Listing<Submission>> {
    let url;
    switch (query.trim().toLowerCase()) {
        case "rising":
        case "new":
        case "random":
            url = `${API_BASE}/r/${subreddit}/${query}?count=${CACHE_PER_PAGE}&limit=${CACHE_PER_PAGE}&show=all`;
            break;
        case "hot":
        case "":
            url = `${API_BASE}/r/${subreddit}/${query}?count=${CACHE_PER_PAGE}&limit=${CACHE_PER_PAGE}&show=all&g=GLOBAL`;
            break;
        case "top":
            query = "month";
        case "hour":
        case "day":
        case "week":
        case "month":
        case "year":
        case "all":
            url = `${API_BASE}/r/${subreddit}/top?count=${CACHE_PER_PAGE}&limit=${CACHE_PER_PAGE}&show=all&t=${query}`;
            break;
        default:
            url = `${API_BASE}/r/${subreddit}/search?count=${CACHE_PER_PAGE}&limit=${CACHE_PER_PAGE}&show=all&restrict_sr=true&q=${encodeURIComponent(
                query
            )}`;
            break;
    }

    if (after) url += `&after=${after}`;

    console.log("url", url);

    return parseListing<Submission>(await fetchJson(url));
}

export async function fetchUser(userName: string): Promise<RedditUser> {
    if (!userName || userName === "[deleted]") throw new Error(`empty name '${userName}' was given to fetchUser`);

    let url = `${API_BASE}/user/${userName}/about`;
    let res = await fetchJson(url);

    if (!res.data || typeof res.data.name !== "string") throw new Error("Invalid user response");
    return res.data as RedditUser;
}

export async function fetchSubreddit(subredditName: string): Promise<Subreddit> {
    let url = `${API_BASE}/r/${subredditName}/about`;
    let res = await fetchJson(url);

    if (!res.data || typeof res.data.name !== "string") throw new Error("Invalid subreddit response");
    return res.data as Subreddit;
}

export async function getRedditSubmission(subreddit: string, query: SubredditMode | string, index: number): Promise<Submission | null> {
    let page = Math.floor(index / CACHE_PER_PAGE);
    let num = Math.floor(index % CACHE_PER_PAGE);

    let listing = await getCachedRedditListing(subreddit, query, page);
    if (listing === null) {
        // Listing does not exist in cache, request it and store it in the cache
        let previousListing = null;
        if (page > 0) previousListing = await getCachedRedditListing(subreddit, query, page - 1);

        listing = await fetchSubmissions(subreddit, query, previousListing?.after);
        if (listing.children.length === 0) throw new RedditBotError("subreddit-not-found");
        await storeCachedRedditListing(subreddit, query, page, listing);
    }

    if (listing.children.length <= num) {
        logger("index %d is out of range of listing %s/%s", index, subreddit, query);
        return null;
    }

    return listing.children[num].data;
}

export async function getRedditUserIcon(userName: string, cacheOnly: boolean = false): Promise<string | null> {
    let userIcon = await getCachedRedditUserIcon(userName);
    if (userIcon !== null) return userIcon;
    if (cacheOnly) return null;

    try {
        let user = await fetchUser(userName);
        await storeCachedRedditUserIcon(userName, user.icon_img ?? "");
        return user.icon_img;
    } catch (ex) {
        logger("could not get user icon for '%s':", userName, ex);
        return null;
    }
}

export async function getSubredditInfo(subredditName: string, cacheOnly: boolean = false): Promise<{ color: string; icon: string } | null> {
    let subredditIcon = await getCachedSubredditIcon(subredditName);
    let subredditColor = await getCachedSubredditColor(subredditName);
    if (subredditIcon !== null && subredditColor !== null)
        return {
            icon: subredditIcon,
            color: subredditColor,
        };
    if (cacheOnly) return null;

    try {
        let subreddit = await fetchSubreddit(subredditName);
        await storeCachedSubredditIcon(subredditName, subreddit.icon_img ?? "");
        await storeCachedSubredditColor(subredditName, subreddit.primary_color ?? "");
        return {
            color: subreddit.primary_color,
            icon: subreddit.icon_img,
        };
    } catch (ex) {
        logger("could not get subreddit icon for '%s':", subredditName, ex);
        return null;
    }
}

export async function fetchSubmission(
    submissionId: string,
    maxDepth: number = 2,
    commentSortMode: CommentSortMode = DEFAULT_COMMENT_SORT
): Promise<Submission> {
    let url = `${API_BASE}/comments/${submissionId}?depth=${maxDepth}&limit=${maxDepth}&sort=${commentSortMode}`;
    let listings = parseArrayListing(await fetchJson(url));
    let submission = (listings[0] as Listing<Submission>).children[0].data;
    submission.comments = listings[1];
    return submission;
}

export async function getSubmission(
    submissionId: string,
    cacheOnly: boolean = false,
    maxDepth: number = 2,
    commentSortMode: CommentSortMode = DEFAULT_COMMENT_SORT
): Promise<Submission | null> {
    let submission = await getCachedSubmission(submissionId, commentSortMode);
    fs.writeFileSync("logs/output.json", JSON.stringify(submission));
    if (submission !== null) return submission;
    if (cacheOnly) return null;

    submission = await fetchSubmission(submissionId, maxDepth, commentSortMode);
    await storeCachedSubmission(submission, commentSortMode);
    return submission;
}

export async function searchSubreddit() {}
