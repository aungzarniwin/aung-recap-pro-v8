import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { GoogleGenAI } from "@google/genai";

const app = express();

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const MAX_VIDEO_SIZE = 500 * 1024 * 1024;

/*
|--------------------------------------------------------------------------
| RATE LIMIT PROTECTION
|--------------------------------------------------------------------------
*/

const MAX_AI_RETRIES = 2;
const MIN_AI_REQUEST_INTERVAL = 12000;

let lastAIRequestAt = 0;
let aiRequestLock = false;

/*
|--------------------------------------------------------------------------
| DIRECTORIES
|--------------------------------------------------------------------------
*/

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOAD_DIR, {
  recursive: true
});

/*
|--------------------------------------------------------------------------
| MIDDLEWARE
|--------------------------------------------------------------------------
*/

app.use(
  cors({
    origin: "*",
    methods: [
      "GET",
      "POST",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

/*
|--------------------------------------------------------------------------
| MULTER
|--------------------------------------------------------------------------
*/

const upload = multer({
  dest: UPLOAD_DIR,

  limits: {
    fileSize: MAX_VIDEO_SIZE
  },

  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska",
      "video/avi",
      "video/mpeg"
    ];

    if (
      allowedTypes.includes(
        file.mimetype
      )
    ) {
      cb(null, true);
      return;
    }

    cb(
      new Error(
        `Unsupported video format: ${
          file.mimetype || "unknown"
        }`
      )
    );
  }
});

/*
|--------------------------------------------------------------------------
| JOB STORAGE
|--------------------------------------------------------------------------
*/

const jobs = new Map();

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function now() {
  return new Date().toISOString();
}

function createJobId() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function safeText(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);

  if (!job) {
    return null;
  }

  Object.assign(job, patch, {
    updatedAt: now()
  });

  jobs.set(jobId, job);

  return job;
}

function failJob(jobId, error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error || "Unknown error");

  updateJob(jobId, {
    status: "failed",
    progress: 100,
    message: "AI analysis failed",
    error: message
  });

  console.error(
    `[JOB ${jobId}] FAILED`
  );

  console.error(message);
}

function getGeminiClient() {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not configured on Render"
    );
  }

  return new GoogleGenAI({
    apiKey: GEMINI_API_KEY
  });
}

/*
|--------------------------------------------------------------------------
| ERROR PARSING
|--------------------------------------------------------------------------
*/

