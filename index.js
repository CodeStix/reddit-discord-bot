require("dotenv").config();
const { Client: DiscordClient, MessageAttachment, MessageEmbed, Message, TextChannel } = require("discord.js");
const ax = require("./axiosInstance");
const util = require("util");
const path = require("path");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const cheerio = require("cheerio");
const redis = require("redis");
const redditCache = require("./cachedReddit");

const discordBot = new DiscordClient();

var redisClient = new redis.RedisClient({
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD,
    no_ready_check: true,
    enable_offline_queue: false,
})

const token = "NzExNTI0NDA1MTYzMDY1Mzg1.XsEQ-w.ulbbTU95eEMpvP5sqXJqEMGnebI";

const rkeysAsync = util.promisify(redisClient.keys).bind(redisClient);
const rgetAsync = util.promisify(redisClient.get).bind(redisClient);
const rsetexAsync = util.promisify(redisClient.setex).bind(redisClient);
const existsAsync = util.promisify(fs.exists);
const statAsync = util.promisify(fs.stat);
const renameAsync = util.promisify(fs.rename);
const execAsync = util.promisify(require("child_process").exec);
const execOptions = {
    cwd: __dirname,
};

const redditIcon = "https://www.redditstatic.com/desktop2x/img/favicon/apple-icon-72x72.png";

let cacheVideos = true;
let enableTopComments = true;
let skipAtDescriptionLength = 400;
let truncateAtDescriptionLength = 375; // Max is 1024
let truncateAtTitleLength = 200; // Max is 256
let truncateAtCommentLength = 250; // Max is 1024
let tryRemoveNsfw = false;
let enableVotingReactions = false;
let minimumPostVotes = 0;
let commentSortMode = "top"; // Can be: confidence, top, new, controversial, old, random, qa, live

const cacheFutureVideoIn = 4; // Cache x videos into the future
const maxVideoDownloadSize = 1000 * 1000 * 100;
const cachePerPages = 30; // The amount of reddit items to cache in one page
const cachePreviousUserSubredditTtl = 60 * 30; // Remember the user's previous subreddit for x seconds

redisClient.once("ready", async () =>
{
    console.log("[Redis] Connected");
});
redisClient.on("error", (err) =>
{
    console.error("[Redis/Error]", err);
});
redisClient.on("warning", (warn) =>
{
    console.warn("[Redis/Warning]", warn);
});

discordBot.login(token);
discordBot.on("ready", () =>
{
    console.log("[DiscordBotConnect] Connected");
});
discordBot.on("error", (err) =>
{
    console.error("[DiscordBot/Error] Caught error:", err);
});

/**
 * Convert a redirecting, 50/50, bit.ly, imgur... url to the direct url.
 * @param {string} url The url to unpack/resolve.
 */
async function unpackUrl(url)
{
    if (url.startsWith("https://5050") || url.startsWith("http://5050") || url.startsWith("http://bit.ly") || url.startsWith("https://bit.ly"))
    {
        try
        {
            url = (await ax.head(url, { maxRedirects: 5 })).request.res.responseUrl;
        } catch (ex)
        {
            console.log("[5050Convert/Warning] Could not get redirected url", ex.message);
        }
    }

    if (url.startsWith("https://imgur.com/"))
    {
        url = "https://i.imgur.com/" + url.substring("https://imgur.com/".length);
        console.log("[ImgurExtract] Extracted imgur url");
    } else if (url.startsWith("https://postimg.cc/"))
    {
        try
        {
            const response = await ax.get(url);
            const ch = cheerio.load(response.data);
            url = ch("head meta[property='og:image']").attr("content");
            console.log("[PostImgExtract] Extracted postimg.cc url", url);
        } catch (ex)
        {
            console.warn("[PostImgExtract/Warning] Could not extract postimg.cc image", ex.message);
        }
    }
    return url;
}

function getPathForVideo(videoUrl, maxVideoSize)
{
    const videoUrlHash = crypto.createHash("sha1").update(videoUrl, "binary").digest("hex");
    return __dirname + "/cache/videos/" + videoUrlHash + "-" + maxVideoSize + ".mp4";
}

