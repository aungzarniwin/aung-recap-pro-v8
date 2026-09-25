"use strict";

/*
=========================================================
 AUNG RECAP PRO V8.1
 BACKEND ENGINE
=========================================================

 FLOW

 POST /api/upload
      ↓
 create job
      ↓
 POST /api/analyze/:jobId/start
      ↓
 upload video to Gemini Files API
      ↓
 wait until Gemini file ACTIVE
      ↓
 Gemini Interactions API
      ↓
 structured recap analysis
      ↓
 GET /api/jobs/:jobId
      ↓
 completed result

=========================================================
*/

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
 * IMPORTANT
 * @google/genai must be >= 2.0.0
 *
 * package.json should contain:
 *
 * "@google/genai": "^2.0.0"
 *
 * or newer
 */
const { GoogleGenAI } = require("@google/genai");


/* ========================================================
   CONFIG
======================================================== */

const APP_NAME = "AUNG RECAP PRO";
const VERSION = "8.1.0";

const PORT =
  Number(process.env.PORT) ||
  10000;

const GEMINI_API_KEY =
  String(
    process.env.GEMINI_API_KEY ||
    ""
  ).trim();

const GEMINI_MODEL =
  String(
    process.env.GEMINI_MODEL ||
    "gemini-3.8-flash"
  ).trim();

const MAX_FILE_SIZE =
  500 * 1024 * 1024;

const JOB_TTL_MS =
  6 * 60 * 60 * 1000;

const FILE_WAIT_INTERVAL_MS =
  3000;

const MAX_FILE_WAIT_MS =
  15 * 60 * 1000;


/* ========================================================
   APP
======================================================== */

const app =
  express();

app.disable("x-powered-by");


/* ========================================================
   CORS
======================================================== */

app.use(
  cors({
    origin: true,
    credentials: false,
    methods: [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);


/* ========================================================
   BODY
======================================================== */

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb"
  })
);


/* ========================================================
   DIRECTORIES
======================================================== */

const DATA_DIR =
  path.join(
    process.cwd(),
    "data"
  );

const UPLOAD_DIR =
  path.join(
    DATA_DIR,
    "uploads"
  );

const OUTPUT_DIR =
  path.join(
    DATA_DIR,
    "outputs"
  );


function ensureDirectory(
  directory
) {
  fs.mkdirSync(
    directory,
    {
      recursive: true
    }
  );
}


ensureDirectory(DATA_DIR);
ensureDirectory(UPLOAD_DIR);
ensureDirectory(OUTPUT_DIR);


/* ========================================================
   MULTER
======================================================== */

const storage =
  multer.diskStorage({

    destination:
      function (
        req,
        file,
        cb
      ) {

        cb(
          null,
          UPLOAD_DIR
        );
      },

    filename:
      function (
        req,
        file,
        cb
      ) {

        const extension =
          path.extname(
            file.originalname ||
            ""
          ).toLowerCase();

        const id =
          crypto
            .randomUUID();

        cb(
          null,
          `${id}${extension || ".mp4"}`
        );
      }
  });


const upload =
  multer({

    storage,

    limits: {
      fileSize:
        MAX_FILE_SIZE
    },

    fileFilter:
      function (
        req,
        file,
        cb
      ) {

        const mime =
          String(
            file.mimetype ||
            ""
          ).toLowerCase();

        if (
          mime.startsWith(
            "video/"
          )
        ) {

          cb(
            null,
            true
          );

          return;
        }

        cb(
          new Error(
            "Only video files are supported"
          )
        );
      }
  });


/* ========================================================
   GEMINI CLIENT
======================================================== */

let gemini = null;

if (
  GEMINI_API_KEY
) {

  gemini =
    new GoogleGenAI({
      apiKey:
        GEMINI_API_KEY
    });

}


/* ========================================================
   JOB STORE
======================================================== */

/*
 * Render free instances are ephemeral.
 * Therefore this is an in-memory job store.
 *
 * For the V8.1 core workflow this is enough.
 *
 * Later V8.2/V9 can move this to:
 * Redis / PostgreSQL / MongoDB / Supabase
 */

const jobs =
  new Map();


/* ========================================================
   JOB HELPERS
======================================================== */

