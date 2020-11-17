require("dotenv").config();
const {
    Client: DiscordClient,
    MessageAttachment,
    MessageEmbed,
    Message,
    TextChannel,
} = require("discord.js");
const ax = require("./axiosInstance");
const cheerio = require("cheerio");
const redditCache = require("./redisCache");
const video = require("./video");
const DBL = require("dblapi.js");
const debug = require("debug");
const logger = debug("rdb");

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
let enableVotingReactions = false;
let minimumPostVotes = 0;
let commentSortMode = "top"; // Can be: confidence, top, new, controversial, old, random, qa, live

const cacheFutureVideoIn = 3; // Cache x videos into the future


const discordBot = new DiscordClient();
discordBot.login(process.env.DISCORD_TOKEN);
discordBot.on("ready", () => {
    logger("connected to discord");
});
discordBot.on("error", (err) => {
    logger("discord error:", err);
});
discordBot.on("warn", (warning) => {
    logger("discord warning:", warning);
});

// top.gg api
const topggToken = process.env.TOPGG_TOKEN;
const topggLogger = logger.extend("topgg");
if (topggToken) {
    const dbl = new DBL(topggToken, discordBot);
    dbl.on("posted", () => {
        topggLogger("Server count posted!");
    });
    dbl.on("error", e => {
        topggLogger(`Error: ${e}`);
    });
}
else {
    topggLogger("not connecting to top.gg api, no token was provided")
}

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
            logger(
                "(warning) unpackUrl: could not get redirected url",
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

            logger("unpackUrl: extracted imgur/postimg url", url);
        } catch (ex) {
            logger(
                "(warning) unpackUrl: could not extract imgur/postimg image",
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
        logger(
            "(warning) getTopComment: could not get top comment:",
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

    const nsfw = redditItem.over_18 || redditItem.title.toLowerCase().includes("nsf");
    const asSpoiler = redditItem.spoiler || nsfw;

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

    (await messageTask).edit(messageEmbed);

    if (url) {
        const fileName = getFileNameForUrl(url);

        if (redditItem.is_video || isVideoUrl(url)) {
            try {
                var videoFile = await video.getCachedVideoPath(url);
                if (!videoFile) {
                    var buffering = channel.send(
                        new MessageAttachment(videoBufferGif, "Loading.gif")
                    );
                    try {
                        videoFile = await video.getCachedVideo(url);
                    } finally {
                        (await buffering).delete();
                    }
                }
                const name = asSpoiler ? `SPOILER_${fileName}.mp4` : `video-${fileName}.mp4`;
                await channel.send("", new MessageAttachment(videoFile, name));
            } catch (ex) {
                logger(
                    "(warning) sendRedditAttachment: could not send as video, sending url instead:",
                    ex
                );
                await channel.send(`⚠️ ${ex.message} Take a link instead: ${url}`);
            }
        } else if (isImageUrl(url)) {
            try {
                const name = asSpoiler ? `SPOILER_${fileName}.png` : `image-${fileName}.png`;
                channel.send("", new MessageAttachment(url, name));
            } catch (ex) {
                logger(
                    "(warning) sendRedditAttachment: could not send as image, sending url instead:",
                    ex
                );
                await channel.send(`⚠️ ${ex.message} Take a link instead: ${url}`);
            }
        } else {
            if (asSpoiler) {
                await channel.send(`||${url}||`);
            } else {
                await channel.send(url);
            }
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

function redditItemMatchesFilters(redditItem, allowNsfw) {
    return (
        (allowNsfw || (!redditItem.title.toLowerCase().includes("nsf") && !redditItem.over_18)) &&
        skipAtDescriptionLength > (redditItem.selftext || "").length &&
        minimumPostVotes <= Math.abs(redditItem.score)
    );
}

async function nextRedditItem(index, subredditName, subredditMode, subredditTopTimespan, allowNsfw) {
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
                    !redditItemMatchesFilters(futureRedditItem, allowNsfw)
                )
                    return;
                futureRedditItem.url = await unpackUrl(futureRedditItem.url);
                if (
                    futureRedditItem.url &&
                    (futureRedditItem.is_video || isVideoUrl(futureRedditItem.url))
                ) {
                    const cachedVideoPath = await video.getCachedVideo(futureRedditItem.url); // Will cache video
                    if (cachedVideoPath)
                    logger(
                            "nextRedditItem: cached future video",
                            futureRedditItem.url,
                            "->",
                            cachedVideoPath
                        );
                }
            })
            .catch((err) => {
                logger(
                    "(error) nextRedditItem: could not cache next video:",
                    err.message
                );
            });

        if (++tries > 50)
            throw new Error(`There are no posts from **${subredditName}** available that match your filters. Enable NSFW on this discord channel to show NSFW content.`);

        index++;
    } while (!redditItemMatchesFilters(redditItem, allowNsfw));

    return [redditItem, index];
}

var redditPostRegex = /^https?:\/\/(?:www\.)?reddit\.com\/(?:r\/(?<subredditName>[\w\d]+)\/)?comments\/(?<postId>[\w\d]+)/i;
async function processPostMessage(message) {
    var results = redditPostRegex.exec(message.content);
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
        logger("processMessage: could not embed post:", ex);
        await message.channel.send(
            new MessageEmbed().setTitle("❌ " + ex.message).setColor("#FF4301")
        );
        return;
    }

    await message.suppressEmbeds(true);
    await sendRedditItem(message.channel, redditItem);
}

