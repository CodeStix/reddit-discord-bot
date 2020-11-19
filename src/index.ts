import { config } from "dotenv";
config(); // must load environment vars before anything else
import { Client as DiscordBot } from "discord.js";
import { debug } from "debug";
import { RedditBot, RedditUrlMessageHanlderProps, SubredditMessageHanlderProps } from "./RedditBot";

const logger = debug("rdb");

const bot = new RedditBot(process.env.DISCORD_TOKEN!);

bot.on("redditRequest", (props: SubredditMessageHanlderProps) => {
    logger("redditRequest", props);
});

bot.on("redditUrl", (props: RedditUrlMessageHanlderProps) => {
    logger("redditUrl", props);
});
