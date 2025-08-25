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
      executionId: process.env.VERCEL_EXECUTION_ID || 'local',
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
        errorMessage: error?.message || 'Unknown error',
        errorStack: error?.stack || 'No stack trace',
        errorName: error?.name || 'UnknownError',
      };
      if (error?.response) {
        errorInfo.apiResponse = {
          status: error.response.status,
          statusText: error.response.statusText,
          data: typeof error.response.data === 'string' ? error.response.data.substring(0, 500) : error.response.data,
        };
      }
      log('error', message, { ...errorInfo, ...extra });
    },
  };
};

// Validate required environment variables
const validateEnvironment = (logger) => {
  const required = ['GITHUB_TOKEN', 'WEBHOOK_SECRET', 'GEMINI_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    logger.error('Missing required environment variables', new Error('Environment validation failed'), { missingVars: missing });
    return false;
  }
  
  logger.info('Environment validation passed', { varsPresent: required.length });
  return true;
};

// Validate webhook payload structure
const validatePayload = (req, logger) => {
  logger.info('Starting payload validation');
  
  if (!req.body) {
    logger.error('Request body is missing', new Error('Payload validation failed'));
    return null;
  }
  
  const { pull_request, repository, action } = req.body;
  
  if (!pull_request) {
    logger.error('pull_request object missing from payload', new Error('Payload validation failed'));
    return null;
  }
  
  if (!repository) {
    logger.error('repository object missing from payload', new Error('Payload validation failed'));
    return null;
  }
  
  if (!repository.owner || !repository.owner.login) {
    logger.error('repository.owner.login missing from payload', new Error('Payload validation failed'));
    return null;
  }
  
  if (!repository.name) {
    logger.error('repository.name missing from payload', new Error('Payload validation failed'));
    return null;
  }
  
  if (!pull_request.number) {
    logger.error('pull_request.number missing from payload', new Error('Payload validation failed'));
    return null;
  }
  
  if (!pull_request.base || !pull_request.base.sha) {
    logger.error('pull_request.base.sha missing from payload', new Error('Payload validation failed'));
    return null;
  }
  
  if (!pull_request.head || !pull_request.head.sha) {
    logger.error('pull_request.head.sha missing from payload', new Error('Payload validation failed'));
    return null;
  }
  
  logger.info('Payload validation passed', {
    owner: repository.owner.login,
    repo: repository.name,
    prNumber: pull_request.number,
    action
  });
  
  return {
    owner: repository.owner.login,
    repo: repository.name,
    prNumber: pull_request.number,
    baseSha: pull_request.base.sha,
    headSha: pull_request.head.sha,
    action
  };
};

// Verify webhook signature
const verifySignature = (req, logger) => {
  logger.info('Starting signature verification');
  
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    logger.error('No signature provided in headers', new Error('Signature verification failed'));
    return false;
  }
  
  const payload = JSON.stringify(req.body);
  const expectedSignature = "sha256=" + crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(payload).digest("hex");
  
  const isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  
  if (!isValid) {
    logger.error('Invalid webhook signature', new Error('Signature verification failed'), {
      signatureProvided: !!signature,
      payloadLength: payload.length
    });
    return false;
  }
  
  logger.info('Signature verification passed');
  return true;
};

const baseLogger = createLogger();