async function getCachedVideo(url, maxVideoSize = 1000 * 1000 * 8)
{
    try
    {
        const videoFile = getPathForVideo(url, maxVideoSize);
        console.log("exists?", videoFile);
        if (await existsAsync(videoFile)) return videoFile;
        console.log("ye");

        if (!cacheVideos) return null;

        // https://github.com/ytdl-org/youtube-dl/blob/master/README.md#format-selection
        const tempVideoFile = videoFile + ".temp.mp4";
        await execAsync(
            `youtube-dl -f "[filesize>6M][filesize<=8M]/[filesize>4M][filesize<=6M]/[filesize>2M][filesize<=4M]/[filesize<=2M]/bestvideo+bestaudio/best/worst" --max-filesize ${maxVideoDownloadSize} --no-playlist --retries 3 --output "${tempVideoFile}" "${url}"`, // --no-warnings --print-json --no-progress
            execOptions
        );

        // Will error is file not exists
        const videoInfo = JSON.parse(
            (await execAsync(`ffprobe -i "${tempVideoFile}" -v quiet -print_format json -show_format -hide_banner`, execOptions)).stdout
        );

        // Reencode if too large or if mpegts file (discord does not display these)
        // https://unix.stackexchange.com/questions/28803/how-can-i-reduce-a-videos-size-with-ffmpeg
        // https://stackoverflow.com/questions/6239350/how-to-extract-duration-time-from-ffmpeg-output
        if (videoInfo.format.size > maxVideoSize || videoInfo.format.format_name.includes("mpegts") || videoInfo.format.format_name.includes("gif"))
        {
            //console.log("[ensureCachedVideo] Info: Reencoding/compressing with ffmpeg");
            var targetBitrate = (maxVideoSize * 8) / (videoInfo.format.duration * 1.5); //videoInfo.format.bit_rate * (maxVideoSize / videoInfo.format.size) * 0.75;
            await execAsync(
                `ffmpeg -ss ${videoInfo.format.start_time} -i "${tempVideoFile}" -b:v ${targetBitrate} "${videoFile}"`, // -r 20 -vf scale=720:-2
                execOptions
            );
            fs.unlink(tempVideoFile, () => { });
        } else
        {
            await renameAsync(tempVideoFile, videoFile);
        }

        return videoFile;
    } catch (ex)
    {
        console.warn("[ensureCachedVideo] Error: Could not upload/convert video: ", ex.message);
        return null;
    }
}

/**
 * @param {TextChannel} channel
 * @param {string} url An url attachment for the reddit item.
 */
