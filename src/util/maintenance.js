require("dotenv").config();
const discord = require("discord.js");
const debug = require("debug");

const logger = debug("rdb-maintenance");
const bot = new discord.Client();

bot.once("ready", () => {
    logger("connected to Discord");
});

logger("connecting to Discord...");
bot.login(process.env.DISCORD_TOKEN);

bot.on("message", (message) => {
    if (message.channel.type !== "text") return;
    if (message.content.startsWith("r/") || message.content.startsWith("https://www.reddit.com/r/")) {
        message.channel.send(
            new discord.MessageEmbed()
                .setTitle("Maintenance mode 😮")
                .setColor("#FF4301")
                .setDescription(
                    "The bot is currently being worked on! Please come back later for more Reddit. If you like this bot, now is the time to [vote](https://top.gg/bot/711524405163065385) ❤️. Also, you have a bug to submit, open an issue [here](https://github.com/CodeStix/reddit-discord-bot/issues/new)."
                )
        );
    }
});
