require("dotenv").config();
import { RedisClient } from "redis";
import util from "util";

console.log("redis host", process.env.REDIS_HOST);

let redis = new RedisClient({
    port: parseInt(process.env.REDIS_PORT!),
    host: process.env.REDIS_HOST!,
    password: process.env.REDIS_PASSWORD!,
    no_ready_check: true,
    enable_offline_queue: true,
});

const setAsync = util.promisify(redis.set).bind(redis);
const getAsync = util.promisify(redis.get).bind(redis);
const setExAsync = util.promisify(redis.setex).bind(redis);
const delAsync = util.promisify(redis.del).bind(redis);

const EXPIRE_USER_ICON = 60 * 60 * 8;
const EXPIRE_SUBREDDIT_ICON = 60 * 60 * 24 * 5;
const EXPIRE_URL = 60 * 60 * 24 * 15;
const EXPIRE_USER_INPUT = 60 * 60 * 24 * 30;
const EXPIRE_SUBMISSION = 60 * 60 * 24 * 5;

// r4chan:top:week:ch775260561126195200:idx
// rcursedcomments:top:week:p0:after
// rcursedcomments:top:week:p0:data
// rballs:icon
// uwackytimes:icon
// ch635801948209283072:u356364264455274496:prev

function getTtlForRedditMode(mode: string) {
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

redis.keys("*", async (err, keys) => {
    if (err) {
        console.log("redis error", err);
        return;
    }

    const REDDIT_TOP_INDEX_REGEX = new RegExp(/^r([^:]+):top:(week|hour|day|month|year|all):ch([\d]+):idx$/gi);
    const REDDIT_INDEX_REGEX = new RegExp(/^r([^:]+):(best|hot|new|rising):ch([\d]+):idx$/gi);
    const REDDIT_TOP_DATA_REGEX = new RegExp(/^r([^:]+):top:(week|hour|day|month|year|all):p([\d]+):data$/gi);
    const REDDIT_DATA_REGEX = new RegExp(/^r([^:]+):(best|hot|new|rising):p([\d]+):data$/gi);
    const REDDIT_USER_ICON_REGEX = new RegExp(/^u([^:]+):icon$/gi);
    const REDDIT_ICON_REGEX = new RegExp(/^r([^:]+):icon$/gi);
    const USER_PREV_REGEX = new RegExp(/^ch([\d]+):u([\d]+):prev$/gi);

    for (let i = 0; i < keys.length; i++) {
        let key = keys[i].trim();
        let value = await getAsync(key);
        if (
            key.startsWith("reddit:") ||
            key.startsWith("channel:") ||
            key.startsWith("user:" || key.startsWith("url:")) ||
            key.endsWith(":after")
        )
            continue; // skip new keys

        redis.del(key);

        if (!value) continue;

        if (key.match(REDDIT_TOP_INDEX_REGEX)) {
            let res = REDDIT_TOP_INDEX_REGEX.exec(key)!;
            await setExAsync(`channel:${res[3]}:${res[1]}:${res[2]}:index`, getTtlForRedditMode(res[2]), value);
        } else if (key.match(REDDIT_INDEX_REGEX)) {
            let res = REDDIT_INDEX_REGEX.exec(key)!;
            await setExAsync(`channel:${res[3]}:${res[1]}:${res[2]}:index`, getTtlForRedditMode(res[2]), value);
        } else if (key.match(REDDIT_TOP_DATA_REGEX)) {
            let res = REDDIT_TOP_DATA_REGEX.exec(key)!;
            await setExAsync(`reddit:${res[1]}:${res[2]}:${res[3]}`, getTtlForRedditMode(res[2]), value);
        } else if (key.match(REDDIT_DATA_REGEX)) {
            let res = REDDIT_DATA_REGEX.exec(key)!;
            await setExAsync(`reddit:${res[1]}:${res[2]}:${res[3]}`, getTtlForRedditMode(res[2]), value);
        } else if (key.match(REDDIT_USER_ICON_REGEX)) {
            let res = REDDIT_USER_ICON_REGEX.exec(key)!;
            await setExAsync(`user:${res[1]}:icon`, EXPIRE_USER_ICON, value);
        } else if (key.match(REDDIT_ICON_REGEX)) {
            let res = REDDIT_ICON_REGEX.exec(key)!;
            await setExAsync(`reddit:${res[1]}:icon`, EXPIRE_SUBREDDIT_ICON, value);
        } else if (key.match(USER_PREV_REGEX)) {
            let res = USER_PREV_REGEX.exec(key)!;
            await setExAsync(`channel:${res[1]}:${res[2]}:prev`, EXPIRE_USER_INPUT, value);
        } else {
            console.log("Unknown key", key);
        }
    }

    console.log("Done");
});
