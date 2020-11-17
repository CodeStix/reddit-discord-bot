require("dotenv").config();
const redis = require("redis");
const util = require("util");
const ax = require("./axiosInstance");
const debug = require("debug");
const logger = debug("rdb:redis");

var redisClient = new redis.RedisClient({
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD,
    no_ready_check: true,
    enable_offline_queue: false,
});

const rkeysAsync = util.promisify(redisClient.keys).bind(redisClient);
const rgetAsync = util.promisify(redisClient.get).bind(redisClient);
const rsetexAsync = util.promisify(redisClient.setex).bind(redisClient);

module.exports.cachePerPages = 30;
module.exports.cacheRedditResponseTtl = 60 * 60 * 8;
module.exports.cacheNotTopIndexTtl = 60 * 60 * 16;
module.exports.cacheSubredditIconTtl = 60 * 60 * 24 * 30; // remember the subreddit icon for x seconds
module.exports.cacheUserIconTtl = 60 * 60 * 24 * 15; // remember the user icon for x seconds
module.exports.cachePreviousUserInputTtl = 60 * 60 * 24 * 30; // remember the user's previous subreddit for x seconds

module.exports.getFullSubredditChannelKey = function (
    subredditName,
    subredditMode,
    subredditTopTimespan,
    channelId,
    field
) {
    return module.exports.getFullSubredditKey(
        subredditName,
        subredditMode,
        subredditTopTimespan,
        `ch${channelId}:${field}`
    );
};

module.exports.getChannelUserKey = function (channelId, userId, field) {
    return `ch${channelId}:u${userId}:${field}`;
};

module.exports.getFullSubredditKey = function (
    subredditName,
    subredditMode,
    subredditTopTimespan,
    field
) {
    return `r${subredditName}:${
        subredditMode === "top" ? subredditMode + ":" + subredditTopTimespan : subredditMode
    }:${field}`;
};
module.exports.getFullSubredditPageKey = function (
    subredditName,
    subredditMode,
    subredditTopTimespan,
    page,
    field
) {
    return module.exports.getFullSubredditKey(
        subredditName,
        subredditMode,
        subredditTopTimespan,
        `p${page}:${field}`
    );
};

module.exports.getSubredditIconKey = function (subredditName) {
    return `r${subredditName.toLowerCase()}:icon`;
};

module.exports.getUserKey = function (user, field) {
    return `u${user.toLowerCase()}:${field}`;
};

module.exports.getChannelSubredditIndex = async function (
    subredditName,
    subredditMode,
    subredditTopTimespan,
    channelId
) {
    const indexKey = module.exports.getFullSubredditChannelKey(
        subredditName,
        subredditMode,
        subredditTopTimespan,
        channelId,
        "idx"
    );
    return parseInt(await rgetAsync(indexKey)) || 0;
};

module.exports.setChannelSubredditIndex = async function (
    subredditName,
    subredditMode,
    subredditTopTimespan,
    channelId,
    index
) {
    const ttl = module.exports.getTtlForRedditIndex(subredditMode, subredditTopTimespan);
    const indexKey = module.exports.getFullSubredditChannelKey(
        subredditName,
        subredditMode,
        subredditTopTimespan,
        channelId,
        "idx"
    );
    await rsetexAsync(indexKey, ttl, index);
};

module.exports.setPreviousUserInput = async function (channelId, userId, input) {
    const key = module.exports.getChannelUserKey(channelId, userId, "prev");
    await rsetexAsync(key, module.exports.cachePreviousUserInputTtl, input);
};

module.exports.getPreviousUserInput = async function (channelId, userId) {
    const key = module.exports.getChannelUserKey(channelId, userId, "prev");
    return await rgetAsync(key);
};

/**
 * Converts reddit top timespans to seconds
 * @param {'hot' | 'rising' | 'top' | 'new' | 'best'} mode
 * @param {'hour' | 'day' | 'week' | 'month' | 'year' | 'all'} timespan
 */
module.exports.getTtlForRedditIndex = function (mode, timespan) {
    if (mode === "top") {
        switch (timespan) {
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
                return 60 * 60 * 24 * 365;
        }
    } else {
        return module.exports.cacheNotTopIndexTtl; // everything else
    }
};

module.exports.cacheResponse = function (
    subredditName,
    data,
    mode,
    timespan,
    page,
    callback = null
) {
    const dataKey = module.exports.getFullSubredditPageKey(
        subredditName,
        mode,
        timespan,
        page,
        "data"
    );
    var chain = redisClient.multi();
    chain = chain.setex(dataKey, module.exports.cacheRedditResponseTtl, JSON.stringify(data));

    const afterKey = module.exports.getFullSubredditPageKey(
        subredditName,
        mode,
        timespan,
        page,
        "after"
    );
    const indexTtl = module.exports.getTtlForRedditIndex(mode, timespan);
    if (indexTtl > 0) chain = chain.setex(afterKey, indexTtl, data.after);
    else chain = chain.set(afterKey, data.after);
    chain.exec(callback);
};