async function sendRedditAttachment(channel, url, isVideo, markSpoiler)
{
    /**
     * @param {string} url
     * @param {'url' | 'image' | 'video'} type
     */
    async function sendAs(url, type, message = "")
    {
        switch (type)
        {
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

    if (cacheVideos && isVideo)
    {
        const videoFile = await getCachedVideo(url);
        if (videoFile)
        {
            await sendAs(videoFile, "video");
        } else
        {
            console.log("[sendRedditAttachment] Warning: could not send as video, sending as url");
            await sendAs(url, "url", "⚠️ **Could not upload video, take a url:** ");
        }
    }
    else if (
        url.endsWith(".gif") ||
        url.endsWith(".png") ||
        url.endsWith(".jpg") ||
        url.startsWith("https://i.redd.it/") ||
        url.startsWith("https://i.postimg.cc/")
    )
    {
        try
        {
            await sendAs(url, "image");
        } catch (ex)
        {
            console.log("[SendImage/Warning] Could not send image:", ex.message);
            await sendAs(url, "url", "⚠️ **Error while uploading image, take a url:** ");
        }
    }
    else
    {
        await sendAs(url, "url");
    }
}

/**
 * @param {string} subredditName
 * @param {number} index
 * @param {'hot' | 'rising' | 'top' | 'new' | 'best'} mode
 * @param {'hour' | 'day' | 'week' | 'month' | 'year' | 'all'} timespan
 * @param {boolean} useCache
 */
async function getCachedRedditItem(subredditName, index, mode, timespan, useCache = true)
{
    subredditName = subredditName.toLowerCase();
    const baseKey = `r${subredditName}:${mode === "top" ? mode + ":" + timespan : mode}`;
    const page = Math.floor(index / cachePerPages);
    try
    {
        if (useCache)
        {
            var cachedData = await redditCache.getResponse(subredditName, mode, timespan, page);
            if (cachedData && index % cachePerPages < cachedData.children.length) return cachedData.children[index % cachePerPages].data;
        }

        var after = null;
        if (page > 0)
        {
            after = await rgetAsync(`${baseKey}:p${page - 1}:after`);
            if (!after)
            {
                console.warn("[GetRedditItem/Warning] Could not get 'after', probably end of feed");
                return null;
            }
        }

        var response = await ax.get(`https://api.reddit.com/r/${subredditName}/${mode}?limit=${cachePerPages}&after=${after}&t=${timespan}`, {
            responseType: "json",
        });
        var data = Array.isArray(response.data) ? response.data[0].data : response.data.data;
        if (data.children.length <= 0 || !data.children[0].data.subreddit) throw new Error("No items returned.");

        redditCache.cacheResponse(subredditName, data, mode, timespan, page);

        return data.children[index % cachePerPages].data;
    }
    catch (ex)
    {
        console.warn("Error: could not get subreddit items:", ex);
        return ex;
    }
}

async function getTopComment(redditItem)
{
    try
    {
        const response = await ax.get(`https://api.reddit.com/r/${redditItem.subreddit}/comments/${redditItem.id}?limit=2&sort=${commentSortMode}`, {
            responseType: "json",
        });

        fs.writeFile("./badrequests/latestcomment.json", JSON.stringify(response.data), () => { });
        if (response.data.length < 2 || response.data[1].data.children.length < 1) return;

        const comments = response.data[1].data.children;
        var topComment = comments.find((val) => !val.data.score_hidden);
        if (!topComment) return;
        topComment = topComment.data;

        if (topComment.body.length > truncateAtCommentLength) topComment.body = topComment.body.slice(0, truncateAtCommentLength) + "...";
        return topComment;
    } catch (ex)
    {
        console.warn("[GetTopComment/Warning] Could not get top comment:", ex.message);
        return null;
    }
}

function createIndentedComment(header, content, level, spoiler)
{
    if (level === 0)
    {
        if (spoiler) return "> " + header + "\n> ||" + content + "||\n";
        else return "> " + header + "\n> " + content + "\n";
    }

    const maxWidth = 76; // discord embeds have a width of 75 characters
    const width = maxWidth - level * 9;
    var out = "";
    var indent = "";

    for (var i = 0; i < level; i++) indent += "\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0";

    for (var i = 0; i < content.length / width; i++)
    {
        if ((i + 1) * width < content.length) out += "> " + indent + content.substring(i * width, (i + 1) * width) + "\n";
        else out += "> " + indent + content.substring(i * width) + "\n";
    }

    return "> " + indent + header + "\n" + out;
}

function isVideoUrl(url)
{
    return (
        url.endsWith(".gif") ||
        url.endsWith(".gifv") ||
        url.endsWith(".mp4") ||
        url.startsWith("https://v.redd.it/") ||
        url.startsWith("https://streamable.com/") ||
        url.startsWith("https://twitter.com/") ||
        url.startsWith("https://gfycat.com/")
    );
}

/**
 * @param {TextChannel} channel The receiving channel.
 * @param {string} redditUrl
 */
async function sendRedditItem(channel, redditItem)
{
    if (redditItem.selftext && redditItem.selftext.length > truncateAtDescriptionLength)
        redditItem.selftext = redditItem.selftext.slice(0, truncateAtDescriptionLength) + "... *[content was truncated]*";
    if (redditItem.title.length > truncateAtTitleLength) redditItem.title = redditItem.title.slice(0, truncateAtTitleLength) + "...";
    redditItem.author = redditItem.author || "[deleted]";
    redditItem.title = redditItem.title || "[deleted]";
    redditItem.url = encodeURI(redditItem.url); // encode weird characters

    const fullLink = encodeURI("https://www.reddit.com" + redditItem.permalink);
    const asSpoiler = redditItem.spoiler || redditItem.over_18 || redditItem.title.toLowerCase().includes("nsf");

    const messageEmbed = new MessageEmbed()
        .setTitle(redditItem.title)
        .setURL(fullLink)
        .setAuthor(redditItem.author, await redditCache.getUserIcon(redditItem.author, true), "https://reddit.com/u/" + redditItem.author)
        .setColor(asSpoiler ? "#ff1111" : "#11ff11")
        .setDescription(numberToEmoijNumber(redditItem.score) + "\n" + redditItem.selftext)
        .setTimestamp(redditItem.created * 1000)
        .setFooter("On r/" + redditItem.subreddit, await redditCache.getSubredditIcon(redditItem.subreddit, true));
    const message = await channel.send(messageEmbed);

    if (enableVotingReactions) message.react("⬆️").then(message.react("⬇️"));

    const redditIconTask = redditCache.getSubredditIcon(redditItem.subreddit, false);
    const redditCommentsTask = enableTopComments ? getTopComment(redditItem) : undefined;
    const userIconTask = redditCache.getUserIcon(redditItem.author, false);
    Promise.all([redditIconTask, redditCommentsTask, userIconTask]).then(([redditIcon, topComment, userIcon]) =>
    {
        if (topComment && enableTopComments && topComment.score >= 0.06 * redditItem.score)
        {
            topComment.body = topComment.body.replace(/\n/g, "");

            messageEmbed.description +=
                "\n" + createIndentedComment(`**${numberToEmoijNumber(topComment.score, true)}** __${topComment.author}__`, topComment.body, 0, false);

            if (topComment.replies && topComment.replies.data && topComment.replies.data.children.length > 0)
            {
                var secondComment = topComment.replies.data.children[0].data;
                if (secondComment.score > topComment.score / 3)
                {
                    secondComment.body = secondComment.body.replace(/\n/g, "");
                    messageEmbed.description += createIndentedComment(
                        `**${numberToEmoijNumber(secondComment.score, true)}** __${secondComment.author}__`,
                        secondComment.body,
                        1,
                        false
                    );
                }
            }
        }
        if (redditIcon)
        {
            messageEmbed.setFooter("On r/" + redditItem.subreddit, redditIcon);
        }
        if (userIcon)
        {
            messageEmbed.setAuthor(redditItem.author, userIcon, "https://reddit.com/u/" + redditItem.author);
        }
        message.edit(messageEmbed);
    });

    console.log(fullLink, redditItem.url);

    if (fullLink != redditItem.url)
    {
        redditItem.url = await unpackUrl(redditItem.url);

        sendRedditAttachment(channel, redditItem.url, redditItem.is_video || isVideoUrl(redditItem.url), asSpoiler);
    } else
    {
        console.log("[sendRedditItem] Info: Stale reddit post, not sending attachment", fullLink);
    }
}

function numberToEmoijNumber(num, small = false)
{
    var out = "";
    if (small)
    {
        if (num === 0)
        {
            out = "🔹";
        } else if (num < 0)
        {
            out = "🔻";
        } else
        {
            out = "🔺";
        }
        out += num;
    } else
    {
        if (num === 0)
        {
            out = "⏺️ ";
        } else if (num < 0)
        {
            out = "⬇️ ";
            num = -num;
        } else
        {
            out = "⬆️ ";
        }
        const str = num + "";
        for (var i = 0; i < str.length; i++)
        {
            //if ((str.length - i) % 3 == 0) out += ".";
            out += String.fromCodePoint(str.codePointAt(i)) + "\u20E3";
        }
    }
    return out;
}

const redditInputRegex = /r\/([a-z0-9 _]{1,20})?(\/(hot|rising|new|best|top)-?(hour|day|week|month|year|all)?)?(\/(reset)?)?/i;

discordBot.on("warn", (warning) =>
{
    console.warn("[Discord bot warning] " + warning);
});

discordBot.on("messageUpdate", (message) =>
{
    if (message.author.bot) return;


    console.log("message was updated:", message.content);
});

discordBot.on("message", async (message) =>
{
    if (message.author.bot) return;

    var input = (message.content || "").trim().toLowerCase();
    if (!input.startsWith("r/")) return;

    if (input === "r//")
    {
        input = await rgetAsync(`ch${message.channel.id}:u${message.author.id}:prev`);
        if (!input)
        {
            message.reply("I don't remember your previous input, please type it yourself.");
            return;
        }
    }

    var userInput = redditInputRegex.exec(input);
    var channelTopicInput = redditInputRegex.exec((message.channel.topic || "").trim().toLowerCase());
    var subredditName,
        subredditMode = "hot",
        subredditTopTimespan = "week";

    if (userInput && userInput[3]) subredditMode = userInput[3];
    else if (channelTopicInput && channelTopicInput[3]) subredditMode = channelTopicInput[3];

    if (userInput && userInput[4]) subredditTopTimespan = userInput[4];
    else if (channelTopicInput && channelTopicInput[4]) subredditTopTimespan = channelTopicInput[4];

    if (subredditMode === "reset")
    {
        var keys = userInput[1] ? await rkeysAsync(`r${userInput[1]}*ch${message.channel.id}:idx`) : await rkeysAsync(`*ch${message.channel.id}:idx`);

        var chain = redisClient.multi();
        keys.forEach((key) => (chain = chain.del(key)));

        chain.exec(() =>
        {
            if (err) console.error("[sendInChannel] Warning: Could not reset feed:", err);
            message.reply("Sure, feed has has been reset.");
        });
        return;
    }

    if (userInput && userInput[1])
    {
        subredditName = userInput[1];
    } else if (channelTopicInput && channelTopicInput[1])
    {
        subredditName = channelTopicInput[1];
    } else
    {
        message.reply("No subreddit specified by user and channel.");
        return;
    }

    if (subredditName === "typeyoursubreddithere")
    {
        message.reply("Are you really that stupid? 😐");
        return;
    }

    const indexKey = `r${subredditName}:${subredditMode === "top" ? subredditMode + ":" + subredditTopTimespan : subredditMode}:ch${message.channel.id}:idx`;
    var index = (await rgetAsync(indexKey)) || 0;

    var tries = 0;
    var redditItem = null;
    do
    {
        const useCache = index !== 0;
        redditItem = await getCachedRedditItem(subredditName, index++, subredditMode, subredditTopTimespan, useCache);

        // Cache future video post
        getCachedRedditItem(subredditName, index + 4, subredditMode, subredditTopTimespan, useCache).then(async (futureRedditItem) =>
        {
            if (!futureRedditItem || futureRedditItem instanceof Error) return;
            futureRedditItem.url = await unpackUrl(futureRedditItem.url);
            if (futureRedditItem.is_video || isVideoUrl(futureRedditItem.url))
            {
                const cachedVideoPath = await getCachedVideo(futureRedditItem.url); // will cache video
                if (cachedVideoPath) console.log("[sendInChannel] Cached future video", futureRedditItem.url, "->", cachedVideoPath);
            }
        });

        tries++;

        if (redditItem instanceof Error)
        {
            message.channel.send(
                new MessageEmbed()
                    .setTitle("❌ Reddit error!")
                    .setDescription(`There was a problem getting a post from r/${subredditName}/${subredditMode}: *${redditItem.message}*, I am very sorry.`)
                    .setColor("#ff0000")
                    .setThumbnail(redditIcon)
            );
            return;
        }

        if (!redditItem)
        {
            message.channel.send(
                new MessageEmbed()
                    .setTitle("⚠️ End of feed!")
                    .setDescription(
                        `The end of **r/${subredditName}/${subredditMode}** has been reached, if you request more posts from this subreddit (and filter, ${subredditMode}), you will notice that some will get reposted. Come back later for more recent posts.`
                    )
                    .setColor("#ffff00")
            );
            index = 0;
            return;
        }

        if (tries > cachePerPages)
        {
            message.channel.send(
                new MessageEmbed()
                    .setTitle("❌ Reddit error!")
                    .setDescription("No posts match your filter (and globally enabled filters), I am very sorry.")
                    .setColor("#ff0000")
                    .setThumbnail(redditIcon)
            );
            return;
        }
    } while (
        (tryRemoveNsfw && redditItem.title.toLowerCase().includes("nsf")) ||
        (redditItem.selftext || "").length > skipAtDescriptionLength ||
        minimumPostVotes > Math.abs(redditItem.score)
    );

    const indexTtl = redditCache.getTtlForRedditIndex(subredditMode, subredditTopTimespan);
    var chain = redisClient.multi();
    if (indexTtl >= 0) chain = chain.setex(indexKey, indexTtl, index);
    else chain = chain.set(indexKey, index);
    chain.setex(`ch${message.channel.id}:u${message.author.id}:prev`, cachePreviousUserSubredditTtl, input).exec();

    sendRedditItem(message.channel, redditItem);
});
