import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { GoogleGenAI } from "@google/genai";

const app = express();

const PORT = Number(process.env.PORT) || 10000;
const VERSION = "8.1.0";

const MAX_FILE_SIZE = 500 * 1024 * 1024;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

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

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    })
  : null;

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
    const extension =
      path.extname(file.originalname) || ".mp4";

    const filename =
      `${crypto.randomUUID()}${extension}`;

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

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function safeText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function extractJson(text) {
  const clean = safeText(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {}

  const firstObject = clean.indexOf("{");
  const lastObject = clean.lastIndexOf("}");

  if (
    firstObject !== -1 &&
    lastObject !== -1 &&
    lastObject > firstObject
  ) {
    const possibleJson =
      clean.slice(
        firstObject,
        lastObject + 1
      );

    try {
      return JSON.parse(possibleJson);
    } catch {}
  }

  return null;
}

function normalizeAnalysis(data, fallbackText) {
  const source =
    data && typeof data === "object"
      ? data
      : {};

  const scenes = Array.isArray(source.scenes)
    ? source.scenes
        .slice(0, 100)
        .map((scene, index) => ({
          id:
            scene?.id ??
            index + 1,

          start:
            safeText(scene?.start),

          end:
            safeText(scene?.end),

          title:
            safeText(scene?.title) ||
            `Scene ${index + 1}`,

          description:
            safeText(scene?.description),

          characters:
            Array.isArray(scene?.characters)
              ? scene.characters
                  .map(safeText)
                  .filter(Boolean)
              : [],

          importance:
            safeText(scene?.importance)
        }))
    : [];

  const characters =
    Array.isArray(source.characters)
      ? source.characters
          .slice(0, 50)
          .map((character) => ({
            name:
              safeText(character?.name),

            description:
              safeText(character?.description),

            role:
              safeText(character?.role)
          }))
          .filter(
            (item) => item.name
          )
      : [];

  const keyEvents =
    Array.isArray(source.keyEvents)
      ? source.keyEvents
          .slice(0, 50)
          .map((event, index) => ({
            id:
              event?.id ??
              index + 1,

            timestamp:
              safeText(event?.timestamp),

            event:
              safeText(event?.event),

            importance:
              safeText(event?.importance)
          }))
          .filter(
            (item) => item.event
          )
      : [];

  return {
    title:
      safeText(source.title) ||
      "Untitled Video",

    genre:
      safeText(source.genre) ||
      "Unknown",

    duration:
      safeText(source.duration),

    storyType:
      safeText(source.storyType) ||
      "Story",

    logline:
      safeText(source.logline),

    synopsis:
      safeText(source.synopsis),

    characters,

    keyEvents,

    scenes,

    locations:
      Array.isArray(source.locations)
        ? source.locations
            .map(safeText)
            .filter(Boolean)
            .slice(0, 50)
        : [],

    themes:
      Array.isArray(source.themes)
        ? source.themes
            .map(safeText)
            .filter(Boolean)
            .slice(0, 30)
        : [],

    audioSummary:
      safeText(source.audioSummary),

    visualStyle:
      safeText(source.visualStyle),

    recapDirection:
      safeText(source.recapDirection),

    rawText:
      safeText(fallbackText)
  };
}

function publicJob(job) {
  return {
    id: job.id,

    status: job.status,

    progress:
      Number(job.progress) || 0,

    stage:
      safeText(job.stage),

    originalName:
      job.originalName,

    mimeType:
      job.mimeType,

    size:
      job.size,

    createdAt:
      job.createdAt,

    updatedAt:
      job.updatedAt,

    error:
      job.error || null,

    analysis:
      job.analysis || null
  };
}

/* =========================================================
   BASIC ROUTES
========================================================= */

app.get("/", (req, res) => {
  return res.status(200).json({
    ok: true,
    app: "AUNG RECAP PRO",
    version: VERSION,
    status: "online"
  });
});

app.get("/health", (req, res) => {
  return res.status(200).json({
    ok: true,
    app: "AUNG RECAP PRO",
    version: VERSION,
    status: "healthy",
    node: process.version,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL,
    timestamp: new Date().toISOString()
  });
});

app.get("/api", (req, res) => {
  return res.status(200).json({
    ok: true,
    app: "AUNG RECAP PRO",
    version: VERSION,
    status: "online",

    endpoints: {
      health: "GET /health",
      api: "GET /api",
      upload: "POST /api/upload",
      analyze: "POST /api/analyze/:jobId",
      job: "GET /api/jobs/:jobId"
    }
  });
});

/* =========================================================
   UPLOAD
========================================================= */

app.post(
  "/api/upload",

  (req, res, next) => {
    upload.single("video")(
      req,
      res,
      (err) => {
        if (!err) {
          return next();
        }

        if (
          err.code ===
          "LIMIT_FILE_SIZE"
        ) {
          return res.status(413).json({
            ok: false,
            error:
              "Video file is too large",
            maxSize: "500 MB"
          });
        }

        return res.status(400).json({
          ok: false,
          error:
            err.message ||
            "Upload failed"
        });
      }
    );
  },

  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error:
          "No video file received"
      });
    }

    const jobId =
      crypto.randomUUID();

    const now =
      new Date().toISOString();

    const job = {
      id: jobId,

      status: "uploaded",

      progress: 10,

      stage:
        "Video uploaded",

      originalName:
        req.file.originalname,

      storedName:
        req.file.filename,

      filePath:
        req.file.path,

      mimeType:
        req.file.mimetype,

      size:
        req.file.size,

      createdAt: now,

      updatedAt: now,

      error: null,

      analysis: null
    };

    jobs.set(
      jobId,
      job
    );

    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "AUNG RECAP PRO V8.1"
    );
    console.log(
      "VIDEO UPLOAD"
    );
    console.log(
      "=========================================="
    );
    console.log(
      `JOB ID: ${jobId}`
    );
    console.log(
      `FILE: ${req.file.originalname}`
    );
    console.log(
      `SIZE: ${req.file.size} bytes`
    );
    console.log(
      `TYPE: ${req.file.mimetype}`
    );
    console.log(
      "STATUS: UPLOADED"
    );
    console.log(
      "=========================================="
    );
    console.log("");

    return res.status(201).json({
      ok: true,

      message:
        "Video uploaded successfully",

      job:
        publicJob(job)
    });
  }
);