function getErrorMessage(error) {
  if (!error) {
    return "";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error.message) {
    return String(error.message);
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isRateLimitError(error) {
  const message =
    getErrorMessage(error).toLowerCase();

  return (
    message.includes("429") ||
    message.includes(
      "rate limit exceeded"
    ) ||
    message.includes(
      "rate_limit_exceeded"
    ) ||
    message.includes(
      "resource_exhausted"
    ) ||
    message.includes(
      "too many requests"
    )
  );
}

function extractRetrySeconds(error) {
  const message =
    getErrorMessage(error);

  /*
   * Examples:
   * retry in 59s
   * retry in 60 seconds
   * retry after 59s
   */

  const patterns = [
    /retry\s+(?:in|after)\s+(\d+)\s*s/i,
    /retry\s+(?:in|after)\s+(\d+)\s*seconds?/i,
    /retryDelay["']?\s*:\s*["']?(\d+)s/i
  ];

  for (const pattern of patterns) {
    const match =
      message.match(pattern);

    if (match) {
      const seconds =
        Number(match[1]);

      if (
        Number.isFinite(seconds) &&
        seconds > 0
      ) {
        return Math.min(
          Math.max(seconds, 5),
          120
        );
      }
    }
  }

  return 60;
}

/*
|--------------------------------------------------------------------------
| GLOBAL AI REQUEST SPACING
|--------------------------------------------------------------------------
*/

async function waitForAIRequestSlot(
  jobId
) {
  const currentTime =
    Date.now();

  const elapsed =
    currentTime - lastAIRequestAt;

  if (
    elapsed <
    MIN_AI_REQUEST_INTERVAL
  ) {
    const waitTime =
      MIN_AI_REQUEST_INTERVAL -
      elapsed;

    const waitSeconds =
      Math.ceil(waitTime / 1000);

    updateJob(jobId, {
      status: "waiting",
      progress: 55,
      message:
        `AI request protection active. Waiting ${waitSeconds}s...`
    });

    await sleep(waitTime);
  }

  lastAIRequestAt = Date.now();
}

/*
|--------------------------------------------------------------------------
| AI REQUEST WITH 429 PROTECTION
|--------------------------------------------------------------------------
*/

async function runGeminiInteraction(
  ai,
  jobId,
  input
) {
  if (aiRequestLock) {
    updateJob(jobId, {
      status: "waiting",
      progress: 55,
      message:
        "Another AI analysis is running. Waiting..."
    });

    while (aiRequestLock) {
      await sleep(3000);
    }
  }

  aiRequestLock = true;

  try {
    let attempt = 0;

    while (
      attempt <= MAX_AI_RETRIES
    ) {
      try {
        await waitForAIRequestSlot(
          jobId
        );

        updateJob(jobId, {
          status: "analyzing",
          progress:
            attempt === 0
              ? 60
              : 60 + attempt * 5,
          message:
            attempt === 0
              ? "AI is analyzing the video..."
              : `Retrying AI analysis... attempt ${attempt + 1}`
        });

        console.log(
          `[JOB ${jobId}] Gemini request attempt ${
            attempt + 1
          }`
        );

        const interaction =
          await ai.interactions.create(
            {
              model: GEMINI_MODEL,
              input
            }
          );

        return interaction;
      } catch (error) {
        const rateLimited =
          isRateLimitError(error);

        if (
          !rateLimited ||
          attempt >= MAX_AI_RETRIES
        ) {
          throw error;
        }

        const retrySeconds =
          extractRetrySeconds(
            error
          );

        console.warn(
          `[JOB ${jobId}] Gemini 429. Waiting ${retrySeconds}s before retry`
        );

        for (
          let remaining =
            retrySeconds;
          remaining > 0;
          remaining--
        ) {
          updateJob(jobId, {
            status: "waiting",
            progress: 58,
            message:
              `Gemini rate limit reached. Retrying in ${remaining}s...`
          });

          await sleep(1000);
        }

        attempt++;
      }
    }

    throw new Error(
      "Gemini analysis retry limit reached"
    );
  } finally {
    aiRequestLock = false;
  }
}

/*
|--------------------------------------------------------------------------
| GEMINI FILE PROCESSING
|--------------------------------------------------------------------------
*/

async function waitForGeminiFile(
  ai,
  fileName,
  jobId
) {
  let geminiFile =
    await ai.files.get({
      name: fileName
    });

  let attempts = 0;

  const maxAttempts = 180;

  while (
    geminiFile &&
    String(
      geminiFile.state || ""
    ).toUpperCase() ===
      "PROCESSING"
  ) {
    attempts++;

    const progress =
      Math.min(
        45,
        20 +
          Math.round(
            (attempts /
              maxAttempts) *
              25
          )
      );

    updateJob(jobId, {
      status: "processing",
      progress,
      message:
        "Gemini is processing the uploaded video..."
    });

    await sleep(3000);

    geminiFile =
      await ai.files.get({
        name: fileName
      });

    if (
      attempts >= maxAttempts
    ) {
      throw new Error(
        "Gemini video processing timed out"
      );
    }
  }

  const state =
    String(
      geminiFile?.state || ""
    ).toUpperCase();

  if (state === "FAILED") {
    throw new Error(
      "Gemini failed to process the uploaded video"
    );
  }

  if (
    state &&
    state !== "ACTIVE"
  ) {
    throw new Error(
      `Unexpected Gemini file state: ${state}`
    );
  }

  return geminiFile;
}

/*
|--------------------------------------------------------------------------
| JSON CLEANING
|--------------------------------------------------------------------------
*/

function cleanJsonText(text) {
  let value = safeText(text);

  value =
    value.replace(
      /```json/gi,
      ""
    );

  value =
    value.replace(
      /```/g,
      ""
    );

  const firstBrace =
    value.indexOf("{");

  const lastBrace =
    value.lastIndexOf("}");

  if (
    firstBrace !== -1 &&
    lastBrace !== -1
  ) {
    value =
      value.slice(
        firstBrace,
        lastBrace + 1
      );
  }

  return value.trim();
}

/*
|--------------------------------------------------------------------------
| NORMALIZE ANALYSIS
|--------------------------------------------------------------------------
*/

function normalizeAnalysis(
  rawText
) {
  const fallback = {
    title: "Myanmar AI Recap",

    storyType:
      "Movie / Video",

    synopsis:
      rawText || "",

    characters: [],

    keyEvents: [],

    scenes: []
  };

  if (!rawText) {
    return fallback;
  }

  try {
    const parsed =
      JSON.parse(
        cleanJsonText(
          rawText
        )
      );

    return {
      title:
        typeof parsed.title ===
        "string"
          ? parsed.title
          : fallback.title,

      storyType:
        typeof parsed.storyType ===
        "string"
          ? parsed.storyType
          : fallback.storyType,

      synopsis:
        typeof parsed.synopsis ===
        "string"
          ? parsed.synopsis
          : fallback.synopsis,

      characters:
        Array.isArray(
          parsed.characters
        )
          ? parsed.characters
          : [],

      keyEvents:
        Array.isArray(
          parsed.keyEvents
        )
          ? parsed.keyEvents
          : [],

      scenes:
        Array.isArray(
          parsed.scenes
        )
          ? parsed.scenes
          : []
    };
  } catch {
    return fallback;
  }
}

/*
|--------------------------------------------------------------------------
| VIDEO ANALYSIS
|--------------------------------------------------------------------------
*/

async function analyzeVideo(
  job
) {
  const ai =
    getGeminiClient();

  try {
    updateJob(job.id, {
      status: "analyzing",
      progress: 10,
      message:
        "Uploading video to Gemini..."
    });

    console.log(
      `[JOB ${job.id}] Uploading ${job.originalName}`
    );

    const uploadedFile =
      await ai.files.upload({
        file: job.filePath,
        config: {
          mimeType:
            job.mimeType
        }
      });

    if (
      !uploadedFile?.name
    ) {
      throw new Error(
        "Gemini upload completed but no file name was returned"
      );
    }

    updateJob(job.id, {
      progress: 20,
      message:
        "Video uploaded. Waiting for Gemini processing...",
      geminiFileName:
        uploadedFile.name,
      geminiFileUri:
        uploadedFile.uri ||
        null
    });

    console.log(
      `[JOB ${job.id}] Gemini file: ${uploadedFile.name}`
    );

    const readyFile =
      await waitForGeminiFile(
        ai,
        uploadedFile.name,
        job.id
      );

    updateJob(job.id, {
      status: "analyzing",
      progress: 50,
      message:
        "AI is preparing video understanding..."
    });

    const prompt = `
You are the AI analysis engine for AUNG RECAP PRO.

Analyze the uploaded video carefully.

The final goal is to create a Myanmar-language movie or video recap.

Return ONLY valid JSON.

Required structure:

{
  "title": "short title",
  "storyType": "type of story/video",
  "synopsis": "detailed Myanmar-language synopsis",
  "characters": [
    {
      "name": "character name",
      "role": "role",
      "description": "short description in Myanmar"
    }
  ],
  "keyEvents": [
    {
      "order": 1,
      "event": "important event in Myanmar",
      "importance": "high"
    }
  ],
  "scenes": [
    {
      "order": 1,
      "description": "scene description in Myanmar",
      "importance": "high"
    }
  ]
}

Rules:

1. Understand the actual visual content
2. Identify the main story
3. Identify important characters when possible
4. Identify major events chronologically
5. Identify meaningful scene changes
6. Never invent unsupported characters or events
7. Write natural Myanmar language
8. Make the synopsis detailed enough for a future 5-10 minute recap
9. Return JSON only
`;

    const interaction =
      await runGeminiInteraction(
        ai,
        job.id,
        [
          {
            type: "video",
            uri: readyFile.uri,
            mime_type:
              readyFile.mimeType
          },
          {
            type: "text",
            text: prompt
          }
        ]
      );

    const outputText =
      safeText(
        interaction?.output_text
      );

    if (!outputText) {
      throw new Error(
        "Gemini returned an empty analysis response"
      );
    }

    updateJob(job.id, {
      progress: 90,
      message:
        "Analysis completed. Preparing results..."
    });

    const analysis =
      normalizeAnalysis(
        outputText
      );

    const result = {
      provider:
        "Google Gemini",

      model:
        GEMINI_MODEL,

      video: {
        originalName:
          job.originalName,

        mimeType:
          job.mimeType,

        size:
          job.size
      },

      analysis,

      rawText:
        outputText
    };

    updateJob(job.id, {
      status: "completed",
      progress: 100,
      message:
        "AI analysis completed successfully",
      result,
      error: null
    });

    console.log(
      `[JOB ${job.id}] Analysis completed`
    );

    return result;
  } catch (error) {
    const rateLimited =
      isRateLimitError(error);

    if (rateLimited) {
      failJob(
        job.id,
        new Error(
          "Gemini rate limit is still active after automatic retries. Please wait about 60 seconds and upload/analyze again."
        )
      );

      return null;
    }

    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| ROOT
|--------------------------------------------------------------------------
*/

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      app: "AUNG RECAP PRO",
      version: "8.1.2",
      status: "online",
      message:
        "AUNG RECAP PRO V8 API is running"
    });
  }
);

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      app:
        "AUNG RECAP PRO",

      version:
        "8.1.2",

      status:
        "healthy",

      node:
        process.version,

      geminiConfigured:
        Boolean(
          GEMINI_API_KEY
        ),

      model:
        GEMINI_MODEL,

      rateLimitProtection:
        true,

      maxAIRetries:
        MAX_AI_RETRIES,

      timestamp:
        now()
    });
  }
);

