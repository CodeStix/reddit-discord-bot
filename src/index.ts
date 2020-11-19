import { config } from "dotenv";
config(); // must load environment vars before anything else
import { Client as DiscordBot, MessageEmbed } from "discord.js";
import { debug } from "debug";
import { RedditBot, RedditUrlMessageHanlderProps, SubredditMessageHanlderProps } from "./RedditBot";
import { getRandomDefaultUserIcon, getRedditSubmission, getRedditUserIcon, getSubredditIcon } from "./reddit";
import cheerio from "cheerio";
import fetch from "node-fetch";
import { getCachedPackedUrl, storeCachedPackedUrl } from "./redis";

const logger = debug("rdb");

const bot = new RedditBot(process.env.DISCORD_TOKEN!);

const TRUNCATE_TITLE_LENGTH = 200; // Max is 256
const TRUNCATE_COMMENTS_LENGTH = 1000; // MAX_COMMENTS_LENGTH + MAX_DESCRIPTION_LENGTH is max 2048
const TRUNCATE_DESCRIPTION_LENGTH = 1000;
// const SKIP_DESCRIPTION_LENGTH = 400;

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

function truncateString(str: string, maxLength: number) {
    const TRUNCATOR = "...";
    if (str.length > maxLength - TRUNCATOR.length) return str.substring(0, maxLength - TRUNCATOR.length) + TRUNCATOR;
    else return str;
}

bot.on("redditRequest", async ({ subreddit, subredditMode, channel, sender }: SubredditMessageHanlderProps) => {
    logger("redditrequest", subreddit);

    let submission = await getRedditSubmission(subreddit, subredditMode, 0);

    if (!submission) {
        channel.send("No posts available.");
        return;
    }

    let nsfw = submission.over_18 || submission.title.toLowerCase().includes("nsf");
    let asSpoiler = submission.spoiler || nsfw;
    let urlToSubmission = encodeURI("https://www.reddit.com" + submission.permalink);
    let urlToAuthor = encodeURI("https://www.reddit.com/u/" + submission.author);
    let urlIsAttachment = urlToSubmission !== submission.url;

    let cachedUserIcon = await getRedditUserIcon(submission.author, true);
    let cachedSubredditIcon = await getSubredditIcon(submission.subreddit, true);
    let cachedAttachment = urlIsAttachment ? await getUnpackedUrl(submission.url, true) : null;

    let descriptionBuilder = "";
    descriptionBuilder += numberToEmoijNumber(submission.score) + "\n";
    descriptionBuilder += truncateString(submission.selftext, TRUNCATE_DESCRIPTION_LENGTH);

    let embed = new MessageEmbed()
        .setTitle(truncateString(submission.title, TRUNCATE_TITLE_LENGTH))
        .setURL(urlToSubmission)
        .setColor(nsfw ? "#ff1111" : "#11ff11")
        .setTimestamp(submission.created * 1000)
        .setDescription(descriptionBuilder)
        .setAuthor(submission.author, cachedUserIcon ?? getRandomDefaultUserIcon(), urlToAuthor)
        .setFooter(`On r/${submission.subreddit}`, cachedSubredditIcon ?? undefined);
    let firstSentMessage = channel.send(embed);

    // Contains tasks that will edit the sent embed
    let embedTasks = [];
    if (cachedUserIcon === null)
        embedTasks.push(getRedditUserIcon(submission.author).then((e) => (cachedUserIcon = e)));
    if (cachedSubredditIcon === null)
        embedTasks.push(getSubredditIcon(submission.subreddit).then((e) => (cachedSubredditIcon = e)));

    let otherTasks = [];
    if (urlIsAttachment && cachedAttachment === null)
        otherTasks.push(getUnpackedUrl(submission.url).then((e) => (cachedAttachment = e)));

    if (embedTasks.length > 0) {
        await Promise.all(embedTasks);

        embed.setAuthor(submission.author, cachedUserIcon ?? getRandomDefaultUserIcon());
        embed.setFooter(`On r/${submission.subreddit}`, cachedSubredditIcon ?? undefined);

        (await firstSentMessage).edit(embed);
    }

    if (otherTasks.length > 0) await Promise.all(otherTasks);

    if (cachedAttachment) channel.send(cachedAttachment);
});

bot.on("redditUrl", (props: RedditUrlMessageHanlderProps) => {
    logger("redditurl", props.submissionId);
});

async function getUnpackedUrl(url: string, cacheOnly: boolean = false): Promise<string | null> {
    let unpacked = await getCachedPackedUrl(url);
    if (unpacked !== null) return unpacked;
    if (cacheOnly) return null;

    unpacked = await unpackUrl(url);
    logger("caching url", url);
    await storeCachedPackedUrl(url, unpacked);
    return unpacked;
}

/**
 * Convert a redirecting, 50/50, bit.ly, imgur... url to the direct url.
 * @param {string} url The url to unpack/resolve.
 */
async function unpackUrl(url: string): Promise<string> {
    if (
        url.startsWith("https://5050") ||
        url.startsWith("http://5050") ||
        url.startsWith("http://bit.ly") ||
        url.startsWith("https://bit.ly")
    ) {
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
