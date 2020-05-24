const { Client, MessageAttachment, MessageEmbed, Message, TextChannel } = require("discord.js");
const axios = require("axios").default;
const util = require("util");
const path = require("path");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const cheerio = require("cheerio");
const redis = require("redis");

const bot = new Client();
const redisClient = redis.createClient({ host: "127.0.0.1", port: 6379, enable_offline_queue: false });

const rexistsAsync = util.promisify(redisClient.exists).bind(redisClient);
const rgetAsync = util.promisify(redisClient.get).bind(redisClient);
const rsetexAsync = util.promisify(redisClient.setex).bind(redisClient);
const existsAsync = util.promisify(fs.exists);
const statAsync = util.promisify(fs.stat);
const renameAsync = util.promisify(fs.rename);
const execAsync = util.promisify(require("child_process").exec);
const execOptions = {
    cwd: path.join(__dirname, "bin"),
};

const token = "NzExNTI0NDA1MTYzMDY1Mzg1.XsEQ-w.ulbbTU95eEMpvP5sqXJqEMGnebI";
const redditIcon = "https://www.redditstatic.com/desktop2x/img/favicon/apple-icon-72x72.png";

let downloadVideos = true;
let skipAtDescriptionLength = 400;
let truncateAtDescriptionLength = 375; // max is 1024
let truncateAtTitleLength = 225; //max is 256
let truncateAtCommentLength = 250; // max is 1024
let tryRemoveNsfw = false;
let enableVotingReactions = false;
let minimumVotes = 1;
let defaultSubredditMethod = "top"; // hot | rising | top | new

const videosPath = path.join(__dirname, "cache", "video");

// Streamable account: stijnvantvijfde@gmail.com 3vGrFAKTrvQg8UHh

redisClient.once("ready", async () => {
    console.log("[Redis] Connected");
});
redisClient.on("error", (err) => {
    console.error("[Redis/Error]", err);
});
redisClient.on("warning", (warn) => {
    console.warn("[Redis/Warning]", warn);
});

bot.login(token);
bot.on("ready", () => {
    console.log("[DiscordBotConnect] Connected");
});
bot.on("error", (err) => {
    console.error("[DiscordBot/Error] Caught error:", err);
});

