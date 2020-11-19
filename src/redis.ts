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

export async function setRedditListing(
    subreddit: string,
    subredditMode: string,
    page: number,
    submissions: Listing<Submission>
) {
    await setExAsync(`r${subreddit}:${subredditMode}:${page}`, EXPIRE_SUBMISSIONS, JSON.stringify(submissions));
}

export async function getRedditListing(
    subreddit: string,
    subredditMode: string,
    page: number
): Promise<Listing<Submission> | null> {
    return JSON.parse((await getAsync(`r${subreddit}:${subredditMode}:${page}`)) ?? "null");
}

export async function getRedditUserIcon(userName: string): Promise<RedditUser | null> {
    return JSON.parse((await getAsync(`u${userName}:icon`)) ?? "null");
}

export async function storeRedditUserIcon(userName: string, icon: string) {
    await setExAsync(`u${userName}:icon`, EXPIRE_USER_ICON, icon);
}