/**
 * 
 * @param {Message} message 
 */
async function processPrefixMessage(message) {
    var input = message.content.substring(2).toLowerCase().trim();

    if (input === "" || input === "help" || input === "?") {
        const description = `
        ${message.channel.nsfw ? "" : "⚠️ **You should mark this channel as NSFW to make sure you can receive all reddit content.**"}
        
        **You can use the \`r/\` prefix in the following ways:**

         - \`r/pics\`: shows a top post from the r/pics subreddit.

         - \`r/pics new\`: shows a new post. You can also use **top**, **best**, **rising** and **hot**.

         - \`r/pics top\`: shows a top post.

         - \`r/pics top week\` or \`r/pics week\`: shows a top post from the last week. You can also use **hour**, **day**, **month**, **year** and **all**.

         ℹ️ **Protip: **You can use the \`r//\` shortcut to repeat your previous input.
         You can also paste a reddit url, I will convert it into a nice styled message.

         [More information here](https://codestix.nl/article/reddit-discord-bot)
        `;
        await message.reply(
            new MessageEmbed()
                .setTitle("Reddit Bot Help")
                .setDescription(description)
                .setColor("#FF4301")
        );
        return;
    } else if (input.startsWith("/")) {
        if (input.length > 1) {
            await message.reply(
                "⚠️ **r//** just reuses your previous input, do not type anything after it. Use **r/help** to show instructions."
            );
        }
        input = await redditCache.getPreviousUserInput(message.channel.id, message.author.id);
        if (!input) {
            await message.reply(
                "😬 I'm sorry, I don't remember your previous input, please type it once again."
            );
            return;
        }
    }

    logger(`input '${input}'`);

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

    var index = await redditCache.getChannelSubredditIndex(
        subredditName,
        subredditMode,
        subredditTopTimespan,
        message.channel.id
    );

    var redditItem;
    var newIndex;
    try {
        [redditItem, newIndex] = await nextRedditItem(
            index,
            subredditName,
            subredditMode,
            subredditTopTimespan,
            message.channel.nsfw
        );
    } catch (ex) {
        logger(
            "(error) processMessage: getMatchingRedditItem() threw error:",
            ex
        );
        await message.channel.send(
            new MessageEmbed().setTitle("❌ " + ex.message).setColor("#FF4301")
        );
        return;
    }

    await redditCache.setChannelSubredditIndex(
        subredditName,
        subredditMode,
        subredditTopTimespan,
        message.channel.id,
        newIndex
    );
    await redditCache.setPreviousUserInput(message.channel.id, message.author.id, input);

    if (newIndex === 0 && redditItem == null) {
        if (index === 0) {
            await message.channel.send(new MessageEmbed().setColor("#FF4301").setTitle(`❌ The **${subredditName}** subreddit does not contain any items that match your filters. Enable NSFW on this discord channel to show NSFW content.`));
        }
        else {
            await message.channel.send(
                new MessageEmbed()
                    .setTitle("⚠️ End of feed!")
                    .setDescription(
                        `You reached the end of **r/${subredditName}/${subredditMode}** subreddit, if you request more posts from this subreddit (and filter, ${subredditMode}), you will notice that some will get reposted. Come back later for more recent posts.`
                    )
                    .setColor("#FF4301")
            );
        }
        

        return;
    }

    await sendRedditItem(message.channel, redditItem);
}

var processingChannels = {};

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
        if (processingChannels[message.channel.id]) return;
        processingChannels[message.channel.id] = true;
        await processPostMessage(message);
        delete processingChannels[message.channel.id];
    } else if (message.content.startsWith("b/")) {
        if (processingChannels[message.channel.id]) return;
        processingChannels[message.channel.id] = true;
        await processPrefixMessage(message);
        delete processingChannels[message.channel.id];
    }
}

discordBot.on("message", processMessage);
//discordBot.on("messageUpdate", (oldMessage, editedMessage) => processMessage(editedMessage));
