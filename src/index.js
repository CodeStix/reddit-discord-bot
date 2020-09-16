require("dotenv").config();
const {
    Client: DiscordClient,
    MessageAttachment,
    MessageEmbed,
    Message,
    TextChannel,
} = require("discord.js");
const ax = require("./axiosInstance");
const util = require("util");
const fs = require("fs");
const cheerio = require("cheerio");
const redis = require("redis");
const redditCache = require("./redisCache");
const video = require("./video");

const redditIcon = "https://www.redditstatic.com/desktop2x/img/favicon/apple-icon-72x72.png";
const sadRedditIcon =
    "https://cdn.discordapp.com/attachments/711525975636049921/720991277918847047/redditsad.png";
const videoBufferGif =
    "https://cdn.discordapp.com/attachments/755133141559017655/755357978840006696/MessySeveralEft-size_restricted.gif";

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

const discordBot = new DiscordClient();
discordBot.login(process.env.DISCORD_TOKEN);
discordBot.on("ready", () => {
    console.log("[reddit-bot] discord: connected");
});
discordBot.on("error", (err) => {
    console.error("[reddit-bot] (error) discord:", err);
});
discordBot.on("warn", (warning) => {
    console.warn("[reddit-bot] (warning) discord:", warning);
});

/**
 * Convert a redirecting, 50/50, bit.ly, imgur... url to the direct url.
 * @param {string} url The url to unpack/resolve.
 */
async function unpackUrl(url) {
    if (
        url.startsWith("https://5050") ||
        url.startsWith("http://5050") ||
        url.startsWith("http://bit.ly") ||
        url.startsWith("https://bit.ly")
    ) {
        try {
            url = (await ax.head(url, { maxRedirects: 5 })).request.res.responseUrl;
        } catch (ex) {
            console.warn(
                "[reddit-bot] (warning) unpackUrl: could not get redirected url",
                ex.message
            );
        }
    }

    if (url.startsWith("https://imgur.com/gallery/")) {
        url = "https://imgur.com/a/" + url.substring("https://imgur.com/gallery/".length);
    }

    if (
        url.startsWith("https://postimg.cc/") ||
        url.startsWith("https://www.flickr.com/") ||
        url.startsWith("https://imgur.com/") ||
        url.startsWith("https://gfycat.com/")
    ) {
        try {
            // <meta property="og:video" content="https://i.imgur.com/Xob3epw.mp4"/>
            // <meta property="og:image" content="https://i.imgur.com/I42mS3H.jpg?fb" />
            const response = await ax.default.get(url);
            const ch = cheerio.load(response.data);

            var elem = ch("head meta[property='og:video']");
            if (elem) {
                // Is video
                url = elem.attr("content");
            } else {
                elem = ch("head meta[property='og:image']");

                if (elem) url = elem.attr("content");
            }

            console.log("[reddit-bot] unpackUrl: extracted imgur/postimg url", url);
        } catch (ex) {
            console.warn(
                "[reddit-bot] (warning) unpackUrl: could not extract imgur/postimg image",
                ex
            );
        }
    }
    return url;
}

function getFileNameForUrl(url) {
    return url.replace(/[^a-zA-Z0-9]/g, "").substring(0, 16);
}

async function getTopComment(redditItem, maxDepth = 2) {
    try {
        const response = await ax.get(
            `https://api.reddit.com/r/${redditItem.subreddit}/comments/${redditItem.id}?depth=${maxDepth}&limit=${maxDepth}&sort=${commentSortMode}`,
            {
                responseType: "json",
            }
        );

        //fs.writeFile("./badrequests/latestcomment.json", JSON.stringify(response.data), () => { });
        if (!response.data || response.data.length < 2 || response.data[1].data.children.length < 1)
            return;

        const comments = response.data[1].data.children;
        var topComment = comments.find((val) => !val.data.score_hidden);
        if (!topComment) return;
        return topComment.data;
    } catch (ex) {
        console.warn(
            "[reddit-bot] (warning) getTopComment: could not get top comment:",
            ex.message
        );
        return null;
    }
}

