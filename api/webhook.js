const { Octokit } = require("@octokit/rest");
const axios = require("axios");
const crypto = require("crypto");

// Helper for structured logging
const createLogger = (context = {}) => {
  const log = (level, message, extra = {}) => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
      ...extra,
    };
    // Vercel logs console.log as INFO, console.warn as WARN, and console.error as ERROR
    const levelMap = {
        'info': 'log',
        'warn': 'warn',
        'error': 'error'
    }
    console[levelMap[level] || 'log'](JSON.stringify(logEntry));
  };

  return {
    info: (message, extra) => log('info', message, extra),
    warn: (message, extra) => log('warn', message, extra),
    error: (message, error, extra) => {
      const errorInfo = {
        errorMessage: error.message,
        errorStack: error.stack,
        errorName: error.name,
      };
      if (error.response) {
        errorInfo.apiResponse = {
          status: error.response.status,
          data: error.response.data,
        };
      }
      log('error', message, { ...errorInfo, ...extra });
    },
  };
};

const baseLogger = createLogger();

module.exports = async (req, res) => {
  baseLogger.info("Function execution started.");
  res.status(202).send("Accepted");

  baseLogger.info("Checking environment variables.", { GITHUB_TOKEN_loaded: !!process.env.GITHUB_TOKEN, GITHUB_TOKEN_length: process.env.GITHUB_TOKEN?.length || 0 });

  let logger = baseLogger;

  try {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    logger.info("Octokit initialized successfully.")

    const signature = req.headers["x-hub-signature-256"];
    const expectedSignature = "sha256=" + crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(JSON.stringify(req.body)).digest("hex");

    if (process.env.NODE_ENV === 'production' && signature !== expectedSignature) {
      logger.warn("Invalid signature received.", { receivedSignature: signature });
      return;
    }
    logger.info("Signature validation passed.");

    const eventType = req.headers["x-github-event"];
    const eventAction = req.body.action;

    if (eventType !== "pull_request" || !["opened", "synchronize"].includes(eventAction)) {
      logger.info("Ignoring event.", { eventType, eventAction });
      return;
    }
    logger.info("Event type validation passed.", { eventType, eventAction });

    const pr = req.body.pull_request;
    const owner = req.body.repository.owner.login;
    const repo = req.body.repository.name;
    const prNumber = pr.number;

    // Create a context-specific logger for this PR
    logger = createLogger({ repository: `${owner}/${repo}`, pr: prNumber });
    logger.info("Processing pull request.");

    let compareResponse;
    try {
      logger.info("Comparing commits to get diff.", { base: pr.base.sha, head: pr.head.sha });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("GitHub API call timed out after 9 seconds.")), 9000)
      );

      compareResponse = await Promise.race([
        octokit.repos.compareCommits({
          owner,
          repo,
          base: pr.base.sha,
          head: pr.head.sha,
        }),
        timeoutPromise
      ]);

      logger.info("Successfully compared commits.");
    } catch (commitError) {
      logger.error("Failed to compare commits. This could be a timeout or a GITHUB_TOKEN permissions issue.", commitError);
      return;
    }

    const diff = compareResponse.data.files.map(file => file.patch || '').join('\n');

    if (!diff || diff.trim() === "") {
      logger.info("No changes to review, exiting.");
      return;
    }
    logger.info(`Diff contains ${compareResponse.data.files.length} file(s).`);

    logger.info("Calling Gemini API for code review.");
    const prompt = [
      "Eres un revisor de código experto de Google. Tu misión es analizar el siguiente 'git diff' y proporcionar comentarios constructivos en español.",
      "",
      "Busca posibles errores, código complejo, malas prácticas, o sugerencias de mejora en claridad y eficiencia. No comentes sobre cosas triviales como espacios en blanco.",
      "",
      "Proporciona tu feedback en formato Markdown. Si no encuentras nada que valga la pena mencionar, responde con \"¡Buen trabajo! No tengo sugerencias por ahora.\".",
      "",
      "Aquí está el diff:",
      "```diff",
      diff,
      "```"
    ].join('\n');

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const geminiResponse = await axios.post(geminiUrl, { contents: [{ parts: [{ text: prompt }] }] });

    const reviewComment = geminiResponse.data.candidates[0].content.parts[0].text;
    logger.info("Review received from Gemini API.", { reviewLength: reviewComment.length });

    logger.info("Posting review comment to GitHub.");
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: reviewComment,
    });

    logger.info("Successfully posted review comment to GitHub.");

  } catch (error) {
    // Use the logger that has PR context if available
    logger.error("An unexpected error occurred in the main try block.", error);
  }
};