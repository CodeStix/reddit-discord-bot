import { config } from "dotenv";
config(); // must load environment vars before anything else
import { Client as DiscordBot, MessageEmbed, TextChannel } from "discord.js";
import { debug } from "debug";
import { RedditBot, RedditUrlMessageHanlderProps, SubredditMessageHanlderProps } from "./bot";
import {
    Comment,
    fetchSubmission,
    getRandomDefaultUserIcon,
    getRedditSubmission,
    getRedditUserIcon,
    getSubmission,
    getSubredditInfo,
    Listing,
    Submission,
    SubredditMode,
} from "./reddit";
import cheerio from "cheerio";
import fetch from "node-fetch";
import { getCachedPackedUrl, getChannelIndex, storeCachedPackedUrl, storeChannelIndex } from "./redis";
import { TopGGApi } from "./topgg";
import { chdir } from "process";
import { getVideoOrDownload } from "./video";
import { createUnknownErrorEmbed, RedditBotError } from "./error";

const logger = debug("rdb");

const bot = new RedditBot(process.env.DISCORD_TOKEN!, process.env.PREFIX ?? "r/");
const topgg = process.env.TOPGG_TOKEN ? new TopGGApi(process.env.TOPGG_TOKEN, bot.getBot()) : null;

const DEFAULT_EMBED_COLOR = "#2f3136"; // 55ff11
const TRUNCATE_TITLE_LENGTH = 200; // Max is 256
const TRUNCATE_COMMENTS_LENGTH = 1000; // MAX_COMMENTS_LENGTH + MAX_DESCRIPTION_LENGTH is max 2048
const TRUNCATE_DESCRIPTION_LENGTH = 1000;
const TRUNCATE_COMMENT_LENGTH = 400;
const MAX_FILTER_TRIES = 35;
const SKIP_DESCRIPTION_LENGTH = 400;
const SKIP_MIN_POST_VOTES = 0;

function matchesChannelFilters(channel: TextChannel, submission: Submission): boolean {
    // Skip post if it is pinned/stickied
    if (submission.stickied) {
        return false;
    }
    // Skip if too mush text
    if ((submission.selftext ?? "").length > SKIP_DESCRIPTION_LENGTH) {
        return false;
    }
    // Skip if smaller than vote requirement
    if (Math.abs(submission.score) < SKIP_MIN_POST_VOTES) {
        return false;
    }
    // Skip if nsfw and it isn't allowed
    let allowNsfw = channel.nsfw;
    if (!allowNsfw && (submission.title.toLowerCase().includes("nsf") || submission.over_18)) {
        return false;
    }
    return true;
}

bot.on("redditRequest", async ({ subreddit, subredditMode, channel, sender }: SubredditMessageHanlderProps) => {
    logger("redditrequest", subreddit);

    let currentIndex = await getChannelIndex(channel.id, subreddit, subredditMode);
    let newIndex, submission;
    try {
        [newIndex, submission] = await getNextMatchingSubmission(subreddit, subredditMode, currentIndex, channel);
    } catch (ex) {
        if (ex instanceof RedditBotError) {
            logger("bot error (%s): %s", ex.type, ex.message);
            await channel.send(ex.createEmbed());
        } else {
            logger("unknown error", ex);
            await channel.send(createUnknownErrorEmbed());
        }
        return;
    }

    getNextMatchingSubmission(subreddit, subredditMode, newIndex, channel)
        .then(([, nextSubmission]) => {
            if (!nextSubmission) return;
            logger("preload %s", nextSubmission.permalink);
            preloadSubmission(nextSubmission);
        })
        .catch((err) => {
            logger("could not cache next submission:", err);
        });

    await storeChannelIndex(channel.id, subreddit, subredditMode, newIndex);
    await sendRedditSubmission(channel, submission);
});

bot.on("redditUrl", async (props: RedditUrlMessageHanlderProps) => {
    logger("redditurl", props.submissionId);

    try {
        let submission = await fetchSubmission(props.submissionId);
        await sendRedditSubmission(props.channel, submission);
    } catch (ex) {
        if (ex instanceof RedditBotError) {
            logger("bot error (%s): %s", ex.type, ex.message);
            await props.channel.send(ex.createEmbed());
        } else {
            logger("unknown error", ex);
            await props.channel.send(createUnknownErrorEmbed());
        }
    }
});

