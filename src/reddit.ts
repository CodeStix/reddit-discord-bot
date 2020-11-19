import { Submission } from "snoowrap";
import { getRedditSubmissions, setRedditSubmissions } from "./redis";
import { debug } from "debug";
import snoowrap from "snoowrap";

const logger = debug("rdb:reddit");

const reddit = new snoowrap({
    userAgent: "Reddit Discord Bot",
    clientId: process.env.REDDIT_CLIENT,
    clientSecret: process.env.REDDIT_SECRET,
    refreshToken: process.env.REDDIT_REFRESH,
});

const CACHE_PER_PAGE = 20;

// @ts-ignore snoowrap bug
export async function getRedditSubmission(
    subreddit: string,
    subredditMode: string,
    index: number
): Promise<Submission> {
    let page = index / CACHE_PER_PAGE;
    let num = index % CACHE_PER_PAGE;

    let cached = await getRedditSubmissions(subreddit, subredditMode, page);
    if (cached !== null) {
        logger("from cache", cached.length);
        // @ts-ignore snoowrap bug
        return cached[num];
    } else {
        let submissions = await reddit.getHot(subreddit, { count: CACHE_PER_PAGE, limit: CACHE_PER_PAGE });
        await setRedditSubmissions(subreddit, subredditMode, page, submissions);
        logger("storing in cache", submissions.length);
        return submissions;
    }
}
