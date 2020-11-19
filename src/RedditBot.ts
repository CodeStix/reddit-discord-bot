import { Client as DiscordBot, Message, MessageAttachment, MessageEmbed, TextChannel, User } from "discord.js";
import { debug } from "debug";
import { EventEmitter } from "events";
import { SubredditMode } from "./reddit";
import { getVideoOrDownload, getVideoPath } from "./video";
import crypto from "crypto";

const logger = debug("rdb:bot");

export interface SubredditMessageHanlderProps {
    channel: TextChannel;
    sender: User;
    subreddit: string;
    subredditMode: SubredditMode;
}
export interface RedditUrlMessageHanlderProps {
    channel: TextChannel;
    sender: User;
    submissionId: string;
}

const REDDIT_URL_REGEX = /^https?:\/\/(?:www\.)?reddit\.com\/(?:r\/(?<subredditName>[\w\d]+)\/)?comments\/(?<submissionId>[\w\d]+)/i;

export class RedditBot extends EventEmitter {
    public prefix: string = "b/";

    private bot: DiscordBot;

    constructor(token: string) {
        super();
        this.bot = new DiscordBot();
        this.bot.once("ready", this.handleReady.bind(this));
        this.bot.on("message", this.handleMessage.bind(this));
        logger("connecting to Discord...");
        this.bot.login(token);
    }

    private handleReady() {
        logger("connected to discord");
    }

    private handleMessage(message: Message) {
        if (message.channel.type !== "text") return;
        if (message.content.startsWith(this.prefix)) this.handleSubredditMessage(message);
        else if (message.content.startsWith("https://www.reddit.com/r/")) this.handleRedditUrlMessage(message);
    }

    private handleSubredditMessage(message: Message) {
        let args = message.content.substring(this.prefix.length).trim().toLowerCase().split(" ");
        if (!args[0]) {
            message.reply("No help for you!");
            return;
        }

        let props: SubredditMessageHanlderProps = {
            channel: message.channel as TextChannel,
            sender: message.author,
            subreddit: args[0],
            subredditMode: "hot",
        };

        super.emit("redditRequest", props);
    }

    private handleRedditUrlMessage(message: Message) {
        var results = REDDIT_URL_REGEX.exec(message.content);
        if (!results || !results.groups || !results.groups.submissionId) {
            message.reply("Invalid Reddit url.");
            return;
        }

        let props: RedditUrlMessageHanlderProps = {
            channel: message.channel as TextChannel,
            sender: message.author,
            submissionId: results.groups.submissionId,
        };

        super.emit("redditUrl", props);
    }

    private getUrlName(url: string) {
        return crypto.createHash("sha1").update(url, "utf8").digest("hex");
    }

    public async sendImageAttachment(channel: TextChannel, url: string, spoiler: boolean) {
        try {
            let urlName = this.getUrlName(url);
            let name = spoiler ? `SPOILER_${urlName}.png` : `image-${urlName}.png`;
            await channel.send("", new MessageAttachment(url, name));
        } catch (ex) {
            logger("(warning) sendRedditAttachment: could not send as image, sending url instead:", ex);
            await channel.send(`⚠️ ${ex.message} Take a link instead: ${url}`);
        }
    }

    public async sendVideoAttachment(channel: TextChannel, url: string, spoiler: boolean) {
        try {
            let videoFile = await getVideoOrDownload(url);
            let urlName = this.getUrlName(url);
            let name = spoiler ? `SPOILER_${urlName}.mp4` : `video-${urlName}.mp4`;
            await channel.send("", new MessageAttachment(videoFile, name));
        } catch (ex) {
            logger("(warning) sendRedditAttachment: could not send as video, sending url instead:", ex);
            await channel.send(`⚠️ ${ex.message} Take a link instead: ${url}`);
        }
    }

    public async sendUrlAttachment(channel: TextChannel, text: string, spoiler: boolean) {
        if (spoiler) {
            await channel.send(`||${text}||`);
        } else {
            await channel.send(text);
        }
    }

    public createErrorEmbed(title: string, message: string): MessageEmbed {
        return new MessageEmbed().setTitle(`❌ ${title}`).setDescription(message).setColor("#FF4301");
    }

    public createWarningEmbed(title: string, message: string): MessageEmbed {
        return new MessageEmbed().setTitle(`⚠️ ${title}`).setDescription(message).setColor("#FF4301");
    }
}
