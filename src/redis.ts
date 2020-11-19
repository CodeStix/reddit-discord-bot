import { RedisClient } from "redis";
import { debug } from "debug";
import util from "util";
import { Listing, RedditUser, Submission } from "./reddit";

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

const EXPIRE_SUBMISSIONS = 60 * 60;
const EXPIRE_USER_ICON = 60 * 60;
const EXPIRE_SUBREDDIT_ICON = 60 * 60;
const EXPIRE_URL = 60 * 60;

export async function storeCachedRedditListing(
    subreddit: string,
    subredditMode: string,
    page: number,
    submissions: Listing<Submission>
) {
    await setExAsync(`reddit:${subreddit}:${subredditMode}:${page}`, EXPIRE_SUBMISSIONS, JSON.stringify(submissions));
}

export async function getCachedRedditListing(
    subreddit: string,
    subredditMode: string,
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
    await setExAsync(`url:${url}`, EXPIRE_URL, unpackedUrl);
}
