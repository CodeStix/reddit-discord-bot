const { Client, MessageAttachment, MessageEmbed, Message, TextChannel } = require("discord.js");
const bot = new Client();
const axios = require("axios").default;
const util = require("util");
const path = require("path");
const http = require("http");
const fs = require("fs");
const exec = util.promisify(require("child_process").exec);
const crypto = require("crypto");
const existsAsync = util.promisify(fs.exists);

const token = "NzExNTI0NDA1MTYzMDY1Mzg1.XsEQ-w.ulbbTU95eEMpvP5sqXJqEMGnebI";
const redditIcon = "https://www.redditstatic.com/desktop2x/img/favicon/apple-icon-72x72.png";
const redditUrlTypes = ["hot", "random", "rising"];

let downloadVideos = true;

const tempFilePath = "./temp"; //path.join(__dirname, "temp");

// stijnvantvijfde@gmail.com 3vGrFAKTrvQg8UHh

console.log("Connecting to discord...");

bot.login(token);
bot.on("ready", () => {
    console.log("Connected.");
});

/**
 * @param {TextChannel} channel
 * @param {string} url An url attachment for the reddit item.
 */
async function sendUrlSpoiler(channel, url) {
    var message = await channel.send("Loading...");

    async function setStatus(status) {
        if (status) await message.edit(status);
        else await message.delete();
    }

    /**
     * @param {string} url
     * @param {'other' | 'image' | 'video'} type
     */
    async function sendAsSpoiler(url, type) {
        switch (type) {
            case "other":
                await channel.send("||" + url + "||", { spoiler: true });
                return;
            case "image":
                await channel.send(new MessageAttachment(url, "SPOILER_.png"));
                return;
            case "video":
                await channel.send(new MessageAttachment(url, "SPOILER_.mp4"));
                return;
        }
    }

    if (url.startsWith("https://5050") || url.startsWith("http://5050") || url.startsWith("http://bit.ly") || url.startsWith("https://bit.ly")) {
        try {
            url = (await axios.head(url, { maxRedirects: 1 })).request.res.responseUrl;
        } catch (ex) {
            console.log("Warning: Could not get redirected url", ex.message);
        }
    }

    if (downloadVideos && (url.startsWith("https://v.redd.it/") || url.startsWith("http://v.redd.it/"))) {
        const videoUrlHash = crypto.createHash("sha1").update(url, "binary").digest("hex");
        const tempVideoPath = path.join(tempFilePath, videoUrlHash + ".mp4");

        if (await existsAsync(tempVideoPath)) {
            console.log("Info: using cached video");
            await setStatus("🖥️ Uploading video...");
            await sendAsSpoiler(tempVideoPath, "video");
        } else {
            await setStatus("🎞️ Converting video...");
            const { stdout, stderr } = await exec(`ffmpeg -i "${url + "/DASHPlaylist.mpd"}" "${tempVideoPath}"`);

            if (await existsAsync(tempVideoPath)) {
                try {
                    await setStatus("🖥️ Uploading video...");
                    await sendAsSpoiler(tempVideoPath, "video");
                } catch (ex) {
                    console.log("Warning: Could not upload video", ex);
                    await sendAsSpoiler(url, "other");
                }
            } else {
                console.log("Warning: Could not convert video", stdout, stderr);
                await sendAsSpoiler(url, "other");
            }
        }
    } else if (url.startsWith("https://i.redd.it/") || url.startsWith("http://i.redd.it/")) {
        sendAsSpoiler(url, "image");
    } else {
        sendAsSpoiler(url, "other");
    }

    setStatus("");
}

/**
 * @param {TextChannel} channel The receiving channel.
 * @param {string} redditUrl
 */
async function sendRandomRedditItem(channel, redditUrl) {
    var obj, response;
    try {
        response = await axios.get(redditUrl, { responseType: "json" });
        const data = Array.isArray(response.data) ? response.data[0].data : response.data.data;
        if (data.children.length > 0) {
            obj = data.children[Math.floor(Math.random() * data.children.length)].data;
        } else {
            throw new Error("No items returned.");
        }
    } catch (ex) {
        console.log("Bad response from reddit url", ex.message);

        if (response && response.data) fs.writeFileSync("./badrequests/" + encodeURIComponent(redditUrl) + ".json", JSON.stringify(response.data));

        channel.send(new MessageEmbed().setTitle("Reddit error!").setDescription(ex.message).setColor("#ff0000").setThumbnail(redditIcon));
        return;
    }

    if (obj.selftext && obj.selftext.length > 2048) obj.selftext.splice(2048);

    await channel.send(
        new MessageEmbed()
            .setTitle(obj.title)
            .setURL("https://reddit.com" + obj.permalink)
            .setAuthor(obj.author, redditIcon, "https://reddit.com/u/" + obj.author)
            .setColor(obj.title.includes("NSF") ? "#ff1111" : "#11ff11")
            .setDescription(obj.selftext || "")
            .setTimestamp(obj.created * 1000)
    );

    var url = decodeURI(obj.url).replace("&amp;", "&");
    console.log(obj.permalink, url);
    sendUrlSpoiler(channel, url);
}

/**
 * @param {TextChannel} channel
 */
async function sendFiftyFiftyList(channel) {
    const redditUrl = "https://api.reddit.com/r/FiftyFifty/rising";

    var items, response;
    try {
        response = await axios.get(redditUrl, { responseType: "json" });
        items = response.data.data.children;
    } catch (ex) {
        console.log("Bad response from reddit url:", ex);
        return;
    }

    var message = new MessageEmbed();

    for (var i = 0; i < items.length; i++) {
        message.addField(items[i].data.title, items[i].data.url);
        console.log("item", i);
    }

    channel.send(message);
}

var previousSubreddits = {};

bot.on("message", (message) => {
    if (message.author.bot) return;

    if (!message.content.startsWith("r/")) return;

    const input = message.content.trim().toLowerCase();
    const topic = message.channel.topic.trim().toLowerCase();

    var subredditName; // without r/
    if (input == "r/" && topic.startsWith("r/")) {
        subredditName = topic;
    } else if (input == "r//") {
        subredditName = previousSubreddits[message.channel.id];
        if (!subredditName) return;
    } else if (input == "r//list") {
        message.channel.send("`" + util.inspect(previousSubreddits) + "`");
        return;
    } else {
        subredditName = input;
    }

    /*if (message.author.username == "barfcomilitoon") {
        message.reply("stop keer me spacen");
        return;
    }*/

    subredditName = subredditName.replace(/[\\:'"]/gi, "");
    previousSubreddits[message.channel.id] = subredditName;

    const redditReturnType = redditUrlTypes[Math.floor(Math.random() * redditUrlTypes.length)];

    console.log("using", redditReturnType);

    sendRandomRedditItem(message.channel, `https://api.reddit.com/${subredditName}/${redditReturnType}`);
});
