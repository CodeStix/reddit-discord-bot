require("dotenv").config();
const { Client: DiscordClient, MessageAttachment, MessageEmbed, Message, TextChannel } = require("discord.js");
const ax = require("./axiosInstance");
const util = require("util");
const fs = require("fs");
const cheerio = require("cheerio");
const redis = require("redis");
const redditCache = require("./reddit");
const video = require("./video");

const redditIcon = "https://www.redditstatic.com/desktop2x/img/favicon/apple-icon-72x72.png";
const sadRedditIcon = "https://cdn.discordapp.com/attachments/711525975636049921/720991277918847047/redditsad.png";

let downloadVideos = true;
let enableTopComments = true;
let skipAtDescriptionLength = 400;
let truncateAtDescriptionLength = 375; // Max is 1024
let truncateAtTitleLength = 200; // Max is 256
let truncateAtCommentLength = 200; // Max is 1024
let tryRemoveNsfw = false;
let enableVotingReactions = false;
let minimumPostVotes = 0;
let commentSortMode = "top"; // Can be: confidence, top, new, controversial, old, random, qa, live

const cacheFutureVideoIn = 3; // Cache x videos into the future
const cachePreviousUserSubredditTtl = 60 * 30; // Remember the user's previous subreddit for x seconds

const discordBot = new DiscordClient();
discordBot.login(process.env.DISCORD_TOKEN);
discordBot.on("ready", () =>
{
    console.log("[discord] Connected");
});
discordBot.on("error", (err) =>
{
    console.error("[discord] Error:", err);
});

var redisClient = new redis.RedisClient({
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD,
    no_ready_check: true,
    enable_offline_queue: false,
})
redisClient.once("ready", async () =>
{
    console.log("[redis] Connected");
});
redisClient.on("error", (err) =>
{
    console.error("[redis] Error:", err);
});
redisClient.on("warning", (warn) =>
{
    console.warn("[redis] Warning:", warn);
});
const rkeysAsync = util.promisify(redisClient.keys).bind(redisClient);
const rgetAsync = util.promisify(redisClient.get).bind(redisClient);
const rsetexAsync = util.promisify(redisClient.setex).bind(redisClient);

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
            console.log("[unpackUrl] Warning: Could not get redirected url", ex.message);
        }
    }

    if (url.startsWith("https://imgur.com/gallery/")) 
    {
        url = "https://imgur.com/a/" + url.substring("https://imgur.com/gallery/".length);
    }

    if (url.startsWith("https://postimg.cc/")
        || url.startsWith("https://www.flickr.com/")
        || url.startsWith("https://imgur.com/")
        || url.startsWith("https://gfycat.com/"))
    {
        try
        {
            // <meta property="og:video" content="https://i.imgur.com/Xob3epw.mp4"/>
            // <meta property="og:image" content="https://i.imgur.com/I42mS3H.jpg?fb" />
            const response = await ax.default.get(url);
            const ch = cheerio.load(response.data);

            var elem = ch("head meta[property='og:video']");
            if (elem) 
            {
                // Is video
                url = elem.attr("content");
            }
            else 
            {
                elem = ch("head meta[property='og:image']");

                if (elem)
                    url = elem.attr("content");
            }

            console.log("[unpackUrl] Extracted imgur/postimg url", url);
        }
        catch (ex)
        {
            console.warn("[unpackUrl] Warning: Could not extract imgur/postimg image", ex);
        }
    }
    return url;
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
    }

    if (downloadVideos && isVideo)
    {
        const videoFile = await video.getCachedVideo(url);
        if (videoFile)
        {
            await sendAs(videoFile, "video");
        }
        else
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
        }
        catch (ex)
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