module.exports.getResponse = async function (subredditName, mode, timespan, page) {
    const dataKey = module.exports.getFullSubredditPageKey(
        subredditName,
        mode,
        timespan,
        page,
        "data"
    );
    var cachedData = await rgetAsync(dataKey);
    if (cachedData) return JSON.parse(cachedData);
    else return null;
};

module.exports.getUserIcon = async function (user, fast = false) {
    if (!user || user === "[deleted]") return null;
    const iconKey = module.exports.getUserKey(user, "icon");
    var icon = await rgetAsync(iconKey);
    if (!icon) {
        if (fast) {
            icon = module.exports.getRandomDefaultUserIcon();
        } else {
            var response;
            try {
                response = await ax.get(`https://api.reddit.com/user/${user}/about`);
            } catch (ex) {
                logger(
                    "(warning) getUserIcon: could not get user icon:",
                    ex.message
                );
                return module.exports.getRandomDefaultUserIcon();
            }
            icon = response.data.data.icon_img || module.exports.getRandomDefaultUserIcon();
            rsetexAsync(iconKey, module.exports.cacheUserIconTtl, icon);
        }
    }
    return icon;
};

module.exports.getSubredditIcon = async function (subredditName, fast = false) {
    const iconKey = module.exports.getSubredditIconKey(subredditName);
    var icon = await rgetAsync(iconKey);
    if (!icon) {
        if (fast) {
            icon = "";
        } else {
            var response;
            try {
                response = await ax.get(`https://api.reddit.com/r/${subredditName}/about`);
            } catch (ex) {
                logger(
                    "(warning) getSubredditIcon: could not get subreddit icon:",
                    ex.message
                );
                return "";
            }
            icon = response.data.data.icon_img || "";
            rsetexAsync(iconKey, module.exports.cacheSubredditIconTtl, icon);
        }
    }
    return icon;
};

module.exports.getRandomDefaultUserIcon = function () {
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
};

module.exports.getRedditPost = async function (subredditName, postId) {
    var url;
    if (subredditName) {
        subredditName = subredditName.toLowerCase();
        url = `https://api.reddit.com/r/${subredditName}/comments/${postId}`;
    } else {
        url = `https://api.reddit.com/comments/${postId}`;
    }
    const response = await ax.get(url);
    var data = Array.isArray(response.data) ? response.data[0].data : response.data.data;
    return data.children[0].data;
};

/**
 * @param {string} subredditName
 * @param {number} index
 * @param {'hot' | 'rising' | 'top' | 'new' | 'best'} mode
 * @param {'hour' | 'day' | 'week' | 'month' | 'year' | 'all'} timespan The timespan that will be used for top (mode) only.
 * @param {boolean} useCache
 */
module.exports.getCachedRedditItem = async function (
    subredditName,
    index,
    mode,
    timespan,
    useCache = true
) {
    subredditName = subredditName.toLowerCase();
    const page = Math.floor(index / module.exports.cachePerPages);
    const clampedIndex = index % module.exports.cachePerPages;
    if (useCache) {
        var cachedData = await module.exports.getResponse(subredditName, mode, timespan, page);
        if (cachedData && clampedIndex < cachedData.children.length)
            return cachedData.children[clampedIndex].data;
    }

    var after = null;
    if (page > 0) {
        after = await rgetAsync(
            module.exports.getFullSubredditPageKey(subredditName, mode, timespan, page - 1, "after")
        );
        if (!after) {
            logger(
                "(warning) getCachedRedditItem: could not get 'after', probably end of feed"
            );
            return null;
        }
    }

    const url = `https://api.reddit.com/r/${subredditName}/${mode}?limit=${module.exports.cachePerPages}&after=${after}&t=${timespan}`;
    var response = await ax.get(url);
    var data = Array.isArray(response.data) ? response.data[0].data : response.data.data;
    if (data.children.length <= 0 || !data.children[0].data.subreddit)
        throw new Error(
            `Reddit did not respond with any posts. Misspelled ***${subredditName}***?`
        );

    module.exports.cacheResponse(subredditName, data, mode, timespan, page);

    //fs.writeFileSync("./cache/lastresponse.json", JSON.stringify(data, null, 2));

    if (data && clampedIndex < data.children.length) {
        return data.children[clampedIndex].data;
    } else {
        logger(
            "(warning) getCachedRedditItem: returning null, the response did not contains enough items."
        );
        return null;
    }
};
