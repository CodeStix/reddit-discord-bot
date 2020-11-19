import { config } from "dotenv";
config(); // must load environment vars before anything else
import { Client as DiscordBot, MessageEmbed } from "discord.js";
import { debug } from "debug";
import { RedditBot, RedditUrlMessageHanlderProps, SubredditMessageHanlderProps } from "./RedditBot";
import snoowrap from "snoowrap";

const logger = debug("rdb");
const reddit = new snoowrap({
    userAgent: "Reddit Discord Bot",
    clientId: process.env.REDDIT_CLIENT,
    clientSecret: process.env.REDDIT_SECRET,
    refreshToken: process.env.REDDIT_REFRESH,
});

const bot = new RedditBot(process.env.DISCORD_TOKEN!);

bot.on("redditRequest", async (props: SubredditMessageHanlderProps) => {
    logger("redditRequest", props.subreddit);

    // Not using async/await because snoowraps typings do not accept it
    reddit.getHot(props.subreddit, { count: 30, limit: 30 }).then((posts) => {
        if (posts.length > 0) {
            let post = posts[0];
            props.channel.send(
                new MessageEmbed()
                    .setTitle(post.title)
                    .setDescription(post.selftext.substring(0, 1024))
                    .setAuthor(post.author.name)
            );
        } else {
            props.channel.send("No posts available.");
        }
    });
});

bot.on("redditUrl", (props: RedditUrlMessageHanlderProps) => {
    logger("redditUrl", props.submissionId);
});