module.exports = async (req, res) => {
  const startTime = Date.now();
  baseLogger.info("Function execution started", { method: req.method, userAgent: req.headers['user-agent'] });
  
  let logger = baseLogger;
  let statusCode = 200;
  let responseMessage = "Success";
  
  try {
    // Step 1: Validate environment variables
    if (!validateEnvironment(baseLogger)) {
      statusCode = 500;
      responseMessage = "Server configuration error";
      return res.status(statusCode).json({ error: responseMessage });
    }
    
    // Step 2: Verify webhook signature (always in production, optional in dev)
    if (process.env.NODE_ENV === 'production' || process.env.WEBHOOK_SECRET) {
      if (!verifySignature(req, baseLogger)) {
        statusCode = 401;
        responseMessage = "Unauthorized - Invalid signature";
        return res.status(statusCode).json({ error: responseMessage });
      }
    } else {
      baseLogger.warn("Signature verification skipped - no WEBHOOK_SECRET in development");
    }
    
    // Step 3: Validate event type
    const eventType = req.headers["x-github-event"];
    baseLogger.info("Event received", { eventType, action: req.body?.action });
    
    if (eventType !== "pull_request") {
      statusCode = 200;
      responseMessage = "Event ignored - not a pull request";
      baseLogger.info("Ignoring non-PR event", { eventType });
      return res.status(statusCode).json({ message: responseMessage });
    }
    
    // Step 4: Validate payload structure
    const payload = validatePayload(req, baseLogger);
    if (!payload) {
      statusCode = 400;
      responseMessage = "Bad Request - Invalid payload structure";
      return res.status(statusCode).json({ error: responseMessage });
    }
    
    // Step 5: Check if we should process this action
    if (!["opened", "synchronize"].includes(payload.action)) {
      statusCode = 200;
      responseMessage = "Event ignored - action not relevant";
      baseLogger.info("Ignoring PR action", { action: payload.action });
      return res.status(statusCode).json({ message: responseMessage });
    }
    
    // Create context-specific logger
    logger = createLogger({ 
      repository: `${payload.owner}/${payload.repo}`, 
      pr: payload.prNumber,
      action: payload.action
    });
    
    logger.info("Processing pull request", {
      baseSha: payload.baseSha.substring(0, 8),
      headSha: payload.headSha.substring(0, 8)
    });
    
    // Step 6: Initialize GitHub client
    let octokit;
    try {
      octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
      logger.info("GitHub client initialized successfully");
    } catch (initError) {
      logger.error("Failed to initialize GitHub client", initError);
      statusCode = 500;
      responseMessage = "GitHub client initialization failed";
      return res.status(statusCode).json({ error: responseMessage });
    }
    
    // Step 7: Get diff from GitHub
    logger.info("Fetching diff from GitHub API");
    let diff;
    try {
      const compareUrl = `https://api.github.com/repos/${payload.owner}/${payload.repo}/compare/${payload.baseSha}...${payload.headSha}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 6000); // 6 seconds timeout to leave room for other operations
      
      logger.info("Making GitHub API request", { url: compareUrl });
      
      const githubResponse = await axios.get(compareUrl, {
        headers: {
          'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3.diff',
          'User-Agent': 'gemini-code-reviewer/1.0.0'
        },
        signal: controller.signal,
        timeout: 6000
      });
      
      clearTimeout(timeoutId);
      diff = githubResponse.data;
      
      logger.info("Successfully fetched diff from GitHub", { 
        diffLength: diff.length,
        status: githubResponse.status
      });
      
    } catch (githubError) {
      logger.error("Failed to fetch diff from GitHub", githubError, {
        url: `https://api.github.com/repos/${payload.owner}/${payload.repo}/compare/${payload.baseSha}...${payload.headSha}`,
        isTimeout: githubError.code === 'ECONNABORTED' || githubError.name === 'AbortError'
      });
      statusCode = 502;
      responseMessage = "Failed to fetch changes from GitHub";
      return res.status(statusCode).json({ error: responseMessage });
    }
    
    // Step 8: Validate diff content
    if (!diff || diff.trim() === "") {
      logger.info("No changes found in diff, skipping review");
      statusCode = 200;
      responseMessage = "No changes to review";
      return res.status(statusCode).json({ message: responseMessage });
    }
    
    // Check diff size (limit to prevent huge payloads)
    const MAX_DIFF_SIZE = 100000; // 100KB
    if (diff.length > MAX_DIFF_SIZE) {
      logger.warn("Diff too large, truncating", { originalLength: diff.length, maxSize: MAX_DIFF_SIZE });
      diff = diff.substring(0, MAX_DIFF_SIZE) + "\n\n[Diff truncated due to size limit]";
    }
    
    logger.info("Diff validation passed", { diffLength: diff.length });
    
    // Step 9: Call Gemini API for review
    logger.info("Calling Gemini API for code review");
    let reviewComment;
    try {
      const prTitle = req.body.pull_request.title;
      const prBody = req.body.pull_request.body;

      const prompt = [
        '## GitHub PR Title',
        '',
        `\`${prTitle}\``,
        '',
        '## Description',
        '',
        '```',
        prBody || 'No description provided.',
        '```',
        '',
        '## Diff',
        '',
        '```diff',
        diff,
        '```',
        '',
        '## IMPORTANT Instructions',
        '',
        'Task: Review the diff for substantive issues using provided context and respond with comments if necessary.',
        'Output: Review comments in markdown format. Use fenced code blocks using the relevant language identifier where applicable.',
        'Don\'t annotate code snippets with line numbers. Format and indent code correctly.',
        'Do not use `suggestion` code blocks.',
        'For fixes, use `diff` code blocks, marking changes with `+` or `-`.',
        '',
        '- Do NOT provide general feedback, summaries, explanations of changes, or praises for making good additions.',
        '- Focus solely on offering specific, objective insights based on the given context and refrain from making broad comments about potential impacts on the system or question intentions behind the changes.',
        '- Only comment on actual problems: bugs, security vulnerabilities, logic errors, performance issues, or clear violations of best practices.',
        '- Ignore minor style issues, formatting, or subjective preferences unless they significantly impact readability or maintainability.',
        '',
        'If there are no issues found, you MUST respond with the text `No se encontraron problemas.` in the review section.',
        '',
        '## Example',
        '',
        '### Example changes',
        '',
        '```diff',
        '  function calculateTotal(items) {',
        '+   if (!items || items.length === 0) return 0;',
        '    let total = 0;',
        '    for (let item of items) {',
        '-     total += item.price * item.quantity;',
        '+     total += (item.price || 0) * (item.quantity || 0);',
        '    }',
        '    return total;',
        '  }',
        '```',
        '',
        '### Example response',
        '',
        '🧅 **La Cebolla dice:** Se agregaron validaciones de seguridad a la función calculateTotal.',
        '',
        '**Problemas Encontrados:**',
        '',
        'Línea 5: El código original podría fallar si `item.price` o `item.quantity` son undefined.',
        '```diff',
        '- total += item.price * item.quantity;',
        '+ total += (item.price || 0) * (item.quantity || 0);',
        '```',
        '[MEDIO] - Previene errores de cálculo con valores undefined.',
        '',
        '---',
        '',
        '## Response Format Requirements:',
        '- Always respond in Spanish',
        '- Always start with: "🧅 **La Cebolla dice:**" followed by a brief summary of the changes',
        '- If you find substantive issues, create a "Problemas Encontrados" section with specific line references',
        '- For each real issue, provide clear description, code suggestion using diff blocks, and severity tag: [CRÍTICO], [ALTO], [MEDIO], [BAJO]',
        '- If there are no real issues, respond with: "🧅 **La Cebolla dice:** No se encontraron problemas."',
        '',
        'Be extremely conservative - only flag actual problems that could cause bugs, security issues, or significant maintainability concerns.'
      ].join('\n');
      
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
      
      const geminiResponse = await axios.post(geminiUrl, {
        contents: [{ parts: [{ text: prompt }] }]
      }, {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      logger.info("Gemini API call successful", { 
        status: geminiResponse.status,
        hasResponse: !!geminiResponse.data
      });
      
      // Validate Gemini response structure
      if (!geminiResponse.data || 
          !geminiResponse.data.candidates || 
          !Array.isArray(geminiResponse.data.candidates) ||
          geminiResponse.data.candidates.length === 0 ||
          !geminiResponse.data.candidates[0].content ||
          !geminiResponse.data.candidates[0].content.parts ||
          !Array.isArray(geminiResponse.data.candidates[0].content.parts) ||
          geminiResponse.data.candidates[0].content.parts.length === 0 ||
          !geminiResponse.data.candidates[0].content.parts[0].text) {
        
        logger.error("Invalid Gemini API response structure", new Error('Invalid response'), {
          hasData: !!geminiResponse.data,
          hasCandidates: !!geminiResponse.data?.candidates,
          candidatesLength: geminiResponse.data?.candidates?.length || 0
        });
        
        statusCode = 502;
        responseMessage = "Invalid response from AI service";
        return res.status(statusCode).json({ error: responseMessage });
      }
      
      reviewComment = geminiResponse.data.candidates[0].content.parts[0].text;
      
      if (!reviewComment || reviewComment.trim() === "") {
        logger.warn("Empty review comment received from Gemini");
        reviewComment = "🧅 **La Cebolla dice:** No se encontraron problemas.";
      }
      
      logger.info("Review generated successfully", { reviewLength: reviewComment.length });
      
    } catch (geminiError) {
      logger.error("Failed to get review from Gemini API", geminiError, {
        isTimeout: geminiError.code === 'ECONNABORTED',
        status: geminiError.response?.status,
        statusText: geminiError.response?.statusText
      });
      statusCode = 502;
      responseMessage = "Failed to generate code review";
      return res.status(statusCode).json({ error: responseMessage });
    }
    
    // Step 10: Post comment to GitHub
    logger.info("Posting review comment to GitHub");
    try {
      const comment = await octokit.issues.createComment({
        owner: payload.owner,
        repo: payload.repo,
        issue_number: payload.prNumber,
        body: reviewComment
      });
      
      logger.info("Successfully posted review comment", { 
        commentId: comment.data.id,
        commentUrl: comment.data.html_url
      });
      
      statusCode = 200;
      responseMessage = "Review completed successfully";
      
    } catch (commentError) {
      logger.error("Failed to post comment to GitHub", commentError, {
        status: commentError.response?.status,
        statusText: commentError.response?.statusText
      });
      statusCode = 502;
      responseMessage = "Failed to post review comment";
      return res.status(statusCode).json({ error: responseMessage });
    }
    
  } catch (error) {
    logger.error("Unexpected error in webhook handler", error);
    statusCode = 500;
    responseMessage = "Internal server error";
  } finally {
    const executionTime = Date.now() - startTime;
    logger.info("Function execution completed", {
      statusCode,
      executionTimeMs: executionTime,
      success: statusCode < 400
    });
    
    // Send response if not already sent
    if (!res.headersSent) {
      return res.status(statusCode).json({ 
        message: responseMessage,
        executionTime: `${executionTime}ms`
      });
    }
  }
};