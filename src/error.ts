import { MessageEmbed } from "discord.js";

export type RedditBotErrorType =
    | "subreddit-not-found"
    | "private-subreddit"
    | "banned-subreddit"
    | "no-matching-posts"
    | "end-of-feed"
    | "unknown"
    | "unknown-fetch";

export function createUnknownErrorEmbed(message?: string) {
    return new MessageEmbed()
        .setTitle("❌ Unknown problem")
        .setDescription(
            `Beep boop, the bot has self destructed, i hope a developer will look at this error message... ${message}`
        )
        .setFooter("This error got automatically submitted to the devs.");
}

export class RedditBotError extends Error {
    public type: RedditBotErrorType;

    constructor(type: RedditBotErrorType = "unknown", message?: string) {
        let trueProto = new.target.prototype; // https://stackoverflow.com/questions/55065742/implementing-instanceof-checks-for-custom-typescript-error-instances
        super(message);
        Object.setPrototypeOf(this, trueProto);
        this.name = "RedditBotError";
        this.type = type;
    }

    public createEmbed(): MessageEmbed {
        switch (this.type) {
            case "end-of-feed":
                return new MessageEmbed().setTitle(`⚠️ End of feed`).setColor("#FF4301").setDescription(this.message);
            case "no-matching-posts":
                return new MessageEmbed()
                    .setTitle(`⚠️ No posts match your filters. Try enabling NSFW to show more content. ${this.message}`)
                    .setColor("#FF4301")
                    .setImage("https://github.com/CodeStix/reddit-discord-bot/raw/master/images/enable-nsfw.gif");

            case "banned-subreddit":
                return new MessageEmbed()
                    .setTitle(`❌ Banned subreddit`)
                    .setDescription(`This subreddit has been banned by Reddit. 😠 ${this.message}`)
                    .setColor("#FF4301");
            case "private-subreddit":
                return new MessageEmbed()
                    .setTitle(`❌ Private subreddit`)
                    .setDescription(`This subreddit is private and cannot be accessed by me. 😢 ${this.message}`)
                    .setColor("#FF4301");
            case "subreddit-not-found":
                return new MessageEmbed()
                    .setTitle(`❌ Not found?`)
                    .setDescription(`This subreddit was not found. Misspelled? ${this.message}`)
                    .setColor("#FF4301");
            case "unknown":
            case "unknown-fetch":
                return createUnknownErrorEmbed(this.message);
        }
    }

    static fromReddit404ErrorData(data?: any) {
        if (!data) return new RedditBotError("unknown-fetch");
        if (data.reason === "banned") return new RedditBotError("banned-subreddit");
        if (data.reason === "private") return new RedditBotError("private-subreddit");
        throw new RedditBotError("subreddit-not-found");
    }
}
