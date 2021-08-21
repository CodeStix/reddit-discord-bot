import { RedisClient, createClient } from "redis";
import { debug } from "debug";
import util from "util";
import { CommentSortMode, Listing, RedditUser, Submission, SubredditMode } from "./reddit";

const logger = debug("rdb:redis");

let redis = createClient(process.env.REDIS_URL!, {
    no_ready_check: true,
    enable_offline_queue: false,
});

redis.on("error", (err) => {
    logger("error", err);
});

const setAsync = util.promisify(redis.set).bind(redis);
const getAsync = util.promisify(redis.get).bind(redis);
const setExAsync = util.promisify(redis.setex).bind(redis);

const EXPIRE_USER_ICON = 60 * 60 * 8;
const EXPIRE_SUBREDDIT_INFO = 60 * 60 * 24 * 5;
const EXPIRE_URL = 60 * 60 * 24 * 15;
const EXPIRE_USER_INPUT = 60 * 60 * 24 * 30;
const EXPIRE_SUBMISSION = 60 * 60 * 24 * 5;

function getTtlForRedditMode(queryOrMode: SubredditMode | string) {
    switch (queryOrMode) {
        case "hour":
            return 60 * 60;
        case "day":
            return 60 * 60 * 24;
        case "week":
            return 60 * 60 * 24 * 7;
        case "month":
            return 60 * 60 * 24 * 30;
        case "year":
        case "all":
            return 60 * 60 * 24 * 30 * 3; // will probably forget after 3 months
        case "hot":
        case "rising":
        case "random":
        case "top":
            return 60 * 60 * 16;
        default:
            return 60 * 60 * 8;
    }
}

function cleanQuery(query: string) {
    return query
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

export async function storeCachedRedditListing(
    subreddit: string,
    queryOrMode: SubredditMode | string,
    page: number,
    submissions: Listing<Submission>
) {
    queryOrMode = cleanQuery(queryOrMode);
    logger("caching listing page %d %s/%s (%d items)", page, subreddit, queryOrMode, submissions.children.length);
    await setExAsync(`reddit:${subreddit}:${queryOrMode}:${page}`, getTtlForRedditMode(queryOrMode), JSON.stringify(submissions));
}

export async function getCachedRedditListing(
    subreddit: string,
    queryOrMode: SubredditMode | string,
    page: number
): Promise<Listing<Submission> | null> {
    return JSON.parse((await getAsync(`reddit:${subreddit}:${cleanQuery(queryOrMode)}:${page}`)) ?? "null");
}

export async function getCachedRedditUserIcon(userName: string): Promise<string | null> {
    return await getAsync(`user:${userName}:icon`);
}

export async function storeCachedRedditUserIcon(userName: string, icon: string) {
    await setExAsync(`user:${userName}:icon`, EXPIRE_USER_ICON, icon);
}

export async function getCachedSubredditIcon(subredditName: string): Promise<string | null> {
    return await getAsync(`reddit:${subredditName}:icon`);
}

export async function storeCachedSubredditIcon(subredditName: string, icon: string) {
    await setExAsync(`reddit:${subredditName}:icon`, EXPIRE_SUBREDDIT_INFO, icon);
}

export async function getCachedSubredditColor(subredditName: string): Promise<string | null> {
    return await getAsync(`reddit:${subredditName}:color`);
}

export async function storeCachedSubredditColor(subredditName: string, color: string) {
    await setExAsync(`reddit:${subredditName}:color`, EXPIRE_SUBREDDIT_INFO, color);
}

export async function getCachedPackedUrl(url: string): Promise<string | null> {
    return await getAsync(`url:${url}`);
}

export async function storeCachedPackedUrl(url: string, unpackedUrl: string) {
    logger("caching url", url);
    await setExAsync(`url:${url}`, EXPIRE_URL, unpackedUrl);
}

export async function getChannelIndex(channelId: string, subreddit: string, queryOrMode: SubredditMode | string): Promise<number> {
    return parseInt((await getAsync(`channel:${channelId}:${subreddit}:${cleanQuery(queryOrMode)}:index`)) ?? "0");
}

export async function storeChannelIndex(channelId: string, subreddit: string, queryOrMode: SubredditMode | string, index: number) {
    queryOrMode = cleanQuery(queryOrMode);
    await setExAsync(`channel:${channelId}:${subreddit}:${queryOrMode}:index`, getTtlForRedditMode(queryOrMode), "" + index);
}

export async function storePreviousInput(channelId: string, userId: string, input: string) {
    await setExAsync(`channel:${channelId}:${userId}:prev`, EXPIRE_USER_INPUT, input);
}

export async function getPreviousInput(channelId: string, userId: string): Promise<string | null> {
    return await getAsync(`channel:${channelId}:${userId}:prev`);
}

export async function storeCachedSubmission(submission: Submission, commentSortMode: CommentSortMode) {
    logger("caching submission %s", submission.permalink);
    await setExAsync(`post:${submission.id}:${commentSortMode}`, EXPIRE_SUBMISSION, JSON.stringify(submission));
}

export async function getCachedSubmission(submissionId: string, commentSortMode: CommentSortMode): Promise<Submission | null> {
    return JSON.parse((await getAsync(`post:${submissionId}:${commentSortMode}`)) ?? "null");
}