function createJob(
  file
) {

  const id =
    crypto
      .randomUUID();

  const now =
    Date.now();

  const job = {

    id,

    status:
      "uploaded",

    progress:
      0,

    message:
      "Video uploaded",

    createdAt:
      now,

    updatedAt:
      now,

    source: {

      originalName:
        file.originalname,

      filename:
        file.filename,

      path:
        file.path,

      mimeType:
        file.mimetype,

      size:
        file.size
    },

    options: null,

    gemini: {

      fileName:
        null,

      fileUri:
        null,

      mimeType:
        null,

      interactionId:
        null
    },

    analysis:
      null,

    error:
      null
  };

  jobs.set(
    id,
    job
  );

  return job;
}


function getJob(
  id
) {

  return jobs.get(
    String(id)
  );
}


function touchJob(
  job
) {

  if (
    job
  ) {

    job.updatedAt =
      Date.now();
  }
}


/* ========================================================
   SAFE ERROR MESSAGE
======================================================== */

function errorMessage(
  error
) {

  if (
    !error
  ) {

    return "Unknown error";
  }

  if (
    typeof error ===
    "string"
  ) {

    return error;
  }

  if (
    error.message
  ) {

    return String(
      error.message
    );
  }

  try {

    return JSON.stringify(
      error
    );

  } catch {

    return String(
      error
    );
  }
}


/* ========================================================
   RATE LIMIT DETECTION
======================================================== */

function isRateLimitError(
  error
) {

  const message =
    errorMessage(
      error
    ).toLowerCase();

  return (
    message.includes(
      "429"
    ) ||
    message.includes(
      "rate limit"
    ) ||
    message.includes(
      "quota"
    ) ||
    message.includes(
      "resource exhausted"
    ) ||
    message.includes(
      "too many requests"
    )
  );
}


