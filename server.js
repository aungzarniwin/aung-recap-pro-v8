import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

const app = express();

const PORT = Number(process.env.PORT) || 10000;
const VERSION = "8.0.1";
const MAX_FILE_SIZE = 500 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
  "video/mpeg",
  "video/ogg"
]);

const uploadDir = path.join(
  os.tmpdir(),
  "aung-recap-pro-v8"
);

fs.mkdirSync(uploadDir, {
  recursive: true
});

const jobs = new Map();

app.use(cors());

app.use(
  express.json({
    limit: "2mb"
  })
);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname) || ".mp4";
    const filename = `${crypto.randomUUID()}${extension}`;

    cb(null, filename);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  },

  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      return cb(
        new Error(
          "Unsupported video format. Please use MP4, MOV, WEBM, MKV, AVI, MPEG or OGG."
        )
      );
    }

    cb(null, true);
  }
});


/* =========================================
   BASIC ROUTES
========================================= */

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    app: "AUNG RECAP PRO",
    version: VERSION,
    status: "online"
  });
});


app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    app: "AUNG RECAP PRO",
    version: VERSION,
    status: "healthy",
    node: process.version,
    timestamp: new Date().toISOString()
  });
});


app.get("/api", (req, res) => {
  res.status(200).json({
    ok: true,
    app: "AUNG RECAP PRO",
    version: VERSION,
    status: "online",
    message: "AUNG RECAP PRO API is ready",

    endpoints: {
      health: "GET /health",
      api: "GET /api",
      upload: "POST /api/upload",
      job: "GET /api/jobs/:jobId"
    }
  });
});


/* =========================================
   VIDEO UPLOAD
========================================= */

app.post(
  "/api/upload",
  (req, res, next) => {
    upload.single("video")(req, res, (err) => {

      if (!err) {
        return next();
      }

      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          ok: false,
          error: "Video file is too large",
          maxSize: "500 MB"
        });
      }

      return res.status(400).json({
        ok: false,
        error: err.message || "Upload failed"
      });
    });
  },

  (req, res) => {

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No video file received"
      });
    }

    const jobId = crypto.randomUUID();

    const job = {
      id: jobId,

      status: "uploaded",

      originalName: req.file.originalname,

      storedName: req.file.filename,

      filePath: req.file.path,

      mimeType: req.file.mimetype,

      size: req.file.size,

      createdAt: new Date().toISOString()
    };

    jobs.set(jobId, job);

    console.log("");
    console.log("==========================================");
    console.log("VIDEO UPLOAD");
    console.log("==========================================");
    console.log(`JOB ID: ${jobId}`);
    console.log(`FILE: ${req.file.originalname}`);
    console.log(`SIZE: ${req.file.size} bytes`);
    console.log(`TYPE: ${req.file.mimetype}`);
    console.log("STATUS: UPLOADED");
    console.log("==========================================");
    console.log("");

    return res.status(201).json({
      ok: true,

      message: "Video uploaded successfully",

      job: {
        id: job.id,
        status: job.status,
        originalName: job.originalName,
        mimeType: job.mimeType,
        size: job.size,
        createdAt: job.createdAt
      }
    });
  }
);


/* =========================================
   JOB STATUS
========================================= */

app.get("/api/jobs/:jobId", (req, res) => {

  const { jobId } = req.params;

  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "Job not found",
      jobId
    });
  }

  return res.status(200).json({
    ok: true,

    job: {
      id: job.id,
      status: job.status,
      originalName: job.originalName,
      mimeType: job.mimeType,
      size: job.size,
      createdAt: job.createdAt
    }
  });
});


/* =========================================
   ERROR HANDLER
========================================= */

app.use((err, req, res, next) => {

  console.error("SERVER ERROR:", err);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({
    ok: false,
    error: "Internal server error"
  });
});


/* =========================================
   404
========================================= */

app.use((req, res) => {

  res.status(404).json({
    ok: false,
    error: "Route not found",
    path: req.path
  });
});


/* =========================================
   START SERVER
========================================= */

app.listen(PORT, "0.0.0.0", () => {

  console.log("");
  console.log("==========================================");
  console.log("       AUNG RECAP PRO V8.0.1");
  console.log("==========================================");
  console.log(`PORT: ${PORT}`);
  console.log(`NODE: ${process.version}`);
  console.log("UPLOAD: READY");
  console.log("MAX VIDEO: 500 MB");
  console.log("STATUS: ONLINE");
  console.log("==========================================");
  console.log("");
});
