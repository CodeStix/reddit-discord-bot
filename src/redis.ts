import { RedisClient } from "redis";
import { debug } from "debug";
import { Submission } from "snoowrap";
import util from "util";

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

export async function setRedditSubmissions(
    subreddit: string,
    subredditMode: string,
    page: number,
    submissions: Submission[]
) {
    await setExAsync(`r${subreddit}:${subredditMode}:${page}`, EXPIRE_SUBMISSIONS, JSON.stringify(submissions));
}

export async function getRedditSubmissions(
    subreddit: string,
    subredditMode: string,
    page: number
): Promise<Submission[] | null> {
    return JSON.parse((await getAsync(`r${subreddit}:${subredditMode}:${page}`)) ?? "null");
}

export async function setAfterSubmission(
    subreddit: string,
    subredditMode: string,
    page: number,
    lastSubmissionId: string
) {}