function createIndentedComment(header, content, level, spoiler) {
    if (level === 0) {
        if (spoiler) return "> " + header + "\n> ||" + content + "||\n";
        else return "> " + header + "\n> " + content + "\n";
    }

    const maxWidth = 76; // discord embeds have a width of 75 characters
    const width = maxWidth - level * 5;
    var out = "";
    var indent = "";

    for (var i = 0; i < level; i++)
        indent += "\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0";

    for (var i = 0; i < content.length / width; i++) {
        if ((i + 1) * width < content.length)
            out += "> " + indent + content.substring(i * width, (i + 1) * width) + "\n";
        else out += "> " + indent + content.substring(i * width) + "\n";
    }

    return "> " + indent + header + "\n" + out;
}

function isImageUrl(url) {
    return (
        url.endsWith(".gif") ||
        url.endsWith(".png") ||
        url.endsWith(".jpg") ||
        url.startsWith("https://i.redd.it/") ||
        url.startsWith("https://i.postimg.cc/")
    );
}

function isVideoUrl(url) {
    return (
        url.endsWith(".gif") ||
        url.endsWith(".gifv") ||
        url.endsWith(".mp4") ||
        url.startsWith("https://v.redd.it/") ||
        url.startsWith("https://streamable.com/") ||
        url.startsWith("http://clips.twitch.tv/") ||
        url.startsWith("https://clips.twitch.tv/") ||
        url.startsWith("https://twitter.com/") ||
        url.startsWith("https://gfycat.com/")
    );
}

/**
 * @param {TextChannel} channel The receiving channel.
 * @param {string} redditUrl
 */
