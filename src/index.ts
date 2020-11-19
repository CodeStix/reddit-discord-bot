import { config } from "dotenv";
config(); // must load environment vars before anything else
import { Client as DiscordBot, MessageEmbed } from "discord.js";
import { debug } from "debug";
import { RedditBot, RedditUrlMessageHanlderProps, SubredditMessageHanlderProps } from "./RedditBot";
import { getRandomDefaultUserIcon, getRedditSubmission, getRedditUserIcon, getSubredditIcon } from "./reddit";

const logger = debug("rdb");

const bot = new RedditBot(process.env.DISCORD_TOKEN!);

bot.on("redditRequest", async ({ subreddit, subredditMode, channel, sender }: SubredditMessageHanlderProps) => {
    logger("redditrequest", subreddit);

    let submission = await getRedditSubmission(subreddit, subredditMode, 0);

    if (!submission) {
        channel.send("No posts available.");
        return;
    }

    let cachedUserIcon = await getRedditUserIcon(submission.author, true);
    let cachedSubredditIcon = await getSubredditIcon(submission.subreddit, true);

    logger("cachedUserIcon", cachedUserIcon);
    logger("cachedSubredditIcon", cachedSubredditIcon);

    let embed = new MessageEmbed()
        .setTitle(submission.title)
        .setDescription(submission.selftext?.substring(0, 1024) ?? "<empty>")
        .setAuthor(submission.author, cachedUserIcon ?? getRandomDefaultUserIcon())
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
