# reddit-discord-bot

An amazing Discord bot that connects with reddit. Has video downloading support, 50/50 spoilers ...

Made with nodejs, ffmpeg, youtube-dl and redis.

## Usage

### Using the prefix

The bot uses the `r/` prefix:

-   `r/abruptchaos`: sends a (top of the month by default) reddit post of the `r/abruptchaos` subreddit to the current channel.
-   `r/abruptchaos/<mode>`: mode can be _hot_, _rising_, _new_, _best_ or _top_.
-   `r/abruptchaos/top?t=<timespan>`: timespan can be _hour_, _day_, _week_, _month_, _year_ or _all_.

Timespans are only valid for the _top_ mode.

![bot prefix usage](https://github.com/CodeStix/reddit-discord-bot/raw/master/images/redditprefix.png)

### Embedding

You can also past a reddit url into the chat, the bot will transform it into a nice embedded message.

![reddit url embedding](https://github.com/CodeStix/reddit-discord-bot/raw/master/images/redditurl.png)

## Host yourself

To host this bot yourself, you have to...

1. Clone this repository.
2. Run the `install.sh` if you are on Linux. On Windows, you have to manually install youtube-dl, ffmpeg and redis. (make sure these are added to the PATH environment variable!)
3. Register a new bot in the Discord developer portal and invite it to your Discord server.
4. Populate the `.env` and `redis.conf` files. You will have to provide your Discord bot token here.
5. Start the redis server with `redis-server redis.conf`
6. Start the bot with `node src/index.js`
7. Done! Try it in your server.
