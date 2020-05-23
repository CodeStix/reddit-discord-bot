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

const getAsync = util.promisify(redisClient.get).bind(redisClient);
const setexAsync = util.promisify(redisClient.setex).bind(redisClient);
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
let truncateAtDescriptionLength = 250;
let tryRemoveNsfw = false;
let enableVotingReactions = false;
let minimumVotes = 1;
let defaultSubredditMethod = "top"; // hot | rising | top | new

const videosPath = path.join(__dirname, "cache", "video");

redisClient.once("ready", async () => {
    console.log("[Redis] Connected");

    const res = await getAsync("test");
    console.log(res);
});
redisClient.on("error", (err) => {
    console.error("[Redis/Error]", err);
});
redisClient.on("warning", (warn) => {
    console.warn("[Redis/Warning]", warn);
});

function decodeHtmlEscaping(str) {
    return str.replace("&amp;", "&").replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">");
}

// Streamable account: stijnvantvijfde@gmail.com 3vGrFAKTrvQg8UHh

console.log("Connecting to discord...");

bot.login(token);
bot.on("ready", () => {
    console.log("Connected.");
});

// https://www.reddit.com/user/timawesomeness/comments/813jpq/default_reddit_profile_pictures/
function getRandomDefaultAvatarUrl() {
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

async function getAuthorAvatarUrl(authorName) {
    // https://www.reddit.com/user/CodeStix/about.json
    return getRandomDefaultAvatarUrl();
}

/**
 * @param {TextChannel} channel
 * @param {string} url An url attachment for the reddit item.
 */
async function sendRedditAttachment(channel, url, tryConvertVideo, markSpoiler) {
    url = encodeURI(url);
    console.log(url);
    /*var currentStatusAwaiter = channel.send("Loading...").catch((err) => {
        console.warn("Warning: could not set status:", err);
    });*/

    function setStatus(status) {
        // currentStatusAwaiter.then((m) => (status ? m.edit(status) : m.delete()));
    }

    /**
     * @param {string} url
     * @param {'url' | 'pngImage' | 'video'} type
     */
    function sendAs(url, type) {
        switch (type) {
            case "url":
                if (markSpoiler) channel.send("||" + url + "||", { spoiler: true });
                else channel.send(url);
                break;
            case "pngImage":
                if (markSpoiler) channel.send(new MessageAttachment(url, "SPOILER_.gif"));
                else channel.send(new MessageAttachment(url, "image.gif"));
                break;
            case "video":
                if (markSpoiler) channel.send(new MessageAttachment(url, "SPOILER_.mp4"));
                else channel.send(new MessageAttachment(url, "video.mp4"));
                break;
            default:
                console.warn("Warning: Invalid sendAsSpoiler type", type);
                return;
        }
    }

    if (url.startsWith("https://5050") || url.startsWith("http://5050") || url.startsWith("http://bit.ly") || url.startsWith("https://bit.ly")) {
        try {
            url = (await axios.head(url, { maxRedirects: 5 })).request.res.responseUrl;
        } catch (ex) {
            console.log("Warning: Could not get redirected url", ex.message);
        }
    }

    if (url.startsWith("https://imgur.com/")) {
        url = "https://i.imgur.com/" + url.substring("https://imgur.com/".length);
        console.log("Info: Extracted imgur url");
    } else if (url.startsWith("https://postimg.cc/")) {
        try {
            const response = await axios.get(url);
            const ch = cheerio.load(response.data);
            url = ch("head meta[property='og:image']").attr("content");
            console.log("Info: Extracted postimg.cc url", url);
        } catch (ex) {
            console.log("Warning: could not extract postimg.cc image", ex.message);
        }
    }

    if (!tryConvertVideo) {
        if (
            //url.endsWith(".gif") ||
            url.endsWith(".gifv") ||
            url.endsWith(".mp4") ||
            url.startsWith("https://v.redd.it/") ||
            url.startsWith("https://streamable.com/") ||
            url.startsWith("https://twitter.com/") ||
            url.startsWith("https://gfycat.com/")
            /*|| (url.startsWith("https://i.redd.it/") && url.endsWith(".gif")) ||
            (url.startsWith("https://imgur.com/") && url.endsWith(".mp4"))*/
        ) {
            tryConvertVideo = true;
        }
    }

    if (downloadVideos && tryConvertVideo) {
        const videoUrlHash = crypto.createHash("sha1").update(url, "binary").digest("hex");
        const videoFile = path.join(videosPath, videoUrlHash + ".mp4");

        try {
            if (await existsAsync(videoFile)) {
                sendAs(videoFile, "video");
                //console.log("probe", JSON.parse((await exec(`ffprobe -i "${videoFile}" -v quiet -print_format json -show_format -hide_banner`)).stdout));
            } else {
                setStatus("🎥 Converting video for the first time ...");
                const tempVideoFile = videoFile + ".temp.mp4";
                // https://github.com/ytdl-org/youtube-dl/blob/master/README.md#format-selection
                const { stdout, stderr } = await execAsync(
                    `youtube-dl.exe -f "best[filesize<8M]/(bestvideo[width<=800]+bestaudio)[filesize<8M]/worstvideo[width>=480]+bestaudio/best" --no-playlist --retries 3 --output "${tempVideoFile}" "${url}"`, // --max-filesize ${youtubeDlMaxFileSize}  --exec "move {} \"${tempVideoFile}\"" --cache-dir "${youtubeDlCachePath}"
                    execOptions
                );

                if (await existsAsync(tempVideoFile)) {
                    const targetByteCount = 1000 * 1000 * 8;
                    const videoFileInfo = await statAsync(tempVideoFile);
                    const videoInfo = JSON.parse(
                        (await execAsync(`ffprobe.exe -i "${tempVideoFile}" -v quiet -print_format json -show_format -hide_banner`, execOptions)).stdout
                    );

                    // reencode if too large or if mpegts file (discord does not display these)
                    if (videoFileInfo.size > targetByteCount || videoInfo.format.format_name.includes("mpegts")) {
                        setStatus("🗜️ Making the video a little smaller ...");

                        // video is too big, needs to be compressed
                        // https://unix.stackexchange.com/questions/28803/how-can-i-reduce-a-videos-size-with-ffmpeg
                        // https://stackoverflow.com/questions/6239350/how-to-extract-duration-time-from-ffmpeg-output
                        await execAsync(
                            `ffmpeg.exe -i "${tempVideoFile}" -b:v ${
                                (targetByteCount * 8) / (videoInfo.format.duration * 1.25)
                            } -vf scale=800:-2 "${videoFile}"`, //-filter_complex "scale=iw*min(1\\,min(800/iw\\,600/ih)):-1"
                            execOptions
                        );
                        fs.unlink(tempVideoFile, () => {});
                    } else {
                        await renameAsync(tempVideoFile, videoFile);
                    }

                    if (await existsAsync(videoFile)) {
                        sendAs(videoFile, "video");
                    } else {
                        console.log("Warning: Could not [compress] video", stdout, stderr);
                        setStatus("⚠️ **Error while compressing video, take a url:**");
                        sendAs(url, "url");
                        return;
                    }
                } else {
                    console.log("Warning: Could not [download] video", stdout, stderr);
                    execAsync(`youtube-dl.exe -F "${url}"`, execOptions).then((e) => console.log("Info: Available video formats:", e.stdout, e.stderr));
                    setStatus("⚠️ **Error while converting video, take a url:**");
                    sendAs(url, "url");
                    return;
                }
            }
        } catch (ex) {
            console.log("Warning: Could not [upload] video: ", ex.message);
            setStatus("⚠️ **Error while uploading video, take a url:**");
            sendAs(url, "url");
            return;
        }
    } else if (
        url.startsWith("https://www.youtube.com/") ||
        url.startsWith("https://youtube.com/") ||
        url.startsWith("https://youtube-nocookie.com/") ||
        url.startsWith("https://m.youtube.com/") ||
        url.startsWith("https://youtu.be/")
    ) {
        sendAs(url, "url");
    } else if (
        url.startsWith("https://i.redd.it/") ||
        url.startsWith("https://i.postimg.cc/") ||
        url.endsWith(".gif") ||
        /*url.startsWith("https://i.imgur.com/") && */ url.endsWith(".png") ||
        url.endsWith(".jpg") /*|| url.startsWith("https://gfycat.com/")*/
    ) {
        try {
            sendAs(url, "pngImage");
        } catch (ex) {
            console.log("Warning: could not send image:", ex.message);
            setStatus("⚠️ **Error while uploading image, take a url:**");
            sendAs(url, "url");
            return;
        }
    } else {
        sendAs(url, "url");
    }

    setStatus("");
}

const cachePerPages = 35; // max is 100
const redditResponseDataCache = {};

async function getCachedRedditItem(subredditName, index, method = "hot") {
    // currently no cache is active
    const page = Math.floor(index / cachePerPages);
    try {
        const key = `reddit_${subredditName}_${method}_${page}`;
        if (key in redditResponseDataCache) {
            var data = redditResponseDataCache[key];
            if (index % cachePerPages < data.children.length) return data.children[index % cachePerPages].data;
            else return null;
        } else {
            var after;
            if (page === 0) {
                after = null;
            } else {
                const previousPageKey = `reddit_${subredditName}_${method}_${page - 1}`;
                if (previousPageKey in redditResponseDataCache) {
                    after = redditResponseDataCache[previousPageKey].after;
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
            redditResponseDataCache[key] = data;
            console.log("Info: reddit response stored in cache under key:", key, data.children.length, "items");
            return data.children[index % cachePerPages].data;
        }
    } catch (ex) {
        console.warn("Error: could not get subreddit items:", ex.message);
        return ex;
    }
}

/**
 * @param {TextChannel} channel The receiving channel.
 * @param {string} redditUrl
 */
async function sendRedditItem(channel, subredditName, redditItem) {
    if (redditItem.selftext && redditItem.selftext.length > truncateAtDescriptionLength)
        redditItem.selftext = redditItem.selftext.slice(0, truncateAtDescriptionLength) + "... *[content was truncated]*";

    const fullLink = "https://reddit.com" + redditItem.permalink;
    const attachedUrl = decodeURI(redditItem.url).replace("&amp;", "&");
    const nsfw = redditItem.title.toLowerCase().includes("nsf");

    const message = await channel.send(
        new MessageEmbed()
            .setTitle(decodeHtmlEscaping(redditItem.title || "[no title]"))
            .setURL(fullLink)
            .setAuthor(
                decodeHtmlEscaping(redditItem.author || "[deleted]"),
                await getAuthorAvatarUrl(redditItem.author),
                "https://reddit.com/u/" + redditItem.author
            )
            .setColor(nsfw ? "#ff1111" : "#11ff11")
            .setDescription((redditItem.hide_score ? "⏺️" : numberToEmoijNumber(redditItem.score)) + "\n" + decodeHtmlEscaping(redditItem.selftext || ""))
            .setTimestamp(redditItem.created * 1000)
            //.setImage(attachedUrl)
            .setFooter("On " + subredditName)
    );

    if (enableVotingReactions) message.react("⬆️").then(message.react("⬇️"));

    if (fullLink.toLowerCase().trim() != attachedUrl.toLowerCase().trim()) {
        sendRedditAttachment(channel, attachedUrl, redditItem.is_video, nsfw);
    } else {
        console.log("Info: Stale reddit post, not sending attachment", fullLink);
    }
}

function numberToEmoijNumber(num) {
    var out = "";
    if (num < 0) {
        out += "⬇️ ";
        num = -num;
    } else {
        out += "⬆️ ";
    }
    const str = num + "";
    for (var i = 0; i < str.length; i++) {
        //if ((str.length - i) % 3 == 0) out += ".";
        out += String.fromCodePoint(str.codePointAt(i)) + "\u20E3";
    }
    return out;
}

/**
 *
 * @param {Message} message
 * @param {number} num
 */
async function reactNumber(message, num) {
    const str = num + "";
    console.log(str);
    for (var i = 0; i < str.length; i++) {
        await message.react(String.fromCodePoint(str.codePointAt(i)) + "\u20E3");
    }
}

var channelData = {};

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

    var data = channelData[message.channel.id];
    if (!data) {
        data = {};
        channelData[message.channel.id] = data;
    }

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
        subredditName = data.previousSubreddit;
        if (!subredditName) return;
    } else if (input == "r//data") {
        message.channel.send("`" + util.inspect(channelData, true, 4) + "`");
        return;
    } else if (input == "r//cache") {
        message.channel.send("`" + util.inspect(redditResponseDataCache) + "`");
        return;
    } else {
        subredditName = input;
    }
    data.previousSubreddit = subredditName;

    if (!data.subreddits) data.subreddits = {};
    var subredditData = data.subreddits[subredditName];
    if (!subredditData) {
        subredditData = {};
        data.subreddits[subredditName] = subredditData;
    }

    if (subredditData.index === undefined) subredditData.index = 0;

    var tries = 0,
        nullTries = 0;
    var redditItem = null;
    do {
        redditItem = await getCachedRedditItem(subredditName, subredditData.index++, defaultSubredditMethod);
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
                subredditData.index = 0;
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

    sendRedditItem(message.channel, subredditName, redditItem);
});
