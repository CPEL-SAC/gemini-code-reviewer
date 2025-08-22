const { Octokit } = require("@octokit/rest");
const axios = require("axios");
const crypto = require("crypto");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

module.exports = async (req, res) => {
  console.log("--- FUNCTION STARTED ---");
  res.status(202).send("Accepted");

  try {
    console.log("--- TRY BLOCK ENTERED ---");
    console.log("Octokit is pre-initialized.");

    console.log("Validating signature...");
    const signature = req.headers["x-hub-signature-256"];
    const expectedSignature = "sha256=" + crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(JSON.stringify(req.body)).digest("hex");

    if (process.env.NODE_ENV === 'production' && signature !== expectedSignature) {
      console.warn("--- INVALID SIGNATURE ---");
      return;
    }
    console.log("Signature validation passed.");

    console.log("Validating event type...");
    if (req.headers["x-github-event"] !== "pull_request" || !["opened", "synchronize"].includes(req.body.action)) {
      console.log(`--- IGNORING EVENT: ${req.headers["x-github-event"]} with action: ${req.body.action} ---`);
      return;
    }
    console.log("Event type validation passed.");

    const pr = req.body.pull_request;
    const owner = req.body.repository.owner.login;
    const repo = req.body.repository.name;
    console.log(`Processing PR #${pr.number} in ${owner}/${repo}`);

    let compareResponse;
    try {
        console.log("Attempting to call octokit.repos.compareCommits...");
        compareResponse = await octokit.repos.compareCommits({
          owner,
          repo,
          base: pr.base.sha,
          head: pr.head.sha,
        });
        console.log("octokit.repos.compareCommits call was successful.");
    } catch (commitError) {
        console.error("--- ERROR IN compareCommits CALL ---");
        console.error("Failed to compare commits. This is likely a GITHUB_TOKEN permissions issue.");
        console.error("Commit Error Name:", commitError.name);
        console.error("Commit Error Message:", commitError.message);
        console.error("Commit Error Stack:", commitError.stack);
        if (commitError.response) {
            console.error("--- API RESPONSE ERROR DETAILS (from commitError) ---");
            console.error("Response Status:", commitError.response.status);
            console.error("Response Data:", JSON.stringify(commitError.response.data, null, 2));
        }
        console.error("--- END OF compareCommits ERROR ---");
        return;
    }

    const diff = compareResponse.data.files.map(file => file.patch || '').join('\n');

    if (!diff || diff.trim() === "") {
      console.log("--- NO CHANGES TO REVIEW ---");
      return;
    }

    console.log("Calling Gemini API...");
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
    console.log("Review received from Gemini.");

    console.log("Posting comment to GitHub...");
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: reviewComment,
    });

    console.log(`--- SUCCESS: Review comment posted successfully to PR #${pr.number} in ${owner}/${repo}. ---`);

  } catch (error) {
    console.error("--- CATCH BLOCK ERROR (OUTER) ---");
    console.error("An error occurred during webhook processing.");
    console.error("Error Name:", error.name);
    console.error("Error Message:", error.message);
    console.error("Error Stack:", error.stack);
    if (error.response) {
      console.error("--- API RESPONSE ERROR DETAILS (from outer catch) ---");
      console.error("Response Status:", error.response.status);
      console.error("Response Data:", JSON.stringify(error.response.data, null, 2));
    }
    console.error("--- END OF OUTER ERROR LOG ---");
  }
};