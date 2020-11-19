import { Client as DiscordBot, Message, MessageAttachment, MessageEmbed, TextChannel, User } from "discord.js";
import { debug } from "debug";
import { EventEmitter } from "events";
import { RedditFetchError, SubredditMode, SUBREDDIT_MODES } from "./reddit";
import { getVideoOrDownload } from "./video";
import crypto from "crypto";
import { getPreviousInput, storePreviousInput } from "./redis";

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
    public defaultMode: SubredditMode = "week";

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

    private createHelpEmbed() {
        return new MessageEmbed().setTitle("Reddit Bot Help").setColor("#FF4301").setDescription(`
            **You can use the \`${this.prefix}\` prefix in the following ways:**

            - \`${this.prefix}pics\`: shows a top post from the r/pics subreddit.

            - \`${this.prefix}pics new\`: shows a new post. You can also use **top**, **best**, **rising** and **hot**.

            - \`${this.prefix}pics top\`: shows a top post.

            - \`${this.prefix}pics top week\` or \`${this.prefix}pics week\`: shows a top post from the last week. You can also use **hour**, **day**, **month**, **year** and **all**.

            ℹ️ **Protip: **You can use the \`${this.prefix}/\` shortcut to repeat your previous input.
            You can also paste a reddit url, I will convert it into a nice styled message.

            ❤️ Thanks for using this bot! If you like it, you should consider [voting](https://top.gg/bot/711524405163065385).

            [More information here](https://codestix.nl/article/reddit-discord-bot)
        `);
    }

    private async handleSubredditMessage(message: Message) {
        let raw = message.content.substring(this.prefix.length).trim().toLowerCase();

        if (!raw || raw === "help" || raw === "h" || raw === "?") {
            message.channel.send(this.createHelpEmbed());
            return;
        } else if (raw === "/") {
            // Repeat previous input
            let previous = await getPreviousInput(message.channel.id, message.author.id);
            if (!previous) {
                message.channel.send(
                    this.createWarningEmbed(
                        "I don't remember",
                        "I don't remember your previous input, please type it yourself."
                    )
                );
                return;
            }
            raw = previous;
        }

        let args = raw.split(/ |,|:|\//g);
        let subreddit = args[0];
        let subredditMode: SubredditMode = this.defaultMode;

        if (args.length > 1) {
            if (!SUBREDDIT_MODES.includes(args[1])) {
                logger("user entered wrong subreddit mode %s", args[1]);
                message.channel.send(
                    this.createWarningEmbed(
                        `I don't know ${args[1]}?`,
                        `**Please use one of the following variations:**\n` +
                            SUBREDDIT_MODES.map(
                                (e) => `r/${subreddit} ${e} ${e === this.defaultMode ? "**(default)**" : ""}`
                            ).join("\n")
                    )
                );
                return;
            }
            subredditMode = args[1] as SubredditMode;
        }

        storePreviousInput(message.channel.id, message.author.id, raw);

        let props: SubredditMessageHanlderProps = {
            channel: message.channel as TextChannel,
            sender: message.author,
            subreddit: subreddit,
            subredditMode: subredditMode,
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
