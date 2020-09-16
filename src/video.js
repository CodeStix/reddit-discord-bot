const util = require("util");
const execAsync = util.promisify(require("child_process").exec);
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const existsAsync = util.promisify(fs.exists);
const renameAsync = util.promisify(fs.rename);

const debug = false;

var currentPassLog = 0;

module.exports.disableVideoDownload = false;
module.exports.maxVideoDownloadSize = 100 * 1024 * 1024;
module.exports.maxVideoCompressLength = 120;

module.exports.compressVideo = async function (
    inputPath,
    outputPath,
    targetBitrate,
    targetFramerate = 24,
    targetAudioBitrate = 35000
) {
    const passLogPath = path.join(__dirname, "cache/ffmpeg/ffmpegpass" + currentPassLog++);

    var stdout, stderr;
    try {
        var startTime = process.hrtime();

        var ffmpegCmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -strict -2 -passlogfile "${passLogPath}" -r ${targetFramerate} -tune fastdecode -preset ultrafast -b:v ${targetBitrate} -pass 1 -an -f mp4 /dev/null`;
        if (debug) console.log(`[video] (debug) compressVideo: execute ffmpeg: ${ffmpegCmd}`);
        var { stdout, stderr } = await execAsync(ffmpegCmd);
        ffmpegCmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -strict -2 -passlogfile "${passLogPath}" -r ${targetFramerate} -tune fastdecode -preset ultrafast -b:v ${targetBitrate} -pass 2 -c:a copy -b:a ${targetAudioBitrate} "${outputPath}"`;
        if (debug) console.log(`[video] (debug) compressVideo: execute ffmpeg: ${ffmpegCmd}`);
        var { stdout, stderr } = await execAsync(ffmpegCmd);

        var took = process.hrtime(startTime);
        console.log("[video] compressVideo: took", took[0] * 1000 + took[1] / 1000000, "ms");
    } catch (ex) {
        console.error("[video] (error) compressVideo:", ex.message, stderr);
        throw ex;
    } finally {
        // remove the by ffmpeg created passlog file
        fs.unlink(passLogPath + "-0.log", (err) => {
            if (err)
                console.warn(
                    "[video] (warning) compressVideo: could not remove pass log file:",
                    err
                );
        });
    }
};

module.exports.getVideoInfo = async function (inputPath) {
    var stdout, stderr;
    try {
        const probeCmd = `ffprobe -i "${inputPath}" -v quiet -print_format json -show_format -hide_banner`;
        if (debug) console.log(`[video] (debug) getVideoInfo: execute probe: ${probeCmd}`);
        var { stdout, stderr } = await execAsync(probeCmd);
        return JSON.parse(stdout);
    } catch (ex) {
        console.error("[video] (error) getVideoInfo:", ex.message, stdout, stderr);
        throw ex;
    }
};

module.exports.getPathForVideoUrl = function (videoUrl, maxVideoSize = 1000 * 1000 * 8) {
    const videoUrlHash = crypto.createHash("sha1").update(videoUrl, "binary").digest("hex");
    const videoFileName = videoUrlHash + "-" + maxVideoSize + ".mp4";
    return path.join(__dirname, "cache/videos/" + videoFileName);
};

module.exports.getCachedVideoPath = async function (videoUrl, maxVideoFileSize = 1000 * 1000 * 8) {
    const videoFile = module.exports.getPathForVideoUrl(videoUrl, maxVideoFileSize);
    return (await existsAsync(videoFile)) ? videoFile : null;
};

module.exports.getCachedVideo = async function (
    videoUrl,
    maxVideoFileSize = 1000 * 1000 * 8,
    doNotDownload = false
) {
    const videoFile = await module.exports.getCachedVideoPath(videoUrl, maxVideoFileSize);
    if (videoFile) {
        // The video is already downloaded
        if (debug) console.log("[video] (debug) getCachedVideo: already downloaded:", videoFile);
        return videoFile;
    }

    if (doNotDownload || module.exports.disableVideoDownload) {
        console.warn(
            "[video] (warning) getCachedVideo: not downloading video, video downloading is disabled."
        );
        throw new Error("Video not available.");
    }

    return await module.exports.cacheVideo(videoUrl, maxVideoFileSize);
};

var videoWaiters = {};

module.exports.cacheVideo = async function (videoUrl, maxVideoFileSize = 1000 * 1000 * 8) {
    // Make sure the same video is not downloaded twice at the same time
    if (!(videoUrl in videoWaiters)) {
        videoWaiters[videoUrl] = module.exports.cacheVideoTask(videoUrl, maxVideoFileSize);
    }

    try {
        return await videoWaiters[videoUrl];
    } finally {
        delete videoWaiters[videoUrl];
    }
};

module.exports.cacheVideoTask = async function (videoUrl, maxVideoFileSize = 1000 * 1000 * 8) {
    const videoFile = module.exports.getPathForVideoUrl(videoUrl, maxVideoFileSize);
    if (await existsAsync(videoFile)) return videoFile;

    // https://github.com/ytdl-org/youtube-dl/blob/master/README.md#format-selection
    // -4 flag: https://github.com/ytdl-org/youtube-dl/issues/19269
    const tempVideoFile = videoFile + ".temp.mp4";
    const youtubeCmd = `youtube-dl -4 -f "[filesize>6M][filesize<=${maxVideoFileSize}]/[filesize>4M][filesize<=6M]/[filesize>2M][filesize<=4M]/[filesize<=2M]/best/bestvideo+bestaudio" --max-filesize ${module.exports.maxVideoDownloadSize} --recode-video mp4 --no-playlist --retries 3 --output "${tempVideoFile}" "${videoUrl}"`; // --no-warnings --print-json --no-progress;
    if (debug) console.log(`[video] (debug) getCachedVideoTask: execute youtube-dl: ${youtubeCmd}`);
    try {
        console.log("youtubecmd", youtubeCmd);
        await execAsync(youtubeCmd);
    } catch (ex) {
        console.error("[video] (error) getCachedVideoTask: youtube-dl failed:", ex);
        throw new Error("Error while downloading video.");
    }

    var videoInfo;
    try {
        videoInfo = await module.exports.getVideoInfo(tempVideoFile);
    } catch (ex) {
        console.error("[video] (error) getCachedVideoTask: could not get video info:", videoInfo);
        throw new Error("Could not get video information.");
    }

    if (
        !videoInfo.format.duration ||
        videoInfo.format.duration > module.exports.maxVideoCompressLength
    ) {
        console.error(
            "[video] (error) getCachedVideoTask: video is too long:",
            videoInfo.format.duration
        );
        throw new Error("Video is too long!");
    }

    // Reencode if too large or if mpegts file (discord does not display these)
    if (
        videoInfo.format.size > maxVideoFileSize ||
        videoInfo.format.format_name.includes("mpegts") ||
        videoInfo.format.format_name.includes("gif")
    ) {
        console.log("[video] getCachedVideoTask: compressing, video format:", videoInfo.format);
        const targetAudioBitrate = 35000;
        const targetFramerate = 24;
        const targetBitrate =
            (maxVideoFileSize * 8) / (videoInfo.format.duration * 1.4) - targetAudioBitrate;

        try {
            await module.exports.compressVideo(
                tempVideoFile,
                videoFile,
                targetBitrate,
                targetFramerate,
                targetAudioBitrate
            );
        } catch (ex) {
            console.error("[video] (error) getCachedVideoTask: could not compress video:", ex);
            throw new Error("Error while compressing video.");
        }

        fs.unlink(tempVideoFile, () => {});
    } else {
        await renameAsync(tempVideoFile, videoFile);
    }

    return videoFile;
};
