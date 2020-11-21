import crypto from "crypto";
import path from "path";
import fs from "fs";
import { debug } from "debug";
import { exec } from "child_process";
import util from "util";
import { RedditBotError } from "./error";

const VIDEO_CACHE_PATH = path.join(__dirname, "cache/videos");
const FFMPEG_CACHE_PATH = path.join(__dirname, "cache/ffmpeg");
const DEFAULT_VIDEO_SIZE_LIMIT = 1000 * 1000 * 8; // 8mb
const MAX_VIDEO_DOWNLOAD_SIZE = 1000 * 1000 * 100; // 100mb
const MAX_VIDEO_COMPRESS_LENGTH = 150; // Cut video to 150 seconds when compressing
const MAX_VIDEO_LENGTH = 60 * 4; // Skip compressing if larger 4 minutes

const execAsync = util.promisify(exec);
const logger = debug("rdb:video");

let ffmpegCurrentPassLog = 0;
let videoWaiters: any = {};

export function getVideoPath(url: string, maxVideoFileSize: number = DEFAULT_VIDEO_SIZE_LIMIT) {
    let videoUrlHash = crypto.createHash("sha1").update(url, "utf8").digest("hex");
    let videoFileName = `${videoUrlHash}-${maxVideoFileSize}.mp4`;
    return path.join(VIDEO_CACHE_PATH, videoFileName);
}

export async function getVideoOrDownload(
    url: string,
    maxVideoFileSize: number = DEFAULT_VIDEO_SIZE_LIMIT
): Promise<string> {
    let path = getVideoPath(url, maxVideoFileSize);
    if (fs.existsSync(path)) return path;

    logger("downloading '%s'", url);

    if (!(url in videoWaiters)) {
        videoWaiters[url] = downloadVideo(url, path, maxVideoFileSize);
    }

    try {
        return await videoWaiters[url];
    } finally {
        delete videoWaiters[url];
    }
}

export async function downloadVideo(url: string, path: string, maxVideoFileSize: number) {
    if (fs.existsSync(path)) return path;

    // https://github.com/ytdl-org/youtube-dl/blob/master/README.md#format-selection
    // -4 flag: https://github.com/ytdl-org/youtube-dl/issues/19269
    let tempVideoFile = path + ".temp.mp4";
    let tempVideoFileFormat = path + ".temp.%(ext)s";
    let youtubeCmd = `youtube-dl -4 -f "[filesize>6M][filesize<=${maxVideoFileSize}]/[filesize>4M][filesize<=6M]/[filesize>2M][filesize<=4M]/[filesize<=2M]/best/bestvideo+bestaudio" --max-filesize ${MAX_VIDEO_DOWNLOAD_SIZE} --recode-video mp4 --no-playlist --retries 3 --output "${tempVideoFileFormat}" "${encodeURI(
        url
    )}"`; // --no-warnings --print-json --no-progress;
    logger(`execute youtube-dl: ${youtubeCmd}`);
    try {
        await execAsync(youtubeCmd);
    } catch (ex) {
        logger("could not download video using youtube-dl:", ex);
        throw new RedditBotError("video-download", url);
    }

    let videoInfo;
    try {
        videoInfo = await getVideoInfo(tempVideoFile);
    } catch (ex) {
        logger("could not get video info:", videoInfo);
        throw new RedditBotError("video-download", url);
    }

    if (!videoInfo.format.duration || videoInfo.format.duration > MAX_VIDEO_LENGTH) {
        logger("video is too long (%d), not downloading", videoInfo.format.duration);
        throw new RedditBotError("video-too-long", url);
    }

    // Compress if video file size is too large or if mpegts file (discord does not display these)
    if (
        videoInfo.format.size > maxVideoFileSize ||
        videoInfo.format.format_name.includes("mpegts") ||
        videoInfo.format.format_name.includes("gif")
    ) {
        logger(
            "compressing video (size=%f, duration=%f/%f)",
            videoInfo.format.size,
            videoInfo.format.duration,
            MAX_VIDEO_COMPRESS_LENGTH
        );
        let targetAudioBitrate = 35000;
        let targetFramerate = 24;
        let targetBitrate =
            (maxVideoFileSize * 8) / (Math.min(videoInfo.format.duration, MAX_VIDEO_COMPRESS_LENGTH) * 1.4) -
            targetAudioBitrate;

        try {
            await compressVideo(tempVideoFile, path, targetBitrate, targetFramerate, targetAudioBitrate);
        } catch (ex) {
            logger("could not compress video:", ex);
            throw new RedditBotError("video-compress", url);
        }

        fs.unlink(tempVideoFile, () => {});
    } else {
        fs.renameSync(tempVideoFile, path);
    }

    return path;
}

export async function compressVideo(
    inputPath: string,
    outputPath: string,
    targetBitrate: number,
    targetFramerate: number = 24,
    targetAudioBitrate: number = 35000
) {
    let passLogPath = path.join(FFMPEG_CACHE_PATH, "passlog" + ffmpegCurrentPassLog++);

    try {
        let startTime = process.hrtime();

        let ffmpegCmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -strict -2 -passlogfile "${passLogPath}" -r ${targetFramerate} -tune fastdecode -preset ultrafast -t ${MAX_VIDEO_COMPRESS_LENGTH} -b:v ${targetBitrate} -pass 1 -an -f mp4 /dev/null`;
        await execAsync(ffmpegCmd);
        ffmpegCmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -strict -2 -passlogfile "${passLogPath}" -r ${targetFramerate} -tune fastdecode -preset ultrafast -t ${MAX_VIDEO_COMPRESS_LENGTH} -b:v ${targetBitrate} -pass 2 -c:a copy -b:a ${targetAudioBitrate} "${outputPath}"`;
        await execAsync(ffmpegCmd);

        let took = process.hrtime(startTime);
        logger("compressing video took %f ms", took[0] * 1000 + took[1] / 1000000);
    } finally {
        // remove the by ffmpeg created passlog file
        fs.unlink(passLogPath + "-0.log", (err) => {
            if (err) logger("warning: could not remove pass log file:", err);
        });
    }
}

export async function getVideoInfo(inputPath: string) {
    const probeCmd = `ffprobe -i "${inputPath}" -v quiet -print_format json -show_format -hide_banner`;
    let { stdout } = await execAsync(probeCmd);
    return JSON.parse(stdout);
}
