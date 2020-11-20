import { RedisClient } from "redis";
import { debug } from "debug";
import util from "util";
import { CommentSortMode, Listing, RedditUser, Submission, SubredditMode } from "./reddit";

const logger = debug("rdb:redis");

let redis = new RedisClient({
    port: parseInt(process.env.REDIS_PORT!),
    host: process.env.REDIS_HOST!,
    password: process.env.REDIS_PASSWORD!,
    no_ready_check: true,
    enable_offline_queue: false,
});

redis.on("error", (err) => {
    logger("error", err);
});

const setAsync = util.promisify(redis.set).bind(redis);
const getAsync = util.promisify(redis.get).bind(redis);
const setExAsync = util.promisify(redis.setex).bind(redis);

const EXPIRE_USER_ICON = 60 * 60 * 24 * 2;
const EXPIRE_SUBREDDIT_ICON = 60 * 60 * 24 * 15;
const EXPIRE_URL = 60 * 60 * 24 * 15;
const EXPIRE_USER_INPUT = 60 * 60 * 24 * 30;
const EXPIRE_SUBMISSION = 60 * 60 * 24 * 5;

function getTtlForRedditMode(mode: SubredditMode) {
    switch (mode) {
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
        default:
            return 60 * 60 * 16;
    }
}

export async function storeCachedRedditListing(
    subreddit: string,
    subredditMode: SubredditMode,
    page: number,
    submissions: Listing<Submission>
) {
    logger("caching listing page %d %s/%s (%d items)", page, subreddit, subredditMode, submissions.children.length);
    await setExAsync(
        `reddit:${subreddit}:${subredditMode}:${page}`,
        getTtlForRedditMode(subredditMode),
        JSON.stringify(submissions)
    );
}

export async function getCachedRedditListing(
    subreddit: string,
    subredditMode: SubredditMode,
    page: number
): Promise<Listing<Submission> | null> {
    return JSON.parse((await getAsync(`reddit:${subreddit}:${subredditMode}:${page}`)) ?? "null");
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
    await setExAsync(`reddit:${subredditName}:icon`, EXPIRE_SUBREDDIT_ICON, icon);
}

export async function getCachedPackedUrl(url: string): Promise<string | null> {
    return await getAsync(`url:${url}`);
}

export async function storeCachedPackedUrl(url: string, unpackedUrl: string) {
    logger("caching url", url);
    await setExAsync(`url:${url}`, EXPIRE_URL, unpackedUrl);
}

export async function getChannelIndex(
    channelId: string,
    subreddit: string,
    subredditMode: SubredditMode
): Promise<number> {
    return parseInt((await getAsync(`channel:${channelId}:${subreddit}:${subredditMode}:index`)) ?? "0");
}

export async function storeChannelIndex(
    channelId: string,
    subreddit: string,
    subredditMode: SubredditMode,
    index: number
) {
    await setExAsync(
        `channel:${channelId}:${subreddit}:${subredditMode}:index`,
        getTtlForRedditMode(subredditMode),
        "" + index
    );
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

export async function getCachedSubmission(
    submissionId: string,
    commentSortMode: CommentSortMode
): Promise<Submission | null> {
    return JSON.parse((await getAsync(`post:${submissionId}:${commentSortMode}`)) ?? "null");
}