/* =========================================================
   START AI ANALYSIS
========================================================= */

app.post(
  "/api/analyze/:jobId",
  async (req, res) => {

    const {
      jobId
    } = req.params;

    const job =
      jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "Job not found",
        jobId
      });
    }

    if (!GEMINI_API_KEY) {
      return res.status(503).json({
        ok: false,
        error:
          "Gemini API is not configured",
        message:
          "Add GEMINI_API_KEY in Render Environment Variables"
      });
    }

    if (
      job.status ===
        "analyzing" ||
      job.status ===
        "processing"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "Analysis is already running",
        job:
          publicJob(job)
      });
    }

    job.status =
      "analyzing";

    job.progress = 15;

    job.stage =
      "Preparing video for AI analysis";

    job.updatedAt =
      new Date().toISOString();

    return res.status(202).json({
      ok: true,

      message:
        "AI video analysis started",

      job:
        publicJob(job)
    });
  }
);

/* =========================================================
   AI WORKER
========================================================= */

async function analyzeVideo(job) {

  if (!ai) {
    throw new Error(
      "Gemini API client is not configured"
    );
  }

  job.status =
    "analyzing";

  job.progress = 20;

  job.stage =
    "Uploading video to Gemini";

  job.updatedAt =
    new Date().toISOString();

  const uploadedFile =
    await ai.files.upload({
      file: job.filePath,

      config: {
        mimeType:
          job.mimeType
      }
    });

  if (!uploadedFile?.name) {
    throw new Error(
      "Gemini video upload did not return a file reference"
    );
  }

  job.progress = 35;

  job.stage =
    "Gemini is processing the video";

  job.updatedAt =
    new Date().toISOString();

  let geminiFile =
    await ai.files.get({
      name:
        uploadedFile.name
    });

  const processingStarted =
    Date.now();

  const maxProcessingTime =
    20 * 60 * 1000;

  while (
    geminiFile &&
    geminiFile.state ===
      "PROCESSING"
  ) {

    if (
      Date.now() -
        processingStarted >
      maxProcessingTime
    ) {
      throw new Error(
        "Gemini video processing timed out"
      );
    }

    await sleep(5000);

    geminiFile =
      await ai.files.get({
        name:
          uploadedFile.name
      });

    job.progress =
      Math.min(
        60,
        job.progress + 2
      );

    job.stage =
      "Gemini is processing the video";

    job.updatedAt =
      new Date().toISOString();
  }

  if (
    geminiFile?.state ===
    "FAILED"
  ) {
    throw new Error(
      "Gemini failed to process the video"
    );
  }

  if (
    geminiFile?.state !==
    "ACTIVE"
  ) {
    throw new Error(
      "Gemini video file did not become ACTIVE"
    );
  }

  job.progress = 65;

  job.stage =
    "AI is understanding the story";

  job.updatedAt =
    new Date().toISOString();

  const prompt = `
You are the video understanding engine for AUNG RECAP PRO.

Analyze the supplied video carefully using both visual and audio information when available.

The purpose is to prepare accurate source material for a later Myanmar movie-recap script.

IMPORTANT:
- Do not invent events
- Do not invent character names
- If a name is unknown, use a descriptive label such as "the young man" or "the woman"
- Keep timestamps approximate when exact timestamps are unavailable
- Separate observed facts from interpretation
- Identify important story events
- Identify major characters
- Identify locations
- Identify the overall story structure
- Mention important visual and audio details
- Do not write the final recap narration yet

Return ONLY valid JSON.

Use exactly this structure:

{
  "title": "",
  "genre": "",
  "duration": "",
  "storyType": "",
  "logline": "",
  "synopsis": "",
  "characters": [
    {
      "name": "",
      "description": "",
      "role": ""
    }
  ],
  "keyEvents": [
    {
      "id": 1,
      "timestamp": "",
      "event": "",
      "importance": ""
    }
  ],
  "scenes": [
    {
      "id": 1,
      "start": "",
      "end": "",
      "title": "",
      "description": "",
      "characters": [],
      "importance": ""
    }
  ],
  "locations": [],
  "themes": [],
  "audioSummary": "",
  "visualStyle": "",
  "recapDirection": ""
}

Analyze the complete video and prioritize story-critical information.
`;

  const interaction =
    await ai.interactions.create({
      model:
        GEMINI_MODEL,

      input: [
        {
          type: "video",

          uri:
            geminiFile.uri,

          mime_type:
            geminiFile.mimeType
        },

        {
          type: "text",

          text:
            prompt
        }
      ]
    });

  job.progress = 90;

  job.stage =
    "Structuring AI analysis";

  job.updatedAt =
    new Date().toISOString();

  const outputText =
    safeText(
      interaction?.output_text
    );

  if (!outputText) {
    throw new Error(
      "Gemini returned an empty analysis"
    );
  }

  const parsed =
    extractJson(
      outputText
    );

  const analysis =
    normalizeAnalysis(
      parsed,
      outputText
    );

  job.analysis =
    analysis;

  job.progress = 100;

  job.status =
    "completed";

  job.stage =
    "AI analysis complete";

  job.updatedAt =
    new Date().toISOString();

  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "AI ANALYSIS COMPLETE"
  );
  console.log(
    `JOB ID: ${job.id}`
  );
  console.log(
    `MODEL: ${GEMINI_MODEL}`
  );
  console.log(
    `SCENES: ${analysis.scenes.length}`
  );
  console.log(
    `CHARACTERS: ${analysis.characters.length}`
  );
  console.log(
    `KEY EVENTS: ${analysis.keyEvents.length}`
  );
  console.log(
    "=========================================="
  );
  console.log("");

  return analysis;
}

