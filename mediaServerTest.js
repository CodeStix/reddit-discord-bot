/*const express = require("express");
const fs = require("fs");

const app = express();

app.get("/:id", (req, res) => {
    const file = "./cache/video/" + req.params.id;
    fs.stat(file, (err, stats) => {
        if (err) return res.status(404).end("error");

        var range = req.headers.range;

        console.log(req.headers);
        console.log("range", range);

        const maxSize = 1000 * 1000 * 8;
        const size = stats.size > maxSize ? maxSize : stats.size;

        res.header("Content-Length", size);
        res.header("Content-Type", "video/mp4");
        res.header("Accept-Ranges", "bytes");
        res.header("Etag", "7e3977ca45a2c2a063e4f29fa3ecdfdd");
        res.header("Timing-Allow-Origin", "*");
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Expose-Headers", "Content-Length,ETag");
        res.header("Server", "codestix");
        res.status(200);

        var stream = fs.createReadStream(file, { start: 0, end: size }).pipe(res);

        stream.on("finish", () => {
            res.end();
        });
    });
});

app.listen(80);*/
