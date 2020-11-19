import { config } from "dotenv";
config(); // must load environment vars before anything else
import { Client as DiscordBot, MessageEmbed } from "discord.js";
import { debug } from "debug";
import { RedditBot, RedditUrlMessageHanlderProps, SubredditMessageHanlderProps } from "./RedditBot";
import snoowrap from "snoowrap";
import { getRedditSubmissions, setRedditSubmissions } from "./redis";
import { getRedditSubmission } from "./reddit";

const logger = debug("rdb");
const reddit = new snoowrap({
    userAgent: "Reddit Discord Bot",
    clientId: process.env.REDDIT_CLIENT,
    clientSecret: process.env.REDDIT_SECRET,
    refreshToken: process.env.REDDIT_REFRESH,
});

const bot = new RedditBot(process.env.DISCORD_TOKEN!);

bot.on("redditRequest", async ({ subreddit, subredditMode, channel, sender }: SubredditMessageHanlderProps) => {
    logger("redditRequest", subreddit);

    // @ts-ignore snoowrap bug
    let submission = await getRedditSubmission(subreddit, subredditMode, 0);

    if (!submission) {
        channel.send("No posts available.");
        return;
    }

    // logger("submission", JSON.stringify(submission));

    channel.send(
        new MessageEmbed()
            .setTitle(submission.title)
            .setDescription(submission.selftext?.substring(0, 1024) ?? "<empty>")
            .setAuthor(submission.author)
    );
});

bot.on("redditUrl", (props: RedditUrlMessageHanlderProps) => {
    logger("redditUrl", props.submissionId);
});