/*
|--------------------------------------------------------------------------
| API INFO
|--------------------------------------------------------------------------
*/

app.get(
  "/api",
  (req, res) => {
    res.json({
      ok: true,

      app:
        "AUNG RECAP PRO",

      version:
        "8.1.2",

      protection: {
        rateLimit:
          true,

        automaticRetry:
          true,

        duplicateProtection:
          true
      },

      endpoints: {
        health:
          "GET /health",

        upload:
          "POST /api/upload",

        job:
          "GET /api/jobs/:jobId",

        analyze:
          "POST /api/analyze/:jobId/start"
      }
    });
  }
);

/*
|--------------------------------------------------------------------------
| UPLOAD
|--------------------------------------------------------------------------
*/

app.post(
  "/api/upload",
  upload.single("video"),
  (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "No video file received"
          });
      }

      const jobId =
        createJobId();

      const job = {
        id:
          jobId,

        status:
          "uploaded",

        progress:
          5,

        message:
          "Video uploaded successfully",

        originalName:
          req.file.originalname,

        fileName:
          req.file.filename,

        filePath:
          req.file.path,

        mimeType:
          req.file.mimetype,

        size:
          req.file.size,

        createdAt:
          now(),

        updatedAt:
          now(),

        result:
          null,

        error:
          null
      };

      jobs.set(
        jobId,
        job
      );

      console.log(
        `[UPLOAD ${jobId}] ${req.file.originalname}`
      );

      return res.json({
        ok: true,

        jobId,

        status:
          job.status,

        progress:
          job.progress,

        file: {
          name:
            job.originalName,

          mimeType:
            job.mimeType,

          size:
            job.size
        }
      });
    } catch (error) {
      console.error(
        "Upload error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            getErrorMessage(
              error
            ) ||
            "Upload failed"
        });
    }
  }
);

