import { debug } from "debug";
import { Client as DiscordBot } from "discord.js";
import DBL from "dblapi.js";

const logger = debug("rdb:topgg");

export class TopGGApi {
    private connection: DBL;

    constructor(token: string, bot: DiscordBot) {
        this.connection = new DBL(token, bot);
        this.connection.on("posted", this.handlePosted);
        this.connection.on("error", this.handleError);
    }

    private handlePosted() {
        logger("server count posted");
    }

    private handleError(err: any) {
        logger("error:", err);
    }
}