/* =========================================================
   JOB STATUS
========================================================= */

app.get(
  "/api/jobs/:jobId",
  (req, res) => {

    const {
      jobId
    } = req.params;

    const job =
      jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "Job not found",
        jobId
      });
    }

    return res.status(200).json({
      ok: true,
      job:
        publicJob(job)
    });
  }
);

/* =========================================================
   START ANALYSIS WORKER FROM JOB
========================================================= */

async function startAnalysisJob(
  job
) {

  try {

    await analyzeVideo(
      job
    );

  } catch (error) {

    console.error(
      "AI ANALYSIS ERROR:",
      error
    );

    job.status =
      "failed";

    job.progress = 0;

    job.stage =
      "AI analysis failed";

    job.error =
      error?.message ||
      "AI analysis failed";

    job.updatedAt =
      new Date().toISOString();

  }
}

/* =========================================================
   ANALYSIS TRIGGER
========================================================= */

app.post(
  "/api/analyze/:jobId/start",
  async (req, res) => {

    const {
      jobId
    } = req.params;

    const job =
      jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "Job not found"
      });
    }

    if (!GEMINI_API_KEY) {
      return res.status(503).json({
        ok: false,
        error:
          "Gemini API is not configured",
        message:
          "Set GEMINI_API_KEY in Render"
      });
    }

    if (
      job.status ===
        "analyzing"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "Analysis already running",
        job:
          publicJob(job)
      });
    }

    if (
      job.status ===
        "completed"
    ) {
      return res.status(200).json({
        ok: true,
        message:
          "Analysis already completed",
        job:
          publicJob(job)
      });
    }

    job.status =
      "analyzing";

    job.progress = 15;

    job.stage =
      "Starting AI analysis";

    job.error = null;

    job.updatedAt =
      new Date().toISOString();

    startAnalysisJob(
      job
    );

    return res.status(202).json({
      ok: true,

      message:
        "AI analysis started",

      job:
        publicJob(job)
    });
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {

    console.error(
      "SERVER ERROR:",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    return res.status(500).json({
      ok: false,
      error:
        err?.message ||
        "Internal server error"
    });
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {

    return res.status(404).json({
      ok: false,
      error:
        "Route not found",
      path:
        req.path
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "       AUNG RECAP PRO V8.1.0"
    );
    console.log(
      "=========================================="
    );
    console.log(
      `PORT: ${PORT}`
    );
    console.log(
      `NODE: ${process.version}`
    );
    console.log(
      `GEMINI: ${
        GEMINI_API_KEY
          ? "CONFIGURED"
          : "NOT CONFIGURED"
      }`
    );
    console.log(
      `MODEL: ${GEMINI_MODEL}`
    );
    console.log(
      "UPLOAD: READY"
    );
    console.log(
      "AI ANALYSIS: READY"
    );
    console.log(
      "MAX VIDEO: 500 MB"
    );
    console.log(
      "STATUS: ONLINE"
    );
    console.log(
      "=========================================="
    );
    console.log("");
  }
);