async function getTopComment(redditItem, maxDepth = 2)
{
    try
    {
        const response = await ax.get(`https://api.reddit.com/r/${redditItem.subreddit}/comments/${redditItem.id}?depth=${maxDepth}&limit=${maxDepth}&sort=${commentSortMode}`, {
            responseType: "json",
        });

        //fs.writeFile("./badrequests/latestcomment.json", JSON.stringify(response.data), () => { });
        if (!response.data || response.data.length < 2 || response.data[1].data.children.length < 1) return;

        const comments = response.data[1].data.children;
        var topComment = comments.find((val) => !val.data.score_hidden);
        if (!topComment) return;
        return topComment.data;
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
    const width = maxWidth - level * 5;
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
        if (enableTopComments) //  && topComment.score >= 0.06 * redditItem.score
        {
            var currentComment = topComment;
            var level = 0;
            messageEmbed.description += "\n";
            while (currentComment && currentComment.body) 
            {
                var body = currentComment.body.replace(/\n/g, "");
                if (body.length > truncateAtCommentLength) body = body.slice(0, truncateAtCommentLength) + "...";

                messageEmbed.description += createIndentedComment(`**${numberToEmoijNumber(currentComment.score, true)}** __${currentComment.author}__`, body, level++, false);

                if (currentComment.replies && topComment.replies.data && topComment.replies.data.children.length > 0)
                    currentComment = currentComment.replies.data.children[0].data;
                else
                    currentComment = null;
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
    }
    else
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

discordBot.on("warn", (warning) =>
{
    console.warn("[Discord bot warning] " + warning);
});

function redditItemMatchesFilters(redditItem) 
{
    return (!tryRemoveNsfw || !redditItem.title.toLowerCase().includes("nsf")) &&
        skipAtDescriptionLength > (redditItem.selftext || "").length &&
        minimumPostVotes <= Math.abs(redditItem.score);
}


async function nextRedditItem(index, subredditName, subredditMode, subredditTopTimespan) 
{
    var tries = 0;
    var redditItem = null;
    do
    {
        redditItem = await redditCache.getCachedRedditItem(subredditName, index, subredditMode, subredditTopTimespan, index !== 0);

        if (!redditItem)
            return [null, 0];

        // Cache future video post
        redditCache.getCachedRedditItem(subredditName, index + cacheFutureVideoIn, subredditMode, subredditTopTimespan, index !== 0).then(async (futureRedditItem) =>
        {
            if (!futureRedditItem || futureRedditItem instanceof Error || !redditItemMatchesFilters(futureRedditItem)) return;
            futureRedditItem.url = await unpackUrl(futureRedditItem.url);
            if (futureRedditItem.is_video || isVideoUrl(futureRedditItem.url))
            {
                const cachedVideoPath = await video.getCachedVideo(futureRedditItem.url); // Will cache video
                if (cachedVideoPath) console.log("[sendInChannel] Cached future video", futureRedditItem.url, "->", cachedVideoPath);
            }
        });

        if (++tries > 50)
            throw new Error("There are no posts that match your filters.");

        index++;

    } while (!redditItemMatchesFilters(redditItem));

    return [redditItem, index];
}

// 'hour' | 'day' | 'week' | 'month' | 'year' | 'all'
const redditInputRegex = /(?:https?:\/\/(?:www\.)?reddit\.com\/)?r\/([a-z0-9 _]{1,20})?(?:\/(?:(hot|rising|new|best|top)|comments\/([a-z0-9]+)))?(?:[\?\&]t=(hour|day|week|month|year|all))?/i;

/**
 * @param {Message} message 
 */
async function processMessage(message) 
{
    if (message.author.bot) return;

    var input = (message.content || "").trim().toLowerCase();
    if (!input.startsWith("r/") && !input.startsWith("https://www.reddit.com/r/")) return;

    if (input === "r//")
    {
        input = await rgetAsync(`ch${message.channel.id}:u${message.author.id}:prev`);
        if (!input)
        {
            message.reply("I don't remember your previous input, please type it yourself.");
            return;
        }
    }

    if (input.startsWith("https://www.reddit.com/r/"))
        await message.suppressEmbeds(true); // disable the embed created by discord

    // 0: -
    // 1: subredditName
    // 2: subredditMode
    // 3: post id (if subredditMode == null)
    // 4: timespan (if subredditMode == top)
    var userInput = redditInputRegex.exec(input);
    var channelTopicInput = redditInputRegex.exec((message.channel.topic || "").trim().toLowerCase());

    const isPost = !userInput[2] && userInput[3];
    if (isPost) 
    {
        var redditItem;
        try
        {
            redditItem = await redditCache.getRedditPost(userInput[1], userInput[3]);
        }
        catch (ex)
        {
            console.error("[processMessage] Could not embed post:", ex);
            message.channel.send(
                new MessageEmbed()
                    .setTitle("❌ Reddit error!")
                    .setDescription(`There was a problem getting the post, I am very sorry. (*${ex.message}*)`)
                    .setColor("#ff0000")
                    .setThumbnail(sadRedditIcon)
            );
            return;
        }

        sendRedditItem(message.channel, redditItem);
        return;
    }

    var subredditName,
        subredditMode = "top",
        subredditTopTimespan = "month";

    if (userInput && userInput[1])
    {
        subredditName = userInput[1];
    }
    else if (channelTopicInput && channelTopicInput[1])
    {
        subredditName = channelTopicInput[1];
    }
    else
    {
        message.reply("No subreddit specified by user and channel.");
        return;
    }

    if (userInput && userInput[2]) subredditMode = userInput[2];
    else if (channelTopicInput && channelTopicInput[2]) subredditMode = channelTopicInput[2];

    if (userInput && userInput[4]) subredditTopTimespan = userInput[4];
    else if (channelTopicInput && channelTopicInput[4]) subredditTopTimespan = channelTopicInput[4];

    if (subredditTopTimespan && subredditMode !== "top") 
    {
        message.reply(`⚠️ \`t=${subredditTopTimespan}\` is only valid for *top* filter.`);
        return;
    }

    if (subredditName === "typeyoursubreddithere")
    {
        message.reply("Are you really that stupid? 😐");
        return;
    }

    const indexKey = `r${subredditName}:${subredditMode === "top" ? subredditMode + ":" + subredditTopTimespan : subredditMode}:ch${message.channel.id}:idx`;
    var index = parseInt(await rgetAsync(indexKey)) || 0;

    var redditItem;
    try
    {
        [redditItem, index] = await nextRedditItem(index, subredditName, subredditMode, subredditTopTimespan);
    }
    catch (ex) 
    {
        console.error("[sendInChannel] Error: getMatchingRedditItem() threw error:", ex);
        message.channel.send(
            new MessageEmbed()
                .setTitle("❌ Reddit error!")
                .setDescription(`There was a problem getting a post from r/${subredditName}/${subredditMode}, I am very sorry. (*${ex.message}*)`)
                .setColor("#ff0000")
                .setThumbnail(sadRedditIcon)
        );
        return;
    }

    const indexTtl = redditCache.getTtlForRedditIndex(subredditMode, subredditTopTimespan);
    var chain = redisClient.multi();
    if (indexTtl >= 0) chain = chain.setex(indexKey, indexTtl, index);
    else chain = chain.set(indexKey, index);
    chain.setex(`ch${message.channel.id}:u${message.author.id}:prev`, cachePreviousUserSubredditTtl, input).exec();

    if (index === 0 && redditItem == null) 
    {
        message.channel.send(
            new MessageEmbed()
                .setTitle("⚠️ Begin of feed!")
                .setDescription(
                    `This is the start of the **r/${subredditName}/${subredditMode}** subreddit, if you request more posts from this subreddit (and filter, ${subredditMode}), you will notice that some will get reposted. Come back later for more recent posts.`
                )
                .setColor("#ffff00")
        );

        return;
    }

    sendRedditItem(message.channel, redditItem);
}

discordBot.on("message", processMessage);
//discordBot.on("messageUpdate", (oldMessage, editedMessage) => processMessage(editedMessage));