const redis = require("redis");
const util = require("util");
const ax = require("./axiosInstance");

var redisClient = redis.createClient({ host: "127.0.0.1", port: 6379, enable_offline_queue: false });

const rkeysAsync = util.promisify(redisClient.keys).bind(redisClient);
const rgetAsync = util.promisify(redisClient.get).bind(redisClient);
const rsetexAsync = util.promisify(redisClient.setex).bind(redisClient);

module.exports.cacheRedditResponseTtl = 60 * 60 * 2;
module.exports.cacheNotTopIndexTtl = 60 * 60 * 12;
module.exports.cacheSubredditIconTtl = 60 * 60 * 24; // remember the subreddit icon for x seconds
module.exports.cacheUserIconTtl = 60 * 60 * 1; // remember the user icon for x seconds
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
                return 60 * 60 * 24 * 365;
            case "all":
                return -1;
        }
    } else {
        return module.exports.cacheNotTopIndexTtl; // everything else
    }
};

module.exports.cacheResponse = function (subredditName, data, mode, timespan, page, callback = null) {
    const baseKey = `r${subredditName}:${mode === "top" ? mode + ":" + timespan : mode}`;
    var chain = redisClient.multi();
    chain = chain.setex(`${baseKey}:p${page}:data`, module.exports.cacheRedditResponseTtl, JSON.stringify(data));
    const indexTtl = module.exports.getTtlForRedditIndex(mode, timespan);
    if (indexTtl > 0) chain = chain.setex(`${baseKey}:p${page}:after`, indexTtl, data.after);
    else chain = chain.set(`${baseKey}:p${page}:after`, data.after);
    chain.exec(callback);
};

module.exports.getResponse = async function (subredditName, mode, timespan, page) {
    const baseKey = `r${subredditName}:${mode === "top" ? mode + ":" + timespan : mode}`;
    var cachedData = await rgetAsync(`${baseKey}:p${page}:data`);
    if (cachedData) return JSON.parse(cachedData);
    else return null;
};

module.exports.getUserIcon = async function (user, fast = false) {
    if (!user || user === "[deleted]") return null;
    const iconKey = `u${user.toLowerCase()}:icon`;
    var icon = await rgetAsync(iconKey);
    if (!icon) {
        if (fast) {
            icon = module.exports.getRandomDefaultUserIcon();
        } else {
            var response;
            try {
                response = await ax.get(`https://api.reddit.com/user/${user}/about`, { responseType: "json" });
            } catch (ex) {
                console.warn("[CachedReddit/Error] Could not get user icon:", ex.message);
                return module.exports.getRandomDefaultUserIcon();
            }
            icon = response.data.data.icon_img || module.exports.getRandomDefaultUserIcon();
            rsetexAsync(iconKey, module.exports.cacheUserIconTtl, icon);
        }
    }
    return icon;
};

module.exports.getSubredditIcon = async function (subredditName, fast = false) {
    const iconKey = `r${subredditName.toLowerCase()}:icon`;
    var icon = await rgetAsync(iconKey);
    if (!icon) {
        if (fast) {
            icon = "";
        } else {
            var response;
            try {
                response = await ax.get(`https://api.reddit.com/r/${subredditName}/about`, { responseType: "json" });
            } catch (ex) {
                console.warn("[CachedReddit/Error] Could not get subreddit icon:", ex.message);
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
