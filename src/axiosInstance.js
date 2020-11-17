const axios = require("axios").default;

module.exports = axios.create({
    responseType: "text",
    transformResponse: function (data)
    {
        return JSON.parse(
            data
                .replace(/&amp;/g, "&")
                .replace(/&quot;/g, "'")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
        );
    },
});

module.exports.default = axios;