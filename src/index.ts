import { config } from "dotenv";
config(); // must load environment vars before anything else
import { Client as DiscordBot, MessageEmbed } from "discord.js";
import { debug } from "debug";
import { RedditBot, RedditUrlMessageHanlderProps, SubredditMessageHanlderProps } from "./RedditBot";
import { getRandomDefaultUserIcon, getRedditSubmission, getRedditUserIcon, getSubredditIcon } from "./reddit";

const logger = debug("rdb");

const bot = new RedditBot(process.env.DISCORD_TOKEN!);

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

bot.on("redditRequest", async ({ subreddit, subredditMode, channel, sender }: SubredditMessageHanlderProps) => {
    logger("redditrequest", subreddit);

    let submission = await getRedditSubmission(subreddit, subredditMode, 0);

    if (!submission) {
        channel.send("No posts available.");
        return;
    }

    let cachedUserIcon = await getRedditUserIcon(submission.author, true);
    let cachedSubredditIcon = await getSubredditIcon(submission.subreddit, true);

    let nsfw = submission.over_18 || submission.title.toLowerCase().includes("nsf");
    let asSpoiler = submission.spoiler || nsfw;
    let urlToSubmission = encodeURI("https://www.reddit.com" + submission.permalink);
    let urlToAuthor = encodeURI("https://www.reddit.com/u/" + submission.author);

    let embed = new MessageEmbed()
        .setTitle(submission.title)
        .setURL(urlToSubmission)
        .setColor(nsfw ? "#ff1111" : "#11ff11")
        .setTimestamp(submission.created * 1000)
        .setDescription(submission.selftext?.substring(0, 1024) ?? "<empty>")
        .setAuthor(submission.author, cachedUserIcon ?? getRandomDefaultUserIcon(), urlToAuthor)
        .setFooter(`On r/${submission.subreddit}`, cachedSubredditIcon ?? undefined);
    let firstSentMessage = channel.send(embed);

    let tasks = [];
    if (cachedUserIcon === null) tasks.push(getRedditUserIcon(submission.author).then((e) => (cachedUserIcon = e)));
    if (cachedSubredditIcon === null)
        tasks.push(getSubredditIcon(submission.subreddit).then((e) => (cachedSubredditIcon = e)));

    if (tasks.length > 0) {
        await Promise.all(tasks);

        embed.setAuthor(submission.author, cachedUserIcon ?? getRandomDefaultUserIcon());
        embed.setFooter(`On r/${submission.subreddit}`, cachedSubredditIcon ?? undefined);

        (await firstSentMessage).edit(embed);
    }
});

bot.on("redditUrl", (props: RedditUrlMessageHanlderProps) => {
    logger("redditurl", props.submissionId);
});