/*
|--------------------------------------------------------------------------
| JOB STATUS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/jobs/:jobId",
  (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "Job not found"
        });
    }

    return res.json({
      ok: true,

      job: {
        id:
          job.id,

        status:
          job.status,

        progress:
          job.progress,

        message:
          job.message,

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
          job.error,

        result:
          job.result
      }
    });
  }
);

/*
|--------------------------------------------------------------------------
| START ANALYSIS
|--------------------------------------------------------------------------
*/

app.post(
  "/api/analyze/:jobId/start",
  async (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "Job not found"
        });
    }

    /*
     * Duplicate protection
     */

    if (
      job.status ===
        "analyzing" ||
      job.status ===
        "processing" ||
      job.status ===
        "waiting" ||
      job.status ===
        "queued"
    ) {
      return res.json({
        ok: true,

        alreadyRunning:
          true,

        message:
          "Analysis is already running",

        jobId:
          job.id
      });
    }

    /*
     * Completed protection
     */

    if (
      job.status ===
      "completed"
    ) {
      return res.json({
        ok: true,

        alreadyCompleted:
          true,

        message:
          "Analysis already completed",

        jobId:
          job.id,

        result:
          job.result
      });
    }

    /*
     * Reset failed job
     */

    updateJob(job.id, {
      status:
        "queued",

      progress:
        7,

      message:
        "Analysis queued...",

      error:
        null
    });

    res.json({
      ok: true,

      jobId:
        job.id,

      status:
        "queued",

      rateLimitProtection:
        true
    });

    /*
     * Background analysis
     */

    analyzeVideo(job)
      .catch(
        (error) => {
          console.error(
            `[JOB ${job.id}] Analysis error`,
            error
          );

          failJob(
            job.id,
            error
          );
        }
      );
  }
);

/*
|--------------------------------------------------------------------------
| MULTER / GLOBAL ERROR
|--------------------------------------------------------------------------
*/

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "Global error:",
      err
    );

    if (
      err instanceof
        multer.MulterError &&
      err.code ===
        "LIMIT_FILE_SIZE"
    ) {
      return res
        .status(413)
        .json({
          ok: false,
          error:
            "Video is too large. Maximum size is 500 MB."
        });
    }

    return res
      .status(500)
      .json({
        ok: false,
        error:
          getErrorMessage(
            err
          ) ||
          "Internal server error"
      });
  }
);

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "       AUNG RECAP PRO V8.1.2"
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
      "RATE LIMIT PROTECTION: ENABLED"
    );
    console.log(
      `MAX AI RETRIES: ${MAX_AI_RETRIES}`
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