function decodeHtmlEscaping(str) {
    if (!str) return null;
    return str
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

// https://www.reddit.com/user/timawesomeness/comments/813jpq/default_reddit_profile_pictures/
function getRandomDefaultUserIconUrl() {
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

const cacheUserIconTtl = 60 * 60 * 24;

async function getCachedUserIconUrl(user, fast = false) {
    if (!user || user === "[deleted]") return null;
    try {
        const iconKey = `u/${user}:icon`;
        var icon = await rgetAsync(iconKey);
        if (!icon) {
            if (fast) {
                icon = getRandomDefaultUserIconUrl();
            } else {
                const response = await axios.get(`https://api.reddit.com/user/${user}/about`, { responseType: "json" });
                icon = decodeHtmlEscaping(response.data.data.icon_img) || getRandomDefaultUserIconUrl();
                rsetexAsync(iconKey, cacheUserIconTtl, icon);
            }
        }
        console.log("returned user icon", icon);
        return icon;
    } catch (ex) {
        console.warn("[GetUserIcon/Error] Could not get user icon:", ex.message);
        return getRandomDefaultUserIconUrl();
    }
}

/**
 * Convert a redirecting, 50/50, bit.ly, imgur... url to the direct url.
 * @param {string} url The url to unpack/resolve.
 */
async function unpackUrl(url) {
    if (url.startsWith("https://5050") || url.startsWith("http://5050") || url.startsWith("http://bit.ly") || url.startsWith("https://bit.ly")) {
        try {
            url = (await axios.head(url, { maxRedirects: 5 })).request.res.responseUrl;
        } catch (ex) {
            console.log("[5050Convert/Warning] Could not get redirected url", ex.message);
        }
    }

    if (url.startsWith("https://imgur.com/")) {
        url = "https://i.imgur.com/" + url.substring("https://imgur.com/".length);
        console.log("[ImgurExtract] Extracted imgur url");
    } else if (url.startsWith("https://postimg.cc/")) {
        try {
            const response = await axios.get(url);
            const ch = cheerio.load(response.data);
            url = ch("head meta[property='og:image']").attr("content");
            console.log("[PostImgExtract] Extracted postimg.cc url", url);
        } catch (ex) {
            console.warn("[PostImgExtract/Warning] Could not extract postimg.cc image", ex.message);
        }
    }
    return url;
}

/**
 * @param {TextChannel} channel
 * @param {string} url An url attachment for the reddit item.
 */
async function sendRedditAttachment(channel, url, tryConvertVideo, markSpoiler) {
    /*var currentStatusAwaiter = channel.send("Loading...").catch((err) => {
        console.warn("Warning: could not set status:", err);
    });
    function setStatus(status) {
        currentStatusAwaiter.then((m) => (status ? m.edit(status) : m.delete()));
    }*/

    /**
     * @param {string} url
     * @param {'url' | 'image' | 'video'} type
     */
    async function sendAs(url, type, message = "") {
        switch (type) {
            case "url":
                if (markSpoiler) await channel.send(message + "||" + url + "||", { spoiler: true });
                else await channel.send(message + url);
                break;
            case "image":
                if (markSpoiler) await channel.send(message, new MessageAttachment(url, "SPOILER_.png"));
                else await channel.send(message, new MessageAttachment(url, "image.png"));
                break;
            case "video":
                if (markSpoiler) await channel.send(message, new MessageAttachment(url, "SPOILER_.mp4"));
                else await channel.send(message, new MessageAttachment(url, "video.mp4"));
                break;
            default:
                console.warn("Warning: Invalid sendAsSpoiler type", type);
                return;
        }

        console.log(url);
    }

    // https://www.reddit.com/r/WhyWereTheyFilming/comments/7rzqvd/gun_safety/
    // https://www.reddit.com/r/AbruptChaos/comments/ghz6av/going_back_to_work_after_lockdown/
    // https://i.imgur.com/R5VFxpJ

    if (downloadVideos && tryConvertVideo) {
        const videoUrlHash = crypto.createHash("sha1").update(url, "binary").digest("hex");
        const videoFile = path.join(videosPath, videoUrlHash + ".mp4");
        try {
            if (await existsAsync(videoFile)) {
                await sendAs(videoFile, "video");
                //console.log("probe", JSON.parse((await exec(`ffprobe -i "${videoFile}" -v quiet -print_format json -show_format -hide_banner`)).stdout));
            } else {
                // https://github.com/ytdl-org/youtube-dl/blob/master/README.md#format-selection
                const { stdout, stderr } = await execAsync(
                    `youtube-dl.exe -f "[filesize>6M][filesize<=8M]/[filesize>4M][filesize<=6M]/[filesize>2M][filesize<=4M]/[filesize<=2M]/bestvideo+bestaudio/best" --no-warnings --print-json --no-progress --merge-output-format mp4 --recode-video mp4 --max-filesize 120M --no-playlist --retries 3 --output "${videosPath}/%(extractor_key)s_%(id)s.%(ext)s" "${url}"`,
                    execOptions
                );

                const ytdlResult = JSON.parse(stdout);
                const tempVideoFile = ytdlResult._filename;

                const maxVideoSize = 1000 * 1000 * 8;
                const videoFileInfo = await statAsync(tempVideoFile);
                const videoInfo = JSON.parse(
                    (await execAsync(`ffprobe.exe -i "${tempVideoFile}" -v quiet -print_format json -show_format -hide_banner`, execOptions)).stdout
                );

                // reencode if too large or if mpegts file (discord does not display these)
                // https://unix.stackexchange.com/questions/28803/how-can-i-reduce-a-videos-size-with-ffmpeg
                // https://stackoverflow.com/questions/6239350/how-to-extract-duration-time-from-ffmpeg-output
                if (videoFileInfo.size > maxVideoSize || videoInfo.format.format_name.includes("mpegts")) {
                    console.log("[FFMpeg] Compressing, file is too big:", videoFileInfo, ">", maxVideoSize);
                    await execAsync(
                        `ffmpeg.exe -i "${tempVideoFile}" -b:v ${(maxVideoSize * 8) / (videoInfo.format.duration * 1.3)} -vf scale=800:-2 "${videoFile}"`,
                        execOptions
                    );
                    fs.unlink(tempVideoFile, () => {});
                } else {
                    await renameAsync(tempVideoFile, videoFile);
                }

                if (await existsAsync(videoFile)) {
                    await sendAs(videoFile, "video");
                } else {
                    console.warn("[YoutubeDL/Warning] Converted video does not exist, assuming fail:", stdout, stderr);
                    await sendAs(url, "url", "⚠️ **Error while compressing video, take a url:** ");
                }
            }
        } catch (ex) {
            console.warn("[TryConvertVideo/Error] Could not upload/convert video: ", ex.message);
            await sendAs(url, "url", "⚠️ **Error while uploading video, take a url:** ");
        }
        /*  } else if (
        url.startsWith("https://www.youtube.com/") ||
        url.startsWith("https://youtube.com/") ||
        url.startsWith("https://youtube-nocookie.com/") ||
        url.startsWith("https://m.youtube.com/") ||
        url.startsWith("https://youtu.be/")
    ) {
        await sendAs(url, "url");*/
    } else if (
        url.endsWith(".gif") ||
        url.endsWith(".png") ||
        url.endsWith(".jpg") ||
        url.startsWith("https://i.redd.it/") ||
        url.startsWith("https://i.postimg.cc/")
    ) {
        try {
            await sendAs(url, "image");
        } catch (ex) {
            console.log("[SendImage/Warning] Could not send image:", ex.message);
            await sendAs(url, "url", "⚠️ **Error while uploading image, take a url:** ");
        }
    } else {
        await sendAs(url, "url");
    }
}

const cachePerPages = 35; // the amount of reddit items to cache in one page
const cacheResponseTtl = 60 * 60 * 1; // remember the reddit server response for x seconds
const cacheIndexTtl = 60 * 60 * 48; // remember the channel's reddit feed index for x seconds
const cachePreviousSubredditTtl = 60 * 30; // remember the previous subreddit for x seconds

async function getCachedRedditItem(subredditName, index, method = "hot") {
    // currently no cache is active
    const page = Math.floor(index / cachePerPages);
    try {
        const key = `reddit_${subredditName}_${method}_${page}`;
        var data = await rgetAsync(key);
        if (data) {
            data = JSON.parse(data);
            if (index % cachePerPages < data.children.length) return data.children[index % cachePerPages].data;
            else return null;
        } else {
            var after;
            if (page === 0) {
                after = null;
            } else {
                const previousPageKey = `reddit_${subredditName}_${method}_${page - 1}`;
                var afterData = await rgetAsync(previousPageKey);
                if (afterData) {
                    after = JSON.parse(afterData).after;
                    console.log("Info: next page, after =", after);
                } else {
                    after = null;
                    console.warn("Warning: could not get 'after', it was not found in cache");
                }
            }

            var response = await axios.get(`https://api.reddit.com/${subredditName}/${method}?limit=${cachePerPages}&after=${after}&t=all`, {
                responseType: "json",
            });
            var data = Array.isArray(response.data) ? response.data[0].data : response.data.data;
            if (Array.isArray(response.data)) console.log("Info: received array based response object from reddit");
            if (data.children.length <= 0) return null;
            rsetexAsync(key, cacheResponseTtl, JSON.stringify(data));
            console.log("Info: reddit response stored in cache under key:", key, data.children.length, "items");
            return data.children[index % cachePerPages].data;
        }
    } catch (ex) {
        console.warn("Error: could not get subreddit items:", ex.message);
        return ex;
    }
}

// https://imgur.com/a/50v4Sjb

const cacheSubredditIconTtl = 60 * 60 * 24;

async function getCachedSubredditIcon(subredditName, fast = false) {
    try {
        const iconKey = `${subredditName}:icon`;
        var icon = await rgetAsync(iconKey);
        if (!icon) {
            if (fast) {
                return "";
            } else {
                const response = await axios.get(`https://api.reddit.com/${subredditName}/about`, { responseType: "json" });
                icon = decodeHtmlEscaping(response.data.data.icon_img) || "";
                rsetexAsync(iconKey, cacheSubredditIconTtl, icon);
            }
        }
        return icon;
    } catch (ex) {
        console.warn("[GetSubredditIcon/Error] Could not get subreddit icon:", ex.message);
        return "";
    }
}

async function getTopComment(redditItem, subredditName) {
    try {
        const response = await axios.get(`https://api.reddit.com/${subredditName}/comments/${redditItem.id}?limit=0&depth=0&sort=top`, {
            responseType: "json",
        });

        fs.writeFile("./badrequests/latestcomment.json", JSON.stringify(response.data), () => {});
        if (response.data.length < 2 || response.data[1].data.children.length < 1) return;

        const comments = response.data[1].data.children;
        var topComment = comments.find((val) => !val.data.score_hidden);
        if (!topComment) return;
        topComment = topComment.data;

        if (topComment.body.length > truncateAtCommentLength) topComment.body = topComment.body.slice(0, truncateAtCommentLength) + "...";
        topComment.body = topComment.body.replace(/\n/g, "");

        return topComment;
    } catch (ex) {
        console.warn("[GetTopComment/Warning] Could not get top comment:", ex.message);
        return null;
    }
}

/**
 * @param {TextChannel} channel The receiving channel.
 * @param {string} redditUrl
 */
async function sendRedditItem(channel, subredditName, redditItem) {
    if (redditItem.selftext && redditItem.selftext.length > truncateAtDescriptionLength)
        redditItem.selftext = redditItem.selftext.slice(0, truncateAtDescriptionLength) + "... *[content was truncated]*";
    if (redditItem.title.length > truncateAtTitleLength) redditItem.title = redditItem.title.slice(0, truncateAtTitleLength) + "...";
    redditItem.author = decodeHtmlEscaping(redditItem.author) || "[deleted]";
    redditItem.title = decodeHtmlEscaping(redditItem.title) || "[deleted]";
    redditItem.selftext = decodeHtmlEscaping(redditItem.selftext) || "";

    const fullLink = "https://reddit.com" + redditItem.permalink;
    const spoiler = redditItem.title.toLowerCase().includes("nsf") || redditItem.spoiler;
    var attachedUrl = decodeHtmlEscaping(decodeURI(redditItem.url));

    const messageEmbed = new MessageEmbed()
        .setTitle(redditItem.title)
        .setURL(fullLink)
        .setAuthor(redditItem.author, await getCachedUserIconUrl(redditItem.author, true), "https://reddit.com/u/" + redditItem.author)
        .setColor(spoiler ? "#ff1111" : "#11ff11")
        .setDescription(numberToEmoijNumber(redditItem.score) + "\n" + redditItem.selftext)
        .setTimestamp(redditItem.created * 1000)
        .setFooter("On " + subredditName, await getCachedSubredditIcon(subredditName, true));
    const message = await channel.send(messageEmbed);

    if (enableVotingReactions) message.react("⬆️").then(message.react("⬇️"));

    const redditIconTask = getCachedSubredditIcon(subredditName, false);
    const redditCommentsTask = getTopComment(redditItem, subredditName);
    const userIconTask = getCachedUserIconUrl(redditItem.author, false);
    Promise.all([redditIconTask, redditCommentsTask, userIconTask]).then(([redditIcon, topComment, userIcon]) => {
        if (topComment) {
            messageEmbed.description += "\n";
            messageEmbed.description += `> **${numberToEmoijNumber(topComment.score, true)}** __${topComment.author}__\n`;
            if (!spoiler) messageEmbed.description += `> ${topComment.body}\n`;
            else messageEmbed.description += `> ||${topComment.body}||\n`;
        }
        if (redditIcon) {
            messageEmbed.setFooter("On " + subredditName, redditIcon);
        }
        if (userIcon) {
            messageEmbed.setAuthor(redditItem.author, userIcon, "https://reddit.com/u/" + redditItem.author);
        }
        message.edit(messageEmbed);
    });

    console.log(fullLink, attachedUrl);

    if (fullLink.toLowerCase().trim() != attachedUrl.toLowerCase().trim()) {
        attachedUrl = await unpackUrl(encodeURI(attachedUrl)); // encode weird characters

        var tryConvertVideo =
            redditItem.is_video ||
            attachedUrl.endsWith(".gif") ||
            attachedUrl.endsWith(".gifv") ||
            attachedUrl.endsWith(".mp4") ||
            attachedUrl.startsWith("https://v.redd.it/") ||
            attachedUrl.startsWith("https://streamable.com/") ||
            attachedUrl.startsWith("https://twitter.com/") ||
            attachedUrl.startsWith("https://gfycat.com/");

        sendRedditAttachment(channel, attachedUrl, tryConvertVideo, spoiler);
    } else {
        console.log("Info: Stale reddit post, not sending attachment", fullLink);
    }
}

function numberToEmoijNumber(num, small = false) {
    var out = "";
    if (small) {
        if (num === 0) {
            out = "🔹";
        } else if (num < 0) {
            out = "🔻";
        } else {
            out = "🔺";
        }
        out += num;
    } else {
        if (num === 0) {
            out = "⏺️ ";
        } else if (num < 0) {
            out = "⬇️ ";
            num = -num;
        } else {
            out = "⬆️ ";
        }
        const str = num + "";
        for (var i = 0; i < str.length; i++) {
            //if ((str.length - i) % 3 == 0) out += ".";
            out += String.fromCodePoint(str.codePointAt(i)) + "\u20E3";
        }
    }
    return out;
}

bot.on("message", async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith("vid/")) {
        const url = "https://reddit.codestix.nl/video/" + message.content.substring(4);
        console.log(url);
        var embed = new MessageEmbed({ video: { height: 200, width: 200, url: url, proxy_url: url, proxyURL: url } })
            .setTitle("Testing video server")
            .setDescription(url);

        message.channel.send(embed);
        return;
    }

    if (!message.content.toLowerCase().startsWith("r/")) return;

    /*if (message.author.username == "barfcomilitoon") {
    message.reply("stop keer me spacen");
    return;
    }*/

    const previousSubredditKey = `channel_${message.channel.id}_user_${message.author.id}_previous`;
    const previousSubreddit = await rgetAsync(previousSubredditKey);

    const input = message.content
        .trim()
        .toLowerCase()
        .replace(/[\\:'."]/gi, "");
    const topic = message.channel.topic
        .trim()
        .toLowerCase()
        .replace(/[\\:'."]/gi, "");

    var subredditName; // without r/
    if (input == "r/" && topic.startsWith("r/")) {
        subredditName = topic;
    } else if (input == "r//") {
        subredditName = previousSubreddit;
        if (!subredditName) return;
    } else {
        subredditName = input;
    }

    const indexKey = `channel_${message.channel.id}_reddit_${subredditName}_${defaultSubredditMethod}_index`;
    var index = (await rgetAsync(indexKey)) || 0;

    var tries = 0,
        nullTries = 0;
    var redditItem = null;
    do {
        redditItem = await getCachedRedditItem(subredditName, index++, defaultSubredditMethod);
        tries++;

        if (redditItem instanceof Error) {
            message.channel.send(
                new MessageEmbed()
                    .setTitle("Reddit error!")
                    .setDescription("There was a problem: *" + redditItem.message + "*, I am very sorry.")
                    .setColor("#ff0000")
                    .setThumbnail(redditIcon)
            );
            return;
        }

        if (redditItem === null) {
            if (++nullTries >= 5) {
                console.log("Warning: resetting subreddit index");
                index = 0;
                nullTries = 0;
            }
        }

        if (tries >= 20) {
            message.channel.send(
                new MessageEmbed()
                    .setTitle("Reddit error!")
                    .setDescription("No posts are available, I am very sorry.")
                    .setColor("#ff0000")
                    .setThumbnail(redditIcon)
            );
            return;
        }
    } while (
        redditItem === null ||
        (tryRemoveNsfw && redditItem.title.toLowerCase().includes("nsf")) ||
        (redditItem.selftext || "").length > skipAtDescriptionLength ||
        minimumVotes > Math.abs(redditItem.score)
    );

    redisClient.multi().setex(indexKey, cacheIndexTtl, index).setex(previousSubredditKey, cachePreviousSubredditTtl, subredditName).exec();

    sendRedditItem(message.channel, subredditName, redditItem);
});
