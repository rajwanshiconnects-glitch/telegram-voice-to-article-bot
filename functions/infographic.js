// ══════════════════════════════════════════════════════════
// INFOGRAPHIC GENERATOR — Google Vertex AI Imagen
// Uses Imagen 3 via Vertex AI (free with your GCP project)
// Brand: Black + Gold + White (gauravrajwanshi.com)
// ══════════════════════════════════════════════════════════

const axios = require("axios");

const VERTEX_PROJECT = "gauravrajwanshiwebsite";
const VERTEX_LOCATION = "us-central1";

/**
 * Get GCP access token from metadata server (works inside Cloud Functions)
 */
async function getAccessToken() {
  const response = await axios.get(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  return response.data.access_token;
}

/**
 * Builds a concise prompt for Imagen.
 */
function buildInfographicPrompt(insight, story) {
  const actions = (insight.actionItems || [])
    .slice(0, 3)
    .map((a) => `• ${a.substring(0, 60)}`)
    .join("\n");

  const title = (insight.title || "Insight").substring(0, 50);
  const summary = (insight.summary || "").substring(0, 150);
  const quote = (story?.keyInsight || "").substring(0, 120);
  const category = (insight.category || "INSIGHT").toUpperCase();

  return `Premium executive infographic poster with deep black background, gold accents, and white typography. Minimalist luxury design. Top to bottom layout: Gold header text "GAURAV RAJWANSHI" with subtitle "Enterprise Transformation Leader". Gold separator line. Gold category badge "${category}". Large white title "${title}". Gray description text "${summary}". Dark card with gold border containing key actions: ${actions}. Gold quotation marks with italic white quote "${quote}". Footer with "gauravrajwanshi.com". Clean sans-serif typography, sharp readable text, executive knowledge card style.`;
}

/**
 * Generates a branded infographic using Vertex AI Imagen 3.
 */
async function generateInfographic(insight, story) {
  const prompt = buildInfographicPrompt(insight, story);
  console.log("Imagen prompt length:", prompt.length);

  const accessToken = await getAccessToken();

  // Try Imagen 3 Fast first (faster, cheaper), fall back to Imagen 3
  let imageBuffer;
  try {
    imageBuffer = await callImagen(accessToken, prompt, "imagen-3.0-fast-generate-001");
    console.log("Imagen 3 Fast succeeded");
  } catch (err) {
    console.warn("Imagen 3 Fast failed:", err.message, "— trying Imagen 3");
    imageBuffer = await callImagen(accessToken, prompt, "imagen-3.0-generate-001");
    console.log("Imagen 3 succeeded");
  }

  console.log("Infographic generated, size:", imageBuffer.length, "bytes");
  return imageBuffer;
}

/**
 * Calls Vertex AI Imagen API and returns a PNG Buffer.
 */
async function callImagen(accessToken, prompt, model) {
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:predict`;

  const requestBody = {
    instances: [
      {
        prompt: prompt,
      },
    ],
    parameters: {
      sampleCount: 1,
      aspectRatio: "9:16",   // vertical infographic format
      safetySetting: "block_few",
      personGeneration: "dont_allow",
    },
  };

  const response = await axios.post(url, requestBody, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    timeout: 120000,
  });

  const prediction = response.data?.predictions?.[0];
  if (!prediction?.bytesBase64Encoded) {
    const errInfo = JSON.stringify(response.data).substring(0, 500);
    throw new Error(`No image in Imagen response: ${errInfo}`);
  }

  return Buffer.from(prediction.bytesBase64Encoded, "base64");
}

module.exports = { generateInfographic };
