import { getCachedRedditListing, storeCachedRedditListing } from "./redis";
import { debug } from "debug";
import fetch from "node-fetch";

const logger = debug("rdb:reddit");

const CACHE_PER_PAGE = 20;
const API_BASE = "https://api.reddit.com";

export type SubredditMode = "hot" | "new" | "random" | "rising" | "hour" | "day" | "month" | "year" | "all"; // "hour" | "day" | "month" | "year" | "all" are top

export interface Submission {
    author: string;
    selftext: string;
    title: string;
    url: string;
}

export interface RedditUser {
    name: string;
    icon_img: string;
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

export async function fetchSubmissions(
    subreddit: string,
    mode: SubredditMode,
    after?: string
): Promise<Listing<Submission>> {
    let url = `${API_BASE}/r/${subreddit}/${mode}?count=${CACHE_PER_PAGE}&limit=${CACHE_PER_PAGE}&show=all`;
    if (after) url += `&after=${after}`;

    switch (mode) {
        case "hot":
            url += `&g=GLOBAL`;
            break;
        case "hour":
        case "day":
        case "month":
        case "year":
        case "all":
            url += `&t=${mode}`;
            break;
        default:
            throw new Error(`Invalid mode '${mode}' was passed to fetchSubmissions`);
    }

    let resText = await fetch(url);
    let res = await resText.json();

    if (Array.isArray(res)) {
        // Reddit API sometimes returnes array instead of object
        if (res.length === 0)
            throw new Error(`No listing was returned for r/${subreddit}/${mode} after=${after ?? "<null>"}`);
        return res[0].data as Listing<Submission>;
    } else {
        if (!res.data) throw new Error(`No listing was returned for r/${subreddit}/${mode} after=${after ?? "<null>"}`);
        return res.data as Listing<Submission>;
    }
}

export function getDefaultUser(name: string = "[deleted]"): RedditUser {
    return {
        name,
        icon_img: getRandomDefaultUserIcon(),
    };
}

export async function fetchUser(userName: string): Promise<RedditUser> {
    if (!userName || userName === "[deleted]") {
        logger("empty name '%s' was given to fetchUser, returning default user", userName);
        return getDefaultUser(userName);
    }

    let url = `${API_BASE}/user/${userName}/about`;
    let resText = await fetch(url);
    let res = await resText.json();

    if (!res.data) return getDefaultUser(userName);

    if (typeof res.data.name !== "string") {
        throw new Error("Invalid user response");
    }

    return res.data as RedditUser;
}

export async function getRedditSubmission(
    subreddit: string,
    subredditMode: SubredditMode,
    index: number
): Promise<Submission | null> {
    let page = index / CACHE_PER_PAGE;
    let num = index % CACHE_PER_PAGE;

    let cached = await getCachedRedditListing(subreddit, subredditMode, page);
    if (cached !== null) {
        logger("from cache", cached.children.length);
        return cached.children[num].data;
    } else {
        let previousListing = null;
        if (page > 0) previousListing = await getCachedRedditListing(subreddit, subredditMode, page - 1);

        let listing = await fetchSubmissions(subreddit, subredditMode, previousListing?.after);
        logger("storing in cache", listing.children.length);
        await storeCachedRedditListing(subreddit, subredditMode, page, listing);
        return listing.children[num].data;
    }
}
