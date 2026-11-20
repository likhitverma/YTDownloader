"use strict";
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, "public"),
  DATA_DIR: process.env.MEDIADOCK_DATA_DIR ? path.resolve(process.env.MEDIADOCK_DATA_DIR) : path.join(ROOT, "data"),
  DEFAULT_DOWNLOAD_DIR: process.env.MEDIADOCK_DOWNLOAD_DIR
    ? path.resolve(process.env.MEDIADOCK_DOWNLOAD_DIR)
    : path.join(ROOT, "downloads"),
  HOST: "127.0.0.1", // local-only on purpose
  PORT: Number(process.env.PORT || 3000),
  MAX_CONCURRENT_LIMIT: 10,
  DEFAULT_CONCURRENT: 5,
  MAX_QUEUE: 200,
  MAX_HISTORY: 500
};