async function sendRedditSubmission(channel: TextChannel, submission: Submission) {
    let nsfw = submission.over_18 || submission.title.toLowerCase().includes("nsf");
    let asSpoiler = submission.spoiler || nsfw;
    let urlToSubmission = encodeURI("https://www.reddit.com" + submission.permalink);
    let urlToAuthor = encodeURI("https://www.reddit.com/u/" + submission.author);
    let urlIsAttachment = urlToSubmission !== submission.url;

    let cachedUserIcon = await getRedditUserIcon(submission.author, true);
    let cachedSubredditInfo = await getSubredditInfo(submission.subreddit, true);
    let cachedAttachment = urlIsAttachment ? await getUnpackedUrl(submission.url, true) : null;
    let cachedDetails = await getSubmission(submission.id, true, 3);

    let descriptionBuilder = "";
    descriptionBuilder += numberToEmoijNumber(submission.score) + "\n";
    descriptionBuilder += truncateString(submission.selftext, TRUNCATE_DESCRIPTION_LENGTH);
    let containsCommentSection = false;
    let commentSectionMaxThreadCount = urlIsAttachment ? 2 : 5;
    if (cachedDetails && cachedDetails.comments) {
        descriptionBuilder += truncateString(createCommentSection(cachedDetails.comments, commentSectionMaxThreadCount), TRUNCATE_COMMENTS_LENGTH);
        containsCommentSection = true;
    }

    let embed = new MessageEmbed()
        .setTitle(truncateString(submission.title, TRUNCATE_TITLE_LENGTH))
        .setURL(urlToSubmission)
        .setColor(cachedSubredditInfo?.color ?? DEFAULT_EMBED_COLOR)
        .setTimestamp(submission.created * 1000)
        .setDescription(descriptionBuilder)
        .setAuthor(submission.author, cachedUserIcon ?? getRandomDefaultUserIcon(), urlToAuthor)
        .setFooter(`On r/${submission.subreddit}`, cachedSubredditInfo?.icon ?? undefined);
    let firstSentMessage = channel.send(embed);

    // Contains tasks that will edit the sent embed
    let embedTasks = [];
    if (cachedUserIcon === null) embedTasks.push(getRedditUserIcon(submission.author).then((e) => (cachedUserIcon = e)));
    if (cachedSubredditInfo === null) embedTasks.push(getSubredditInfo(submission.subreddit).then((e) => (cachedSubredditInfo = e)));
    if (cachedDetails === null) embedTasks.push(getSubmission(submission.id).then((e) => (cachedDetails = e)));

    let otherTasks = [];
    if (urlIsAttachment && cachedAttachment === null) otherTasks.push(getUnpackedUrl(submission.url).then((e) => (cachedAttachment = e)));

    if (embedTasks.length > 0) {
        await Promise.all(embedTasks as any);

        if (!containsCommentSection && cachedDetails && cachedDetails.comments) {
            descriptionBuilder += truncateString(
                createCommentSection(cachedDetails.comments, commentSectionMaxThreadCount),
                TRUNCATE_COMMENTS_LENGTH
            );
        } else {
            logger("cached details is null");
        }

        embed.setDescription(descriptionBuilder);
        embed.setAuthor(submission.author, cachedUserIcon ?? getRandomDefaultUserIcon());
        embed.setColor(cachedSubredditInfo?.color ?? DEFAULT_EMBED_COLOR);
        embed.setFooter(`On r/${submission.subreddit}`, cachedSubredditInfo?.icon ?? undefined);

        (await firstSentMessage).edit(embed);
    }

    if (otherTasks.length > 0) await Promise.all(otherTasks);

    if (cachedAttachment) {
        if (submission.is_video || isVideoUrl(cachedAttachment)) {
            bot.sendVideoAttachment(channel, cachedAttachment, asSpoiler);
        } else if (isImageUrl(cachedAttachment)) {
            bot.sendImageAttachment(channel, cachedAttachment, asSpoiler);
        } else {
            bot.sendUrlAttachment(channel, cachedAttachment, asSpoiler);
        }
    }
}

async function preloadSubmission(submission: Submission) {
    let urlToSubmission = encodeURI("https://www.reddit.com" + submission.permalink);
    let urlIsAttachment = urlToSubmission !== submission.url;

    async function preloadAttachment(url: string | null) {
        if (!url) return;
        if (isVideoUrl(url)) {
            await getVideoOrDownload(url);
        }
    }

    let tasks = [];
    tasks.push(getRedditUserIcon(submission.author));
    tasks.push(getSubredditInfo(submission.subreddit));
    tasks.push(getSubmission(submission.id, false, 3));
    if (urlIsAttachment) tasks.push(getUnpackedUrl(submission.url).then(preloadAttachment));

    try {
        await Promise.all(tasks as any);
    } catch (ex) {
        logger("error while preloading", ex);
    }
}

