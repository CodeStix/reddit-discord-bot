const util = require("util");
const execAsync = util.promisify(require("child_process").exec);
const fs = require("fs");
const crypto = require("crypto");
const existsAsync = util.promisify(fs.exists);
const renameAsync = util.promisify(fs.rename);

var currentPassLog = 0;

module.exports.execOptions = {
    cwd: __dirname + "/cache/ffmpeg"
}

module.exports.disableVideoDownload = false;
module.exports.maxVideoDownloadSize = 100 * 1024 * 1024;

module.exports.compressVideo = async function (inputPath, outputPath, targetBitrate, targetFramerate = 24, targetAudioBitrate = 35000) 
{
    const passLogPrefix = "ffmpegpass" + currentPassLog++;

    var stdout, stderr;
    try
    {
        var startTime = process.hrtime();

        var { stdout, stderr } = await execAsync(`ffmpeg -y -i "${inputPath}" -r ${targetFramerate} -c:v libx264 -tune fastdecode -preset ultrafast -b:v ${targetBitrate} -pass 1 -passlogfile "${passLogPrefix}" -an -f mp4 /dev/null`, module.exports.execOptions);
        var { stdout, stderr } = await execAsync(`ffmpeg -y -i "${inputPath}" -r ${targetFramerate} -c:v libx264 -tune fastdecode -preset ultrafast -b:v ${targetBitrate} -pass 2 -passlogfile "${passLogPrefix}" -c:a copy -b:a ${targetAudioBitrate} "${outputPath}"`, module.exports.execOptions);

        var took = process.hrtime(startTime);
        console.log("[compressVideo] Done, took", took[0] * 1000 + took[1] / 1000000, "ms");
    }
    catch (ex) 
    {
        console.error("[compressVideo] Error:", ex.message, stdout, stderr);
        throw ex;
    }
}

module.exports.getVideoInfo = async function (inputPath)
{
    var stdout, stderr;
    try
    {
        var { stdout, stderr } = await execAsync(`ffprobe -i "${inputPath}" -v quiet -print_format json -show_format -hide_banner`, module.exports.execOptions);
        return JSON.parse(stdout);
    }
    catch (ex)
    {
        console.error("[getVideoInfo] Error:", ex.message, stdout, stderr);
        throw ex;
    }
}

module.exports.getPathForVideo = function (videoUrl, maxVideoSize)
{
    const videoUrlHash = crypto.createHash("sha1").update(videoUrl, "binary").digest("hex");
    return __dirname + "/cache/videos/" + videoUrlHash + "-" + maxVideoSize + ".mp4";
}

var videoWaiters = {};

module.exports.getCachedVideo = async function (videoUrl, maxVideoFileSize = 1000 * 1000 * 8, doNotDownload = false) 
{
    if (!(videoUrl in videoWaiters)) 
    {
        videoWaiters[videoUrl] = module.exports.getCachedVideoTask(videoUrl, maxVideoFileSize, doNotDownload);
    }

    var res = await videoWaiters[videoUrl];
    delete videoWaiters[videoUrl];
    return res;
}

module.exports.getCachedVideoTask = async function (videoUrl, maxVideoFileSize = 1000 * 1000 * 8, doNotDownload = false)
{
    try
    {
        const videoFile = module.exports.getPathForVideo(videoUrl, maxVideoFileSize);

        if (await existsAsync(videoFile)) return videoFile;
        if (doNotDownload || module.exports.disableVideoDownload) return null;

        // https://github.com/ytdl-org/youtube-dl/blob/master/README.md#format-selection
        const tempVideoFile = videoFile + ".temp.mp4";
        await execAsync(
            `youtube-dl -f "[filesize>6M][filesize<=${maxVideoFileSize}]/[filesize>4M][filesize<=6M]/[filesize>2M][filesize<=4M]/[filesize<=2M]/bestvideo+bestaudio/best" --max-filesize ${module.exports.maxVideoDownloadSize} --no-playlist --retries 3 --output "${tempVideoFile}" "${videoUrl}"`, // --no-warnings --print-json --no-progress
            module.exports.execOptions
        );

        // Will error is file not exists
        const videoInfo = await module.exports.getVideoInfo(tempVideoFile);

        // Reencode if too large or if mpegts file (discord does not display these)
        if (videoInfo.format.size > maxVideoFileSize || videoInfo.format.format_name.includes("mpegts") || videoInfo.format.format_name.includes("gif"))
        {
            const targetAudioBitrate = 35000;
            const targetFramerate = 24;
            const targetBitrate = (maxVideoFileSize * 8) / (videoInfo.format.duration * 1.4) - targetAudioBitrate;
            await module.exports.compressVideo(tempVideoFile, videoFile, targetBitrate, targetFramerate, targetAudioBitrate);

            fs.unlink(tempVideoFile, () => { });
        }
        else
        {
            await renameAsync(tempVideoFile, videoFile);
        }

        return videoFile;
    }
    catch (ex)
    {
        console.warn("[ensureCachedVideo] Error: Could not upload/convert video: ", ex.message);
        return null;
    }
}