<a href="https://top.gg/bot/711524405163065385">
    <img src="https://top.gg/api/widget/711524405163065385.svg" alt="Reddit" />
</a>

# reddit-discord-bot

An amazing Discord bot that connects with reddit. Has video playback support, NSFW (and 50/50) spoilers ...

![preview](https://i.imgur.com/rvo6bwx.gif)

### Invite by clicking [here](https://discord.com/oauth2/authorize?client_id=711524405163065385&scope=bot&permissions=326720).



## Usage

The bot uses the `r/` prefix:

-   `r/pics`: shows a top post from the r/pics subreddit.
-   `r/pics new`: shows a new post. You can also use **top**, **best**, **rising** and **hot**.
-   `r/pics top`: shows a top post.
-   `r/pics week` or `r/pics top week`: shows a top post from the last week. You can also use **hour**, **day**, **month**, **year** and **all**.

ℹ️ **Protip:** You can use the `r//` shortcut to repeat your previous input.

To enable NSFW reddit content (e.g. r/fiftyfifty), you **MUST** mark the Discord channel as NSFW.

![bot prefix usage](https://github.com/CodeStix/reddit-discord-bot/raw/master/images/redditprefix.png)

## Embedding

You can also paste a reddit url into the chat, the bot will transform it into a nice embedded message.

![reddit url embedding](https://github.com/CodeStix/reddit-discord-bot/raw/master/images/redditurl.png)

## How it works

This bot is made with nodejs, ffmpeg, youtube-dl and redis.

1. The bot listens for any incoming Discord message and checks if the message's content starts with the `r/` prefix.
2. Parses input: `r/pics new` => `var subreddit = "pics", mode = "new"`.
3. Looks in the redis cache if a post was already requested from this subreddit. If not, request from the reddit api and store it in the cache.
4. Loop through the reddit response until a post matches the filter.
5. Store the current subreddit post index in the redis cache. (so the bot knows where to start looking for the next post)
6. If video, use youtube-dl and ffmpeg to download and convert the video to mp4. If the video is larger than 8MB, compress the video using ffmpeg.
7. Send the post in an embedded Discord message.

## Host yourself

To host this bot yourself, you have to...

1. Clone this repository.
2. Run the `install.sh` if you are on Linux. On Windows, you have to manually install youtube-dl, ffmpeg and redis. (make sure these are added to the PATH environment variable!)
3. Register a new bot in the Discord developer portal and invite it to your Discord server.
4. Populate the `.env` and `redis.conf` files. You will have to provide your Discord bot token here.
5. Start the redis server with `redis-server redis.conf` (sudo if linux)
6. Start the bot with `node src/index.js` (sudo if linux)
7. Done! Try it in your server.