async function sendRedditItem(channel, redditItem) {
    if (redditItem.selftext && redditItem.selftext.length > truncateAtDescriptionLength)
        redditItem.selftext =
            redditItem.selftext.slice(0, truncateAtDescriptionLength) +
            "... *[content was truncated]*";
    if (redditItem.title.length > truncateAtTitleLength)
        redditItem.title = redditItem.title.slice(0, truncateAtTitleLength) + "...";
    redditItem.author = redditItem.author || "[deleted]";
    redditItem.title = redditItem.title || "[deleted]";
    redditItem.url = encodeURI(redditItem.url); // encode weird characters

    const postUrl = encodeURI("https://www.reddit.com" + redditItem.permalink);
    const asSpoiler =
        redditItem.spoiler || redditItem.over_18 || redditItem.title.toLowerCase().includes("nsf");

    const messageEmbed = new MessageEmbed()
        .setTitle(redditItem.title)
        .setURL(postUrl)
        .setAuthor(
            redditItem.author,
            await redditCache.getUserIcon(redditItem.author, true),
            "https://reddit.com/u/" + redditItem.author
        )
        .setColor(asSpoiler ? "#ff1111" : "#11ff11")
        .setDescription(numberToEmoijNumber(redditItem.score) + "\n" + redditItem.selftext)
        .setTimestamp(redditItem.created * 1000)
        .setFooter(
            "On r/" + redditItem.subreddit,
            await redditCache.getSubredditIcon(redditItem.subreddit, true)
        );

    const messageTask = channel.send(messageEmbed);
    if (enableVotingReactions) {
        messageTask.then((m) => m.react("⬆️").then(m.react("⬇️")));
    }

    const redditIconTask = redditCache.getSubredditIcon(redditItem.subreddit, false);
    const redditCommentsTask = enableTopComments ? getTopComment(redditItem) : undefined;
    const userIconTask = redditCache.getUserIcon(redditItem.author, false);
    const urlTask = postUrl !== redditItem.url ? unpackUrl(redditItem.url) : undefined;

    const [redditIcon, topComment, userIcon, url] = await Promise.all([
        redditIconTask,
        redditCommentsTask,
        userIconTask,
        urlTask,
    ]);

    if (enableTopComments) {
        //  && topComment.score >= 0.06 * redditItem.score
        var currentComment = topComment;
        var level = 0;
        messageEmbed.description += "\n";
        while (currentComment && currentComment.body) {
            var body = currentComment.body.replace(/\n/g, "");
            if (body.length > truncateAtCommentLength)
                body = body.slice(0, truncateAtCommentLength) + "...";

            messageEmbed.description += createIndentedComment(
                `**${numberToEmoijNumber(currentComment.score, true)}** __${
                    currentComment.author
                }__`,
                body,
                level++,
                false
            );

            if (
                currentComment.replies &&
                topComment.replies.data &&
                topComment.replies.data.children.length > 0
            )
                currentComment = currentComment.replies.data.children[0].data;
            else currentComment = null;
        }
    }

    if (redditIcon) {
        messageEmbed.setFooter("On r/" + redditItem.subreddit, redditIcon);
    }

    if (userIcon) {
        messageEmbed.setAuthor(
            redditItem.author,
            userIcon,
            "https://reddit.com/u/" + redditItem.author
        );
    }

    var sendAsVideo = false;
    if (url) {
        const fileName = getFileNameForUrl(url);
        if (isImageUrl(url)) {
            if (asSpoiler) {
                channel.send("", new MessageAttachment(url, `SPOILER_${fileName}.png`));
            } else {
                messageEmbed.setImage(url);
            }
        } else if (redditItem.is_video || isVideoUrl(url)) {
            sendAsVideo = true;
        } else {
            if (asSpoiler) {
                messageEmbed.description += `\n||${url}||`;
            } else {
                messageEmbed.description += `\n**${url}**`;
            }
        }
    }

    (await messageTask).edit(messageEmbed);

    if (sendAsVideo) {
        try {
            var videoFile = await video.getCachedVideoPath(url);
            if (!videoFile) {
                var buffering = channel.send(new MessageAttachment(videoBufferGif, "Loading.gif"));
                try {
                    videoFile = await video.getCachedVideo(url);
                } finally {
                    (await buffering).delete();
                }
            }
            const fileName = getFileNameForUrl(url);
            const name = asSpoiler ? `SPOILER_${fileName}.mp4` : `video-${fileName}.mp4`;
            await channel.send("", new MessageAttachment(videoFile, name));
        } catch (ex) {
            console.warn(
                "[reddit-bot] (warning) sendRedditAttachment: could not send as video, sending url instead:",
                ex
            );
            await channel.send(`⚠️ ${ex.message} Take a link instead: ${url}`);
        }
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

function redditItemMatchesFilters(redditItem) {
    return (
        (!tryRemoveNsfw || !redditItem.title.toLowerCase().includes("nsf")) &&
        skipAtDescriptionLength > (redditItem.selftext || "").length &&
        minimumPostVotes <= Math.abs(redditItem.score)
    );
}

async function nextRedditItem(index, subredditName, subredditMode, subredditTopTimespan) {
    var tries = 0;
    var redditItem = null;
    do {
        redditItem = await redditCache.getCachedRedditItem(
            subredditName,
            index,
            subredditMode,
            subredditTopTimespan,
            index !== 0
        );

        if (!redditItem) return [null, 0];

        // Cache future video post
        redditCache
            .getCachedRedditItem(
                subredditName,
                index + cacheFutureVideoIn,
                subredditMode,
                subredditTopTimespan,
                index !== 0
            )
            .then(async (futureRedditItem) => {
                if (
                    !futureRedditItem ||
                    futureRedditItem instanceof Error ||
                    !redditItemMatchesFilters(futureRedditItem)
                )
                    return;
                futureRedditItem.url = await unpackUrl(futureRedditItem.url);
                if (
                    futureRedditItem.url &&
                    (futureRedditItem.is_video || isVideoUrl(futureRedditItem.url))
                ) {
                    const cachedVideoPath = await video.getCachedVideo(futureRedditItem.url); // Will cache video
                    if (cachedVideoPath)
                        console.log(
                            "[reddit-bot] nextRedditItem: cached future video",
                            futureRedditItem.url,
                            "->",
                            cachedVideoPath
                        );
                }
            })
            .catch((err) => {
                console.error(
                    "[reddit-bot] (error) nextRedditItem: could not cache next video:",
                    err
                );
            });

        if (++tries > 50)
            throw new Error(
                `There are no posts from **${subredditName}** available that match your filters. I'm sorry.`
            );

        index++;
    } while (!redditItemMatchesFilters(redditItem));

    return [redditItem, index];
}

var redditPostRegex = /^https?:\/\/(?:www\.)?reddit\.com\/(?:r\/(?<subredditName>[\w\d]+)\/)?comments\/(?<postId>[\w\d]+)/i;
async function processPostMessage(message) {
    var results = redditPostRegex.exec(message.content);
    console.log(results);
    if (!results || !results.groups.postId) {
        message.channel.send(
            new MessageEmbed().setTitle("❌ Invalid reddit url.").setColor("#FF4301")
        );
        return;
    }

    var redditItem;
    try {
        redditItem = await redditCache.getRedditPost(
            results.groups.subredditName,
            results.groups.postId
        );
    } catch (ex) {
        console.error("[reddit-bot] processMessage: could not embed post:", ex);
        message.channel.send(new MessageEmbed().setTitle("❌ " + ex.message).setColor("#FF4301"));
        return;
    }

    await message.suppressEmbeds(true);
    await sendRedditItem(message.channel, redditItem);
}

async function processPrefixMessage(message) {
    var input = message.content.substring(2).toLowerCase().trim();
    console.log(`[reddit-bot] input '${input}'`);
    if (input === "" || input === "help" || input === "?") {
        const description = `
        **You can use the \`r/\` prefix in the following ways:**

         - \`r/pics\`: shows a top post from the r/pics subreddit.

         - \`r/pics new\`: shows a new post. You can also use **top**, **best**, **rising** and **hot**.

         - \`r/pics top\`: shows a top post.

         - \`r/pics top week\` or \`r/pics week\`: shows a top post from the last week.

         ℹ️ **Protip: **You can use the \`r//\` shortcut to repeat your previous input.

         [More information here](https://github.com/CodeStix/reddit-discord-bot)
        `;
        message.reply(
            new MessageEmbed()
                .setTitle("Reddit Bot Help")
                .setDescription(description)
                .setColor("#FF4301")
        );
        return;
    } else if (input.startsWith("/")) {
        if (input.length > 1) {
            message.reply(
                "⚠️ **r//** just reuses your previous input, do not type anything after it. Use **r/help** to show instructions."
            );
        }
        input = await redditCache.getPreviousUserInput(message.channel.id, message.author.id);
        if (!input) {
            message.reply(
                "😬 I'm sorry, I don't remember your previous input, please type it once again."
            );
            return;
        }
    }

    var splitted = input.split(/ |\//g);
    var subredditName = splitted[0],
        subredditMode = "top",
        subredditTopTimespan = "week";

    if (splitted[1]) {
        if (["hour", "day", "week", "month", "year", "all"].includes(splitted[1])) {
            subredditMode = "top";
            subredditTopTimespan = splitted[1];
        } else if (["top", "new", "rising", "best", "year", "all"].includes(splitted[1])) {
            subredditMode = splitted[1];
        }
    }
    if (splitted[2]) {
        subredditTopTimespan = splitted[2];
    }

    console.log("[reddit-bot] (debug)", subredditName, subredditMode, subredditTopTimespan);

    var index = await redditCache.getChannelSubredditIndex(
        subredditName,
        subredditMode,
        subredditTopTimespan,
        message.channel.id
    );

    var redditItem;
    try {
        [redditItem, index] = await nextRedditItem(
            index,
            subredditName,
            subredditMode,
            subredditTopTimespan
        );
    } catch (ex) {
        console.error(
            "[reddit-bot] (error) processMessage: getMatchingRedditItem() threw error:",
            ex
        );
        message.channel.send(new MessageEmbed().setTitle("❌ " + ex.message).setColor("#FF4301"));
        return;
    }

    await redditCache.setChannelSubredditIndex(
        subredditName,
        subredditMode,
        subredditTopTimespan,
        message.channel.id,
        index
    );
    await redditCache.setPreviousUserInput(message.channel.id, message.author.id, input);

    if (index === 0 && redditItem == null) {
        message.channel.send(
            new MessageEmbed()
                .setTitle("⚠️ End of feed!")
                .setDescription(
                    `You reached the end of **r/${subredditName}/${subredditMode}** subreddit, if you request more posts from this subreddit (and filter, ${subredditMode}), you will notice that some will get reposted. Come back later for more recent posts.`
                )
                .setColor("#FF4301")
        );

        return;
    }

    sendRedditItem(message.channel, redditItem);
}

/**
 * @param {Message} message
 */
async function processMessage(message) {
    if (message.author.bot) return;

    /*
        r/              shows help
        r/help          shows help
        
        r//             send another post from previously entered subreddit
        r/test          shows a post from the test subreddit
        r/test new      shows a new post from the test subreddit
        r/test top week shows a top post from the last week from the test subreddit
        r/test month    shows a top post from the last month from the test subreddit

    */

    if (message.content.startsWith("https://www.reddit.com/")) {
        await processPostMessage(message);
    } else if (message.content.startsWith("r/")) {
        await processPrefixMessage(message);
    }
}

discordBot.on("message", processMessage);
//discordBot.on("messageUpdate", (oldMessage, editedMessage) => processMessage(editedMessage));
