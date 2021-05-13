# reddit-discord-bot

Browse Reddit using this Discord bot! It downloads video posts, leaves r/5050 images unspoiled and shows a comment section preview.

![preview](https://github.com/CodeStix/reddit-discord-bot/raw/master2/images/videopreview.gif)

<a href="https://top.gg/bot/711524405163065385">
    <img src="https://top.gg/api/widget/711524405163065385.svg" alt="Reddit" />
    <p>Click here to invite</p>
</a>

## Usage

- 🔥 **`r/pics`**: shows a hot post from the r/pics subreddit.
- 🔍 **`r/pics minecraft`**: searches for posts in the r/pics subreddit containing 'minecraft'.
- 🆕 **`r/pics new`**: shows a new post. You can also use **top**, **best**, **rising** and **hot**.
- 🕐 **`r/pics week`**: shows a top post from the last week. You can also use **hour**, **day**, **week**, **month**, **year** and **all**.
- 🔁 **`r//`**: repeat your previous input.

**To enable NSFW reddit content (e.g. r/fiftyfifty), you **MUST** mark the Discord channel as NSFW.**

## Reddit urls

You can also paste a Reddit url into the chat, the bot will transform it into a nice embedded message.

![reddit url embedding](https://github.com/CodeStix/reddit-discord-bot/raw/master2/images/urlpaste.gif)

## How it works

This bot is made with nodejs, ffmpeg, youtube-dl and redis.

1. The bot listens for any incoming Discord message and checks if the message's content starts with the `r/` prefix.
2. Parses input: `r/pics new` => `var subreddit = "pics", mode = "new"`.
3. Looks in the redis cache if a post was already requested from this subreddit. If not, request from the reddit api and store it in the cache.
4. Loop through the reddit response until a post matches the filter.
5. Store the current subreddit post index in the redis cache. (so the bot knows where to start looking for the next post)
6. If video, use youtube-dl and ffmpeg to download and convert the video to mp4. If the video is larger than 8MB, compress the video using ffmpeg.
7. Send the post in an embedded Discord message.