function getRetrySeconds(
  error
) {

  const message =
    errorMessage(
      error
    );

  const patterns = [

    /retry\s+(?:in|after)\s+(\d+)\s*s/i,

    /retry\s+(?:in|after)\s+(\d+)\s*seconds?/i,

    /retryDelay["']?\s*:\s*["']?(\d+)s/i,

    /(\d+)\s*seconds?/i
  ];

  for (
    const pattern
    of patterns
  ) {

    const match =
      message.match(
        pattern
      );

    if (
      match
    ) {

      const seconds =
        Number(
          match[1]
        );

      if (
        Number.isFinite(
          seconds
        ) &&
        seconds > 0
      ) {

        return Math.min(
          Math.max(
            seconds,
            5
          ),
          300
        );
      }
    }
  }

  return 60;
}


/* ========================================================
   HTTP ERROR
======================================================== */

function sendError(
  res,
  status,
  message,
  extra = {}
) {

  return res
    .status(status)
    .json({

      ok:
        false,

      error:
        message,

      ...extra
    });
}


/* ========================================================
   HEALTH
======================================================== */

app.get(
  "/health",
  function (
    req,
    res
  ) {

    res.json({

      ok:
        true,

      app:
        APP_NAME,

      version:
        VERSION,

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

      jobs:
        jobs.size,

      timestamp:
        new Date()
          .toISOString()
    });
  }
);


/* ========================================================
   ROOT
======================================================== */

app.get(
  "/",
  function (
    req,
    res
  ) {

    res.json({

      ok:
        true,

      app:
        APP_NAME,

      version:
        VERSION,

      message:
        "AUNG RECAP PRO API is running",

      endpoints: {

        health:
          "/health",

        upload:
          "POST /api/upload",

        startAnalysis:
          "POST /api/analyze/:jobId/start",

        job:
          "GET /api/jobs/:jobId"
      }
    });
  }
);


/* ========================================================
   UPLOAD
======================================================== */

app.post(
  "/api/upload",
  upload.single(
    "video"
  ),
  function (
    req,
    res
  ) {

    try {

      if (
        !req.file
      ) {

        return sendError(
          res,
          400,
          "No video file received"
        );
      }


      const job =
        createJob(
          req.file
        );


      console.log(
        `[UPLOAD] ${job.id} ${req.file.originalname}`
      );


      return res.json({

        ok:
          true,

        jobId:
          job.id,

        job: {

          id:
            job.id,

          status:
            job.status,

          progress:
            job.progress,

          message:
            job.message
        }
      });

    } catch (
      error
    ) {

      console.error(
        "[UPLOAD ERROR]",
        error
      );

      return sendError(
        res,
        500,
        errorMessage(
          error
        )
      );
    }
  }
);


/* ========================================================
   GEMINI FILE UPLOAD
======================================================== */

async function uploadVideoToGemini(
  job
) {

  if (
    !gemini
  ) {

    throw new Error(
      "GEMINI_API_KEY is not configured on Render"
    );
  }


  if (
    !job ||
    !job.source ||
    !job.source.path
  ) {

    throw new Error(
      "Video file is missing"
    );
  }


  const filePath =
    job.source.path;


  if (
    !fs.existsSync(
      filePath
    )
  ) {

    throw new Error(
      "Uploaded video no longer exists on server"
    );
  }


  job.status =
    "processing";

  job.progress =
    18;

  job.message =
    "Uploading video to Gemini Files API";

  touchJob(
    job
  );


  console.log(
    `[GEMINI FILE] ${job.id}`
  );


  const uploaded =
    await gemini.files.upload({

      file:
        filePath,

      config: {

        mimeType:
          job.source.mimeType ||
          "video/mp4"
      }
    });


  if (
    !uploaded
  ) {

    throw new Error(
      "Gemini file upload returned an empty response"
    );
  }


  job.gemini.fileName =
    uploaded.name ||
    null;

  job.gemini.fileUri =
    uploaded.uri ||
    null;

  job.gemini.mimeType =
    uploaded.mimeType ||
    job.source.mimeType ||
    "video/mp4";


  touchJob(
    job
  );


  if (
    !job.gemini.fileName ||
    !job.gemini.fileUri
  ) {

    throw new Error(
      "Gemini did not return a usable file reference"
    );
  }


  console.log(
    `[GEMINI FILE] Uploaded ${job.gemini.fileUri}`
  );


  return uploaded;
}


/* ========================================================
   WAIT FOR GEMINI FILE ACTIVE
======================================================== */

async function waitForGeminiFile(
  job
) {

  if (
    !gemini
  ) {

    throw new Error(
      "Gemini client is not configured"
    );
  }


  const fileName =
    job.gemini.fileName;


  if (
    !fileName
  ) {

    throw new Error(
      "Gemini file name is missing"
    );
  }


  const startedAt =
    Date.now();


  let file =
    await gemini.files.get({
      name:
        fileName
    });


  while (
    true
  ) {

    const state =
      String(
        file.state ||
        ""
      ).toUpperCase();


    console.log(
      `[GEMINI FILE] ${job.id} state=${state}`
    );


    if (
      state ===
      "ACTIVE"
    ) {

      job.progress =
        38;

      job.message =
        "Video is ready for AI analysis";

      touchJob(
        job
      );

      return file;
    }


    if (
      state ===
      "FAILED"
    ) {

      throw new Error(
        "Gemini video processing failed"
      );
    }


    if (
      Date.now() -
      startedAt >
      MAX_FILE_WAIT_MS
    ) {

      throw new Error(
        "Gemini video processing timed out"
      );
    }


    job.progress =
      Math.min(
        36,
        Number(
          job.progress
        ) + 1
      );

    job.message =
      "Gemini is processing the video";


    touchJob(
      job
    );


    await new Promise(
      function (
        resolve
      ) {

        setTimeout(
          resolve,
          FILE_WAIT_INTERVAL_MS
        );
      }
    );


    file =
      await gemini.files.get({
        name:
          fileName
      });
  }
}


/* ========================================================
   RECAP PROMPT
======================================================== */

function buildRecapPrompt(
  options
) {

  const sourceLanguage =
    options?.sourceLanguage ||
    "auto";

  const outputLanguage =
    options?.outputLanguage ||
    "my";

  const outputFormat =
    options?.outputFormat ||
    "original";

  const recapStyle =
    options?.recapStyle ||
    "cinematic";


  return `
You are the core AI engine of AUNG RECAP PRO.

Your task is to analyze the supplied movie/video carefully and create a structured movie recap package.

IMPORTANT:
- Base the analysis only on what can actually be observed or reasonably understood from the supplied video
- Do not invent characters, scenes, events, dialogue, or plot points
- If something is uncertain, mark it as uncertain
- Keep the chronology accurate
- Identify important scene transitions
- Identify major characters and their roles
- Identify major events and their approximate order
- Create a coherent recap narrative
- The final recap should be suitable for a voice-over video
- Avoid unnecessary repetition

SOURCE LANGUAGE:
${sourceLanguage}

OUTPUT LANGUAGE:
${outputLanguage}

OUTPUT FORMAT:
${outputFormat}

RECAP STYLE:
${recapStyle}

Return ONLY valid JSON.

Use exactly this top-level structure:

{
  "title": "string",
  "logline": "string",
  "genre": "string",
  "durationSeconds": 0,
  "summary": "string",

  "characters": [
    {
      "name": "string",
      "role": "string",
      "description": "string"
    }
  ],

  "events": [
    {
      "order": 1,
      "title": "string",
      "description": "string",
      "importance": "high"
    }
  ],

  "scenes": [
    {
      "order": 1,
      "start": 0,
      "end": 0,
      "title": "string",
      "description": "string",
      "importance": "high"
    }
  ],

  "recapScript": "string",

  "voiceSegments": [
    {
      "order": 1,
      "text": "string"
    }
  ],

  "subtitleSegments": [
    {
      "order": 1,
      "text": "string"
    }
  ],

  "keyMoments": [
    "string"
  ],

  "ending": "string"
}

RECAP SCRIPT REQUIREMENTS:

1. Write a natural narration script
2. Keep the chronology clear
3. Introduce important characters naturally
4. Explain cause and effect
5. Include major turning points
6. Explain the ending if it is present
7. Do not fabricate missing information
8. Do not use screenplay formatting
9. Do not include labels such as "Narrator:"
10. Make the script suitable for Myanmar narration when outputLanguage is "my"

For Myanmar output:
- Use natural modern Burmese
- Use clear spoken-language sentences
- Avoid overly literary wording
- Make it comfortable for AI voice narration
- Keep punctuation suitable for speech
- Do not put "။" at the end of every short UI label
- The recapScript itself may use natural Burmese punctuation where needed

Return JSON only.
`;
}


/* ========================================================
   JSON EXTRACTION
======================================================== */

function extractJson(
  text
) {

  if (
    typeof text !==
    "string"
  ) {

    throw new Error(
      "Gemini returned no text"
    );
  }


  let cleaned =
    text.trim();


  /*
   * Remove markdown code fences
   */

  cleaned =
    cleaned
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();


  /*
   * First attempt:
   * direct JSON
   */

  try {

    return JSON.parse(
      cleaned
    );

  } catch {
    // continue
  }


  /*
   * Second attempt:
   * find first { and last }
   */

  const first =
    cleaned.indexOf(
      "{"
    );

  const last =
    cleaned.lastIndexOf(
      "}"
    );


  if (
    first === -1 ||
    last === -1 ||
    last <= first
  ) {

    throw new Error(
      "Gemini response did not contain valid JSON"
    );
  }


  const candidate =
    cleaned.slice(
      first,
      last + 1
    );


  try {

    return JSON.parse(
      candidate
    );

  } catch (
    error
  ) {

    console.error(
      "[JSON PARSE ERROR]",
      candidate.slice(
        0,
        3000
      )
    );

    throw new Error(
      "Gemini returned malformed JSON"
    );
  }
}


/* ========================================================
   NORMALIZE ANALYSIS
======================================================== */

function normalizeAnalysis(
  data
) {

  const safe =
    data &&
    typeof data ===
      "object"
      ? data
      : {};


  const characters =
    Array.isArray(
      safe.characters
    )
      ? safe.characters
      : [];


  const events =
    Array.isArray(
      safe.events
    )
      ? safe.events
      : [];


  const scenes =
    Array.isArray(
      safe.scenes
    )
      ? safe.scenes
      : [];


  const voiceSegments =
    Array.isArray(
      safe.voiceSegments
    )
      ? safe.voiceSegments
      : [];


  const subtitleSegments =
    Array.isArray(
      safe.subtitleSegments
    )
      ? safe.subtitleSegments
      : [];


  const keyMoments =
    Array.isArray(
      safe.keyMoments
    )
      ? safe.keyMoments
      : [];


  return {

    title:
      String(
        safe.title ||
        ""
      ).trim(),

    logline:
      String(
        safe.logline ||
        ""
      ).trim(),

    genre:
      String(
        safe.genre ||
        ""
      ).trim(),

    durationSeconds:
      Number(
        safe.durationSeconds
      ) || 0,

    summary:
      String(
        safe.summary ||
        ""
      ).trim(),

    characters:
      characters.map(
        function (
          item
        ) {

          return {

            name:
              String(
                item?.name ||
                ""
              ),

            role:
              String(
                item?.role ||
                ""
              ),

            description:
              String(
                item?.description ||
                ""
              )
          };
        }
      ),

    events:
      events.map(
        function (
          item,
          index
        ) {

          return {

            order:
              Number(
                item?.order
              ) ||
              index + 1,

            title:
              String(
                item?.title ||
                ""
              ),

            description:
              String(
                item?.description ||
                ""
              ),

            importance:
              String(
                item?.importance ||
                "medium"
              )
          };
        }
      ),

    scenes:
      scenes.map(
        function (
          item,
          index
        ) {

          return {

            order:
              Number(
                item?.order
              ) ||
              index + 1,

            start:
              Number(
                item?.start
              ) || 0,

            end:
              Number(
                item?.end
              ) || 0,

            title:
              String(
                item?.title ||
                ""
              ),

            description:
              String(
                item?.description ||
                ""
              ),

            importance:
              String(
                item?.importance ||
                "medium"
              )
          };
        }
      ),

    recapScript:
      String(
        safe.recapScript ||
        ""
      ).trim(),

    voiceSegments:
      voiceSegments.map(
        function (
          item,
          index
        ) {

          return {

            order:
              Number(
                item?.order
              ) ||
              index + 1,

            text:
              String(
                item?.text ||
                ""
              ).trim()
          };
        }
      ),

    subtitleSegments:
      subtitleSegments.map(
        function (
          item,
          index
        ) {

          return {

            order:
              Number(
                item?.order
              ) ||
              index + 1,

            text:
              String(
                item?.text ||
                ""
              ).trim()
          };
        }
      ),

    keyMoments:
      keyMoments.map(
        function (
          item
        ) {

          return String(
            item ||
            ""
          ).trim();
        }
      ).filter(
        Boolean
      ),

    ending:
      String(
        safe.ending ||
        ""
      ).trim()
  };
}


/* ========================================================
   GEMINI ANALYSIS
======================================================== */

async function analyzeVideoWithGemini(
  job
) {

  if (
    !gemini
  ) {

    throw new Error(
      "GEMINI_API_KEY is not configured"
    );
  }


  if (
    !job.gemini.fileUri
  ) {

    throw new Error(
      "Gemini video URI is missing"
    );
  }


  job.progress =
    45;

  job.message =
    "Sending video to Gemini AI";

  touchJob(
    job
  );


  const prompt =
    buildRecapPrompt(
      job.options
    );


  console.log(
    `[GEMINI ANALYZE] ${job.id}`
  );


  const interaction =
    await gemini.interactions.create({

      model:
        GEMINI_MODEL,

      input: [

        {
          type:
            "video",

          uri:
            job.gemini.fileUri,

          mime_type:
            job.gemini.mimeType ||
            "video/mp4",

          /*
           * Agentic processing is useful
           * for long videos
           */
          processing:
            "agentic"
        },

        {
          type:
            "text",

          text:
            prompt
        }
      ],

      generation_config: {

        thinking_level:
          "low"
      }
    });


  if (
    !interaction
  ) {

    throw new Error(
      "Gemini returned an empty interaction"
    );
  }


  job.gemini.interactionId =
    interaction.id ||
    null;


  job.progress =
    88;

  job.message =
    "Gemini analysis received";

  touchJob(
    job
  );


  const outputText =
    String(
      interaction.output_text ||
      ""
    ).trim();


  if (
    !outputText
  ) {

    throw new Error(
      "Gemini returned no analysis text"
    );
  }


  console.log(
    `[GEMINI ANALYZE] response length=${outputText.length}`
  );


  const parsed =
    extractJson(
      outputText
    );


  const analysis =
    normalizeAnalysis(
      parsed
    );


  if (
    !analysis.recapScript &&
    !analysis.summary
  ) {

    throw new Error(
      "Gemini analysis did not contain a recap summary or script"
    );
  }


  return analysis;
}


/* ========================================================
   MAIN ANALYSIS JOB
======================================================== */

async function runAnalysis(
  job
) {

  try {

    if (
      !job
    ) {

      throw new Error(
        "Job not found"
      );
    }


    /*
     * HARD LOCK
     *
     * Prevent double analysis requests
     */

    if (
      job.status ===
      "analyzing"
    ) {

      console.log(
        `[ANALYSIS LOCK] ${job.id}`
      );

      return;
    }


    job.status =
      "analyzing";

    job.progress =
      5;

    job.message =
      "Preparing AI analysis";

    job.error =
      null;

    touchJob(
      job
    );


    /*
     * Step 1
     * Gemini file upload
     */

    if (
      !job.gemini.fileUri
    ) {

      await uploadVideoToGemini(
        job
      );

      await waitForGeminiFile(
        job
      );
    }


    /*
     * Step 2
     * AI analysis
     */

    const analysis =
      await analyzeVideoWithGemini(
        job
      );


    /*
     * Step 3
     * Save result
     */

    job.analysis =
      analysis;

    job.status =
      "completed";

    job.progress =
      100;

    job.message =
      "AI analysis complete";

    job.error =
      null;

    touchJob(
      job
    );


    console.log(
      `[ANALYSIS COMPLETE] ${job.id}`
    );


  } catch (
    error
  ) {

    const message =
      errorMessage(
        error
      );


    console.error(
      `[ANALYSIS ERROR] ${job?.id || "unknown"}`,
      error
    );


    if (
      job
    ) {

      job.status =
        "failed";

      job.progress =
        100;

      job.error =
        message;

      job.message =
        isRateLimitError(
          error
        )
          ? "Gemini rate limit reached"
          : "AI analysis failed";

      touchJob(
        job
      );
    }
  }
}


/* ========================================================
   START ANALYSIS
======================================================== */

app.post(
  "/api/analyze/:jobId/start",
  async function (
    req,
    res
  ) {

    const jobId =
      String(
        req.params.jobId ||
        ""
      );


    const job =
      getJob(
        jobId
      );


    if (
      !job
    ) {

      return sendError(
        res,
        404,
        "Job not found"
      );
    }


    if (
      job.status ===
      "analyzing"
    ) {

      return res.json({

        ok:
          true,

        started:
          false,

        alreadyRunning:
          true,

        job
      });
    }


    if (
      job.status ===
      "completed"
    ) {

      return res.json({

        ok:
          true,

        started:
          false,

        alreadyCompleted:
          true,

        job
      });
    }


    if (
      !job.source?.path
    ) {

      return sendError(
        res,
        400,
        "Video file is missing"
      );
    }


    const body =
      req.body &&
      typeof req.body ===
        "object"
        ? req.body
        : {};


    job.options = {

      sourceLanguage:
        String(
          body.sourceLanguage ||
          "auto"
        ),

      outputLanguage:
        String(
          body.outputLanguage ||
          "my"
        ),

      outputFormat:
        String(
          body.outputFormat ||
          "original"
        ),

      recapStyle:
        String(
          body.recapStyle ||
          "cinematic"
        )
    };


    /*
     * Respond immediately
     *
     * Actual Gemini work runs in background
     */

    job.status =
      "analyzing";

    job.progress =
      5;

    job.message =
      "Analysis queued";

    job.error =
      null;

    touchJob(
      job
    );


    void runAnalysis(
      job
    );


    return res.status(
      202
    ).json({

      ok:
        true,

      started:
        true,

      jobId:
        job.id,

      status:
        job.status,

      progress:
        job.progress,

      message:
        job.message
    });
  }
);


/* ========================================================
   GET JOB
======================================================== */

app.get(
  "/api/jobs/:jobId",
  function (
    req,
    res
  ) {

    const jobId =
      String(
        req.params.jobId ||
        ""
      );


    const job =
      getJob(
        jobId
      );


    if (
      !job
    ) {

      return sendError(
        res,
        404,
        "Job not found"
      );
    }


    return res.json({

      ok:
        true,

      job
    });
  }
);


/* ========================================================
   DELETE JOB
======================================================== */

app.delete(
  "/api/jobs/:jobId",
  function (
    req,
    res
  ) {

    const jobId =
      String(
        req.params.jobId ||
        ""
      );


    const job =
      getJob(
        jobId
      );


    if (
      !job
    ) {

      return sendError(
        res,
        404,
        "Job not found"
      );
    }


    try {

      if (
        job.source?.path &&
        fs.existsSync(
          job.source.path
        )
      ) {

        fs.unlinkSync(
          job.source.path
        );
      }

    } catch (
      error
    ) {

      console.warn(
        "[DELETE FILE]",
        errorMessage(
          error
        )
      );
    }


    jobs.delete(
      jobId
    );


    return res.json({

      ok:
        true,

      deleted:
        true,

      jobId
    });
  }
);


/* ========================================================
   ERROR HANDLER
======================================================== */

app.use(
  function (
    error,
    req,
    res,
    next
  ) {

    console.error(
      "[EXPRESS ERROR]",
      error
    );


    if (
      error instanceof
      multer.MulterError
    ) {

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {

        return sendError(
          res,
          413,
          "Video is larger than 500 MB"
        );
      }


      return sendError(
        res,
        400,
        error.message
      );
    }


    const message =
      errorMessage(
        error
      );


    if (
      message
        .toLowerCase()
        .includes(
          "only video"
        )
    ) {

      return sendError(
        res,
        400,
        message
      );
    }


    return sendError(
      res,
      500,
      message
    );
  }
);


/* ========================================================
   404
======================================================== */

app.use(
  function (
    req,
    res
  ) {

    return sendError(
      res,
      404,
      `Route not found: ${req.method} ${req.originalUrl}`
    );
  }
);


/* ========================================================
   CLEANUP
======================================================== */

function cleanupOldJobs() {

  const now =
    Date.now();


  for (
    const [
      id,
      job
    ]
    of jobs.entries()
  ) {

    if (
      now -
      Number(
        job.updatedAt ||
        job.createdAt ||
        now
      ) >
      JOB_TTL_MS
    ) {

      try {

        if (
          job.source?.path &&
          fs.existsSync(
            job.source.path
          )
        ) {

          fs.unlinkSync(
            job.source.path
          );
        }

      } catch (
        error
      ) {

        console.warn(
          `[CLEANUP] ${id}`,
          errorMessage(
            error
          )
        );
      }


      jobs.delete(
        id
      );


      console.log(
        `[CLEANUP] removed job ${id}`
      );
    }
  }
}


setInterval(
  cleanupOldJobs,
  30 * 60 * 1000
);


/* ========================================================
   START SERVER
======================================================== */

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    function () {

      console.log(
        "================================================="
      );

      console.log(
        `${APP_NAME} V${VERSION}`
      );

      console.log(
        `Server listening on port ${PORT}`
      );

      console.log(
        `Node: ${process.version}`
      );

      console.log(
        `Gemini configured: ${Boolean(
          GEMINI_API_KEY
        )}`
      );

      console.log(
        `Gemini model: ${GEMINI_MODEL}`
      );

      console.log(
        "================================================="
      );
    }
  );


/* ========================================================
   GRACEFUL SHUTDOWN
======================================================== */

function shutdown(
  signal
) {

  console.log(
    `${signal} received — shutting down`
  );


  server.close(
    function () {

      console.log(
        "HTTP server closed"
      );

      process.exit(
        0
      );
    }
  );


  setTimeout(
    function () {

      process.exit(
        1
      );

    },
    10000
  );
}


process.on(
  "SIGTERM",
  function () {

    shutdown(
      "SIGTERM"
    );
  }
);


process.on(
  "SIGINT",
  function () {

    shutdown(
      "SIGINT"
    );
  });


/* ========================================================
   UNHANDLED ERRORS
======================================================== */

process.on(
  "unhandledRejection",
  function (
    reason
  ) {

    console.error(
      "[UNHANDLED REJECTION]",
      reason
    );
  }
);


process.on(
  "uncaughtException",
  function (
    error
  ) {

    console.error(
      "[UNCAUGHT EXCEPTION]",
      error
    );
  }
);
