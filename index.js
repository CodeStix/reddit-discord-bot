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

const videoCachePath = "./cache/video"; //path.join(__dirname, "temp");
const youtubeDlCachePath = "./cache/youtube-dl";
const youtubeDlMaxFileSize = "10M";

// Streamable account: stijnvantvijfde@gmail.com 3vGrFAKTrvQg8UHh

console.log("Connecting to discord...");

bot.login(token);
bot.on("ready", () => {
    console.log("Connected.");
});

async function getAuthorIcon(authorName) {
    // https://www.reddit.com/user/CodeStix/about.json
    return `https://www.redditstatic.com/avatars/avatar_default_${Math.floor(Math.random() * 11) + 10}_DDBD37.png`;
}

/**
 * @param {TextChannel} channel
 * @param {string} url An url attachment for the reddit item.
 */
async function sendUrlSpoiler(channel, url, isVideo) {
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
            default:
                console.warn("Invalid sendAsSpoiler type.");
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

    if (!isVideo) {
        isVideo =
            url.startsWith("https://v.redd.it/") ||
            url.startsWith("https://streamable.com/") ||
            url.startsWith("https://youtube.com/") ||
            url.startsWith("https://youtube-nocookie.com/") ||
            url.startsWith("https://m.youtube.com/") ||
            url.startsWith("https://youtu.be/");
        if (isVideo) console.log("Info: did mark as video");
    }

    if (downloadVideos && isVideo) {
        const videoUrlHash = crypto.createHash("sha1").update(url, "binary").digest("hex");
        const videoPath = path.join(videoCachePath, videoUrlHash + ".mp4");

        if (await existsAsync(videoPath)) {
            console.log("Info: using cached video");
            await setStatus("🖥️ Uploading video...");
            await sendAsSpoiler(videoPath, "video");
        } else {
            await setStatus("🎞️ Converting video...");
            const { stdout, stderr } = await exec(
                `youtube-dl --max-filesize ${youtubeDlMaxFileSize} --cache-dir "${youtubeDlCachePath}" --no-playlist --retries 3 --output "${videoPath}" "${url}"`
            );

            if (await existsAsync(videoPath)) {
                try {
                    await setStatus("🖥️ Uploading video...");
                    await sendAsSpoiler(videoPath, "video");
                } catch (ex) {
                    console.log("Warning: Could not upload video", ex);
                    await sendAsSpoiler(url, "other");
                }
            } else {
                console.log("Warning: Could not convert video", stdout, stderr);
                await sendAsSpoiler(url, "other");
            }
        }
    } else if (url.startsWith("https://i.redd.it/") || url.startsWith("https://postimg.cc/")) {
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

        fs.writeFileSync("./badrequests/latest.json", JSON.stringify(response.data));
    } catch (ex) {
        console.log("Bad response from reddit url", ex.message);

        if (response && response.data) fs.writeFileSync("./badrequests/" + encodeURIComponent(redditUrl) + ".json", JSON.stringify(response.data));

        channel.send(new MessageEmbed().setTitle("Reddit error!").setDescription(ex.message).setColor("#ff0000").setThumbnail(redditIcon));
        return;
    }

    if (obj.selftext && obj.selftext.length > 2048) {
        obj.selftext.splice(2048);
        console.log("Warning: text was too long, spliced it");
    }

    await channel.send(
        new MessageEmbed()
            .setTitle(obj.title)
            .setURL("https://reddit.com" + obj.permalink)
            .setAuthor(obj.author, await getAuthorIcon(obj.author), "https://reddit.com/u/" + obj.author)
            .setColor(obj.title.includes("NSF") ? "#ff1111" : "#11ff11")
            .setDescription(obj.selftext || "")
            .setTimestamp(obj.created * 1000)
    );

    var url = decodeURI(obj.url).replace("&amp;", "&");
    console.log(obj.permalink, url);
    sendUrlSpoiler(channel, url, obj.is_video);
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

    sendRandomRedditItem(message.channel, `https://api.reddit.com/${subredditName}/${redditReturnType}`);
});
