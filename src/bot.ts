import { Client as DiscordBot, Message, MessageAttachment, MessageEmbed, MessageFlags, TextChannel, User } from "discord.js";
import { debug } from "debug";
import { EventEmitter } from "events";
import { SubredditMode, SUBREDDIT_MODES } from "./reddit";
import { getVideoOrDownload } from "./video";
import crypto from "crypto";
import { getPreviousInput, storePreviousInput } from "./redis";
import { createUnknownErrorEmbed, RedditBotError } from "./error";

const logger = debug("rdb:bot");

export interface SubredditMessageHanlderProps {
    channel: TextChannel;
    sender: User;
    subreddit: string;
    queryOrMode: SubredditMode | string;
}
export interface RedditUrlMessageHanlderProps {
    channel: TextChannel;
    sender: User;
    submissionId: string;
}

const REDDIT_URL_REGEX = /^https?:\/\/(?:www\.)?reddit\.com\/(?:r\/(?<subredditName>[\w\d]+)\/)?comments\/(?<submissionId>[\w\d]+)/i;
const EXAMPLE_SUBREDDITS = ["memes", "pics", "dankmemes", "videos", "dankvideos"];

export class RedditBot extends EventEmitter {
    public prefix: string;
    public defaultMode: SubredditMode = "hot";
    public minUsageInterval: number = 1500;
    public aliases: Record<string, string> = {
        "5050": "fiftyfifty",
        mc: "minecraft",
    };

    private processingChannels: any = {};
    private bot: DiscordBot;

    constructor(token: string, prefix: string) {
        super();
        this.prefix = prefix;
        this.bot = new DiscordBot();
        this.bot.once("ready", this.handleReady.bind(this));
        this.bot.on("message", this.handleMessage.bind(this));
        logger("connecting to Discord...");
        this.bot.login(token);
    }

    public getBot(): DiscordBot {
        return this.bot;
    }

    private handleReady() {
        logger("connected to discord");
        setInterval(this.updatePresence.bind(this), 4 * 60 * 60 * 1000);
        this.updatePresence();
    }

    private updatePresence() {
        logger("updating presence");
        this.bot.user!.setPresence({ status: "online", activity: { type: "LISTENING", name: this.prefix } });
    }

    private handleMessage(message: Message) {
        if (message.channel.type !== "text" || message.author.bot) return;
        if (message.content.startsWith(this.prefix)) this.handleSubredditMessage(message);
        else if (message.content.startsWith("https://www.reddit.com/r/")) this.handleRedditUrlMessage(message);
    }

    private createHelpEmbed() {
        let subreddit = EXAMPLE_SUBREDDITS[Math.floor(Math.random() * EXAMPLE_SUBREDDITS.length)];
        return new MessageEmbed().setTitle("Reddit Bot Help").setColor("#FF4301").setDescription(`
            **You can use the \`${this.prefix}\` prefix in the following ways:**

            🔥 \u00A0 **\`${this.prefix}${subreddit}\`**: shows a hot post from the r/${subreddit} subreddit.

            🔍 \u00A0 **\`${this.prefix}${subreddit} minecraft\`**: searches for posts in the r/${subreddit} subreddit containing 'minecraft'.

            🆕 \u00A0 **\`${this.prefix}${subreddit} new\`**: shows a new post. You can also use **top**, **best**, **rising** and **hot**.

            🕐 \u00A0 **\`${this.prefix}${subreddit} week\`**: shows a top post from the last week. You can also use **hour**, **day**, **week**, **month**, **year** and **all**.

            🔁 \u00A0 **\`${this.prefix}/\`**: repeat your previous input.

            **You can also paste a reddit url, I will convert it into a nice styled message.**

            ❤️ Thanks for using this bot! If you like it, you should consider [voting](https://top.gg/bot/711524405163065385).

            [More information here](https://codestix.nl/article/reddit-discord-bot)
        `);
    }

    private rateLimit(channelId: string): boolean {
        if (this.processingChannels[channelId]) return false;
        this.processingChannels[channelId] = true;
        setTimeout(() => delete this.processingChannels[channelId], this.minUsageInterval);
        return true;
    }

    private async handleSubredditMessage(message: Message) {
        logger("input '%s'", message.content);
        if (!this.rateLimit(message.channel.id)) {
            logger("cancelled input '%s', rate limit", message.content);
            return;
        }

        let raw = message.content.substring(this.prefix.length).trim().toLowerCase();
        let permissions = message.guild!.me!.permissions;
        if (
            !permissions.has("ATTACH_FILES") ||
            !permissions.has("EMBED_LINKS") ||
            !permissions.has("SEND_MESSAGES") ||
            !permissions.has("ADD_REACTIONS") ||
            !permissions.has("MANAGE_MESSAGES")
        ) {
            logger("insufficient permissions for channel (%d)", message.channel.id);
            if (permissions.has("EMBED_LINKS")) {
                message.channel.send(
                    this.createErrorEmbed(
                        "No Discord permissions",
                        "You disabled my powers! Please allow me to **send messages**, **manage messages**, **embed links**, **add reactions** and **attach files**."
                    )
                );
            } else {
                message.channel.send(
                    "You disabled my powers! Please allow me to **send messages**, **manage messages**, **embed links**, **add reactions** and **attach files**."
                );
            }
            return;
        }

        if (!raw || raw === "help" || raw === "h" || raw === "?") {
            message.channel.send(this.createHelpEmbed());
            return;
        } else if (raw === "/") {
            // Repeat previous input
            let previous = await getPreviousInput(message.channel.id, message.author.id);
            if (!previous) {
                message.channel.send(this.createWarningEmbed("I don't remember", "I don't remember your previous input, please type it yourself."));
                return;
            }
            raw = previous;
        }

        let args = raw.split(/ |,|:|\//g);
        let subreddit = args[0];
        let queryOrMode: SubredditMode | string = args.slice(1).join(" ").trim() || this.defaultMode;

        if (queryOrMode.length > 30) {
            message.channel.send(this.createWarningEmbed("Please use a shorter search text.", ""));
            return;
        }

        subreddit = this.aliases[subreddit] ?? subreddit;

        storePreviousInput(message.channel.id, message.author.id, raw);

        let props: SubredditMessageHanlderProps = {
            channel: message.channel as TextChannel,
            sender: message.author,
            subreddit: subreddit,
            queryOrMode: queryOrMode,
        };

        super.emit("redditRequest", props);
    }

    private handleRedditUrlMessage(message: Message) {
        if (!this.rateLimit(message.channel.id)) {
            logger("cancelled input '%s', rate limit", message.content);
            return;
        }

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

        // Remove default embed
        setTimeout(() => message.suppressEmbeds(true), 100);
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
            logger("could not send as image, sending url instead:", ex);
            await channel.send(`⚠️ Could not upload to Discord, take a link instead: ${url}`);
        }
    }

    public async sendVideoAttachment(channel: TextChannel, url: string, spoiler: boolean) {
        try {
            let videoFile = await getVideoOrDownload(url);
            let urlName = this.getUrlName(url);
            let name = spoiler ? `SPOILER_${urlName}.mp4` : `video-${urlName}.mp4`;
            await channel.send("", new MessageAttachment(videoFile, name));
        } catch (ex) {
            if (ex instanceof RedditBotError) {
                await channel.send(ex.createEmbed());
            } else {
                await channel.send(createUnknownErrorEmbed("Could not download video"));
            }
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