async function getNextMatchingSubmission(
    subreddit: string,
    subredditMode: SubredditMode,
    index: number,
    channel: TextChannel
): Promise<[number, Submission]> {
    let triesRemaining = MAX_FILTER_TRIES;
    let submission;
    do {
        if (triesRemaining-- <= 0) throw new RedditBotError("no-matching-posts");

        submission = await getRedditSubmission(subreddit, subredditMode, index++);

        if (!submission) {
            if (index <= 2) throw new RedditBotError("subreddit-not-found");
            else
                throw new RedditBotError(
                    "end-of-feed",
                    `You've reached the end of the **r/${subreddit}/${subredditMode}** subreddit. Come back later for new posts, or browse a different subreddit.`
                );
        }
    } while (!matchesChannelFilters(channel, submission));
    return [index, submission];
}

function createCommentSection(comments: Listing<Comment>, maxThreads: number = 3): string {
    let builder = "\n";
    for (let i = 0, j = 0; j < maxThreads && i < comments?.children.length; i++) {
        let comment = comments.children[i]?.data;
        if (comment.score_hidden) continue;
        // builder += "\n";

        let level = 0;
        while (comment && comment.body) {
            builder += createIndentedComment(comment, level++);
            comment = comment.replies?.data?.children[0]?.data;
        }

        j++;
    }

    return builder;
}

async function getUnpackedUrl(url: string, cacheOnly: boolean = false): Promise<string | null> {
    let unpacked = await getCachedPackedUrl(url);
    if (unpacked !== null) return unpacked;
    if (cacheOnly) return null;

    unpacked = await unpackUrl(url);
    await storeCachedPackedUrl(url, unpacked);
    return unpacked;
}

/**
 * Convert a redirecting, 50/50, bit.ly, imgur... url to the direct url.
 * @param {string} url The url to unpack/resolve.
 */
async function unpackUrl(url: string): Promise<string> {
    if (url.startsWith("https://5050") || url.startsWith("http://5050") || url.startsWith("http://bit.ly") || url.startsWith("https://bit.ly")) {
        try {
            let res = await fetch(url, { redirect: "follow", method: "HEAD" });
            url = res.url;
        } catch (ex) {
            logger("unpackUrl: could not get redirected url", ex.message);
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
            let res = await (await fetch(url, { redirect: "follow" })).buffer();
            let ch = cheerio.load(res);

            var elem = ch("head meta[property='og:video']");
            if (elem) {
                url = elem.attr("content") ?? url;
            } else {
                elem = ch("head meta[property='og:image']");
                if (elem) url = elem.attr("content") ?? url;
            }

            logger("unpackUrl: extracted imgur/postimg url", url);
        } catch (ex) {
            logger("unpackUrl: could not extract imgur/postimg image", ex);
        }
    }
    return url;
}

function isImageUrl(url: string): boolean {
    return (
        url.endsWith(".gif") ||
        url.endsWith(".png") ||
        url.endsWith(".jpg") ||
        url.startsWith("https://i.redd.it/") ||
        url.startsWith("https://i.postimg.cc/")
    );
}

function isVideoUrl(url: string): boolean {
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

function numberToEmoijNumber(num: number, small: boolean = false) {
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
            out += String.fromCodePoint(str.codePointAt(i)!) + "\u20E3";
        }
    }
    return out;
}

function createIndentedComment(comment: Comment, level: number) {
    let title = `**${numberToEmoijNumber(comment.score, true)}** __${comment.author}__`;
    let body = truncateString(comment.body, TRUNCATE_COMMENT_LENGTH).replace(/\n/g, " ");

    if (level === 0) return "> " + title + "\n> " + body + "\n";

    const MAX_WIDTH = 76; // discord embeds have a width of 75 characters
    let width = MAX_WIDTH - level * 5;
    let out = "";
    let indent = "";
    for (var i = 0; i < level; i++) indent += "\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0";
    for (var i = 0; i < body.length / width; i++) {
        if ((i + 1) * width < body.length) out += "> " + indent + body.substring(i * width, (i + 1) * width) + "\n";
        else out += "> " + indent + body.substring(i * width) + "\n";
    }

    return "> " + indent + title + "\n" + out;
}

function truncateString(str: string, maxLength: number) {
    const TRUNCATOR = "...";
    if (str.length > maxLength - TRUNCATOR.length) return str.substring(0, maxLength - TRUNCATOR.length) + TRUNCATOR;
    else return str;
}
