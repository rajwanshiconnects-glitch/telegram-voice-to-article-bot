const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const FormData = require("form-data");
const gauravContext = require("./gaurav-context");
const { generateInfographic } = require("./infographic");

// Lazy-init Firebase Admin and Firestore (avoids deploy-time analysis timeout)
let db;
function getDB() {
  if (!db) {
    if (!admin.apps.length) {
      admin.initializeApp();
    }
    db = admin.firestore();
  }
  return db;
}

function getTelegramApiUrl() {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
}

// ══════════════════════════════════════════════════════════
// VERTEX AI CONFIG
// ══════════════════════════════════════════════════════════

const VERTEX_PROJECT = "gauravrajwanshiwebsite";
const VERTEX_LOCATION = "us-central1";
const DEFAULT_MODEL = "gemini-3.1-pro"; // Fallback if Remote Config not set

// Fetch model name from Firebase Remote Config (change in Firebase console — no redeploy)
let cachedModel = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // Re-check every 5 minutes

async function getModelName() {
  const now = Date.now();
  if (cachedModel && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedModel;
  }
  try {
    const remoteConfig = admin.remoteConfig();
    const template = await remoteConfig.getTemplate();
    const param = template.parameters["gemini_model"];
    if (param && param.defaultValue && param.defaultValue.value) {
      cachedModel = param.defaultValue.value;
      cacheTimestamp = now;
      console.log("Remote Config model:", cachedModel);
      return cachedModel;
    }
  } catch (err) {
    console.warn("Remote Config fetch failed, using default:", err.message);
  }
  cachedModel = DEFAULT_MODEL;
  cacheTimestamp = now;
  return DEFAULT_MODEL;
}

function getVertexUrl(model) {
  return `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
}

// Get access token from GCP metadata server (works inside Cloud Functions, zero deps)
async function getAccessToken() {
  const response = await axios.get(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  return response.data.access_token;
}

// ══════════════════════════════════════════════════════════
// MAIN WEBHOOK HANDLER
// ══════════════════════════════════════════════════════════

exports.telegramBot = functions
  .runWith({
    timeoutSeconds: 300,
    memory: "1GB",
    // No external API keys needed — Gemini + Imagen both use Vertex AI via GCP service account
  })
  .https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(200).send("OK");
    return;
  }

  // IMPORTANT: Respond to Telegram IMMEDIATELY to prevent webhook retries
  // All processing happens after we've already told Telegram "got it"
  const update = req.body;
  const message = update.message;

  if (!message || !message.text) {
    res.status(200).send("OK");
    return;
  }

  const chatId = message.chat.id;
  const userId = message.from.id;
  const userText = message.text.trim();

  // Respond 200 right away — prevents Telegram from retrying the webhook
  res.status(200).send("OK");

  // Skip bot commands like /start
  if (userText === "/start") {
    await sendTelegramMessage(
      chatId,
      "👋 Hey! I'm your personal writing partner.\n\nJust send me any thought, idea, or observation — even just a few words — and I'll:\n\n📝 Turn it into a story-style article\n🧠 Extract the key insight\n🎨 Generate a branded infographic\n📩 Send the infographic right back to you\n\nPowered by Gemini 3.1 Pro via Vertex AI ⚡\n\nTry it now! Send me something like:\n\"Slowification, Simplification, Amplification\""
    );
    return;
  }

  try {
    // Step 1: Acknowledge
    await sendTelegramMessage(chatId, "📝 Got it. Let me think about this...");

    // Step 2: Save raw thought to notebook (memory)
    await saveToNotebook(userText, userId);

    // Step 3: Fetch past context (memory)
    const pastNotes = await getRecentNotes(userId, 15);
    const pastStories = await getRecentStories(userId, 5);

    // Step 4: Generate story + insight with Gemini via Vertex AI
    const modelName = await getModelName();
    await sendTelegramMessage(chatId, `✍️ Crafting your story & insight with ${modelName}...`);
    const result = await generateStoryAndInsight(userText, pastNotes, pastStories, modelName);

    // Step 5: Save article (fictional story) to Firestore
    const articleId = await saveArticle(result.story, userId);

    // Step 6: Save insight (technical concept) to Firestore
    const insightId = await saveInsight(result.insight, userId, articleId);

    // Step 7: Generate branded infographic + send to user
    await sendTelegramMessage(chatId, "🎨 Generating your branded infographic...");
    let infographicUrl = null;
    try {
      const imageBuffer = await generateInfographic(result.insight, result.story);

      // Upload to Firebase Storage → get a permanent shareable URL
      infographicUrl = await uploadToStorage(imageBuffer, `insight-${insightId}.png`);

      // Save URL to insight doc
      await getDB().collection("insights").doc(insightId).update({ infographicUrl });

      // Send the infographic photo directly to the user on Telegram
      await sendTelegramPhoto(chatId, imageBuffer, `🎨 ${result.insight.title}`);
    } catch (imgError) {
      const errDetail = imgError?.response?.data?.error?.message || imgError.message || "Unknown";
      console.error("Infographic error:", errDetail);
      await sendTelegramMessage(chatId, `⚠️ Infographic generation issue: ${errDetail.substring(0, 200)}\n\nBut your story & insight are saved!`);
    }

    // Step 8: Send final summary
    let successMsg =
      `✨ Published!\n\n` +
      `📝 Story: ${result.story.title}\n` +
      `🧠 Insight: ${result.insight.title}\n\n` +
      `💡 ${result.story.keyInsight}\n\n` +
      `🔗 Read Story: https://gauravrajwanshi.com/stories.html#story-${articleId}\n` +
      `🔗 Read Insight: https://gauravrajwanshi.com/insights.html#insight-${insightId}\n`;

    if (infographicUrl) {
      successMsg += `\n🖼️ Infographic: ${infographicUrl}\n(Share this link anywhere — LinkedIn, Twitter, WhatsApp)`;
    }

    successMsg += `\n\n✅ Story ID: ${articleId} | Insight ID: ${insightId}`;
    await sendTelegramMessage(chatId, successMsg, false);

  } catch (error) {
    console.error("Pipeline error:", error.message);
    try {
      await sendTelegramMessage(
        chatId,
        "❌ Error: " + error.message
      );
    } catch (_) { /* ignore send error */ }
  }
});

// ══════════════════════════════════════════════════════════
// FIREBASE STORAGE — upload infographic, get shareable URL
// ══════════════════════════════════════════════════════════

async function uploadToStorage(imageBuffer, filename) {
  if (!admin.apps.length) admin.initializeApp();
  const bucket = admin.storage().bucket();
  const file = bucket.file(`infographics/${filename}`);

  await file.save(imageBuffer, {
    metadata: {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000",
    },
  });

  await file.makePublic();
  return `https://storage.googleapis.com/${bucket.name}/infographics/${filename}`;
}

// ══════════════════════════════════════════════════════════
// TELEGRAM — send photo (multipart)
// ══════════════════════════════════════════════════════════

async function sendTelegramPhoto(chatId, imageBuffer, caption) {
  try {
    const form = new FormData();
    form.append("chat_id", chatId.toString());
    form.append("photo", imageBuffer, {
      filename: "infographic.png",
      contentType: "image/png",
    });
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
    }

    await axios.post(`${getTelegramApiUrl()}/sendPhoto`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
  } catch (error) {
    console.error("Telegram sendPhoto error:", error.message);
  }
}

// ══════════════════════════════════════════════════════════
// MEMORY SYSTEM
// ══════════════════════════════════════════════════════════

async function saveToNotebook(text, userId) {
  try {
    await getDB().collection("notebook").add({
      text: text,
      userId: userId.toString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error("Notebook save error:", error);
  }
}

async function getRecentNotes(userId, limit = 15) {
  try {
    const snapshot = await getDB()
      .collection("notebook")
      .where("userId", "==", userId.toString())
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({
      text: doc.data().text,
      date: doc.data().createdAt?.toDate?.()?.toISOString?.() || "recent",
    }));
  } catch (error) {
    console.error("Notebook fetch error:", error);
    return [];
  }
}

async function getRecentStories(userId, limit = 5) {
  try {
    const snapshot = await getDB()
      .collection("articles")
      .where("userId", "==", userId.toString())
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({
      title: doc.data().title,
      keyInsight: doc.data().keyInsight || "",
      tags: doc.data().tags || [],
    }));
  } catch (error) {
    console.error("Stories fetch error:", error);
    return [];
  }
}

// ══════════════════════════════════════════════════════════
// STORY + INSIGHT GENERATION (Vertex AI — Dynamic Model via Remote Config)
// ══════════════════════════════════════════════════════════

async function generateStoryAndInsight(currentNote, pastNotes, pastStories, modelName) {
  const notebookContext =
    pastNotes.length > 0
      ? pastNotes
          .map((n, i) => `  ${i + 1}. "${n.text}" (${n.date})`)
          .join("\n")
      : "  (This is the first note — no history yet)";

  const storiesContext =
    pastStories.length > 0
      ? pastStories
          .map(
            (s, i) =>
              `  ${i + 1}. "${s.title}" — Insight: ${s.keyInsight || "N/A"} — Tags: ${(s.tags || []).join(", ")}`
          )
          .join("\n")
      : "  (No stories published yet)";

  const systemPrompt = `You are a world-class narrative architect, developmental editor, AND knowledge architect working exclusively for Gaurav Rajwanshi. You produce TWO outputs from every idea:
1. A STORY — punchy, high-signal, deeply resonant narrative
2. A TECHNICAL INSIGHT — the real concept, framework, or model explained clearly

${gauravContext.profile}

${gauravContext.careerStories}

═══ STORY ENGINE: NARRATIVE ARCHITECTURE ═══

OPERATIONAL PARAMETERS:
- LENGTH: Dynamically scale from 120 words up to 1,000 words. The depth, complexity, and weight of the raw input concept dictates the length. Singular thought = brief and laser-focused. Deep concept = unpack the narrative layers completely.
- TONE: Authentic, sharp, grounded, and emotionally intelligent. Zero corporate jargon, zero clichés, zero overly dramatic prose. Deliver wisdom through subtle narrative tension.

REQUIRED STRUCTURAL ARCHITECTURE — every story must explicitly progress through these five distinct narrative phases:

1. A RECOGNIZABLE NORMAL: Establish the character in their ordinary environment or standard operating procedure. Subtly anchor their core flaw or blind spot into their everyday routine without naming it outright.

2. A COMPLICATION: Introduce a specific disruption to their normal routine. Tension enters the frame; stakes are established (professional, personal, or psychological).

3. THE INTUITIVE WRONG MOVE: The character reacts. They make the completely natural move — the exact path the average reader would also take based on common sense or past success.

4. THE TURN: The emotional or operational cost lands. Reality hits back hard, and their foundational assumption completely shatters. This is the heart of the story; all previous beats are purely setup for this moment.

5. THE CRYSTALLIZATION: A brief, highly disciplined beat where the new understanding settles. State the shift with surprising economy, or leave it entirely implicit, trusting the intelligence of the reader.

CRITICAL PROHIBITION:
- NEVER append a "moral of the story," an explainer paragraph, or an explicit "and the lesson is..." conclusion
- The insight must be completely baked into the narrative execution itself
- No summary paragraphs. No reflection paragraphs. No "looking back..." wrap-ups. End on The Crystallization and STOP.

GOLD STANDARD REFERENCE (calibrate ALL output to this level):
"Raj was the manager everyone came to, and he was proud of it. Every question that hit the team's channel he answered within minutes — correctly, completely. It felt like leadership. Then he took two weeks off for his father's surgery and left his phone in a drawer. He came back braced for a mess. Instead he found the channel full of his people answering each other, and one decision — on a vendor he'd have rejected outright — that turned out better than his own call would have been. Sitting there, he understood that for two years his speed hadn't been helping his team think. It had been replacing their thinking."

VOICE & STYLE:
- Third person preferred; first person ("I" as Gaurav) only when it genuinely serves the story
- Short paragraphs (1-3 sentences max)
- Mix short punchy sentences with longer flowing ones
- Concrete and specific — never vague or abstract
- Subtle wit, never forced humor
- Dialogue is welcome but not mandatory — use it only when it earns its place

NAMES AND COMPANIES:
- NEVER use real company names in stories
- ALWAYS invent fictional but realistic-sounding company and character names
- Use diverse names (mix genders, ethnicities, cultures)
- Anchor in real cities: London, Manchester, Dublin, Singapore, Mumbai, Toronto

SENSORY GROUNDING:
- Anchor scenes with SPECIFIC details: the city, time of day, weather, physical objects
- The whiteboard markers drying out, the half-eaten sandwich, the Teams notification pinging
- Make the reader SEE the room before you make them FEEL the shift

═══ INSIGHT ENGINE ═══

YOUR WRITING VOICE FOR INSIGHTS:
- Clear, authoritative, educational tone
- Explain the concept as if teaching a sharp colleague who hasn't encountered it before
- Include the origin/source of the concept (who created it, when, why)
- Practical application — HOW someone would use this in their work
- Structured with clear sections: What it is → Why it matters → How to apply it

═══ UNIVERSAL BANS (both outputs) ═══
- "In today's fast-paced world" or any cliché opener
- "This wasn't just X; it was Y" — BANNED, any variation of "not just...it was/is" is forbidden
- Corporate buzzwords: synergy, leverage, paradigm shift, game-changer
- "Let's dive in", "Without further ado", "Here's the thing"
- Dictionary definitions as openers
- Motivational poster language
- Preachy or lecturing tone
- Any filler paragraph that says nothing`;

  const prompt = `CREATE TWO OUTPUTS from the raw thought below:
1. A STORY (narrative — 120 to 1,000 words, scaled to concept depth)
2. A TECHNICAL INSIGHT (knowledge base entry)

═══ RAW INPUT ═══
"${currentNote}"

═══ RECENT THOUGHTS (context & patterns — do NOT repeat) ═══
${notebookContext}

═══ RECENTLY PUBLISHED STORIES (avoid repeating these angles) ═══
${storiesContext}

═══ OUTPUT 1: STORY ═══

Execute the 5-phase narrative architecture:
1. Recognizable Normal → 2. Complication → 3. Intuitive Wrong Move → 4. The Turn → 5. Crystallization

Rules:
- Scale length dynamically: simple thought = 120-300 words, deep concept = 500-1,000 words
- End on The Crystallization beat and STOP — no moral, no summary, no reflection paragraph
- Invent fictional characters and companies; use diverse names
- Ground in specific sensory details (city, time, weather, objects in the room)
- If Gaurav sends just 2-3 words, YOU must understand the concept and build the full narrative

═══ OUTPUT 2: TECHNICAL INSIGHT ═══

This is the REAL knowledge behind the story. Explain:
- **What is the concept/framework/model?** — Define it clearly. Name its origin (who created it, when, in what context)
- **Why does it matter?** — What problem does it solve? Why should a leader, manager, or team care?
- **How does it work?** — Break down the mechanics. If it has steps, list them. If it has principles, explain each one.
- **How to apply it** — Give 3-5 practical, actionable ways someone could use this in their work starting Monday
- **Common mistakes** — What do people get wrong when applying this concept?
- **Connected concepts** — What other frameworks or ideas does this relate to?

IMPORTANT for insights:
- You CAN reference real people, companies, books, and academic sources
- Be precise and specific — this is a knowledge base, not a blog post
- Include relevant quotes from original authors if applicable
- Length: 500-1000 words
- Use markdown for structure

═══ OUTPUT FORMAT ═══
Return ONLY valid JSON (no markdown wrapping, no code blocks, no explanation):
{
  "story": {
    "title": "Curiosity-sparking title under 60 characters",
    "slug": "url-friendly-slug-with-hyphens",
    "excerpt": "1-2 sentence social media teaser that makes people click",
    "content": "The full story in markdown — must follow the 5-phase architecture",
    "perspective": "protagonist | character | observer",
    "values": ["value1", "value2"],
    "tags": ["tag1", "tag2", "tag3"],
    "wordCount": integer,
    "keyInsight": "The single most important takeaway in one memorable sentence"
  },
  "insight": {
    "title": "Clear, descriptive title for the concept/framework",
    "slug": "url-friendly-slug-with-hyphens",
    "summary": "2-3 sentence summary of the concept",
    "content": "The full technical insight in markdown",
    "category": "leadership | agile | strategy | operations | culture | technology | communication | problem-solving",
    "origin": "Who created this concept and when (e.g., 'Toyota Production System, 1950s' or 'Daniel Kahneman, Thinking Fast and Slow, 2011')",
    "tags": ["tag1", "tag2", "tag3"],
    "wordCount": integer,
    "actionItems": ["Practical action 1", "Practical action 2", "Practical action 3"],
    "relatedConcepts": ["Related concept 1", "Related concept 2"]
  }
}`;

  try {
    const accessToken = await getAccessToken();

    const response = await axios.post(
      getVertexUrl(modelName),
      {
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 16384,
          temperature: 0.8,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 90000,
      }
    );

    let text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log(`${modelName} response length:`, text?.length);

    if (!text) {
      console.error("Full Vertex AI response:", JSON.stringify(response.data));
      throw new Error(`Empty response from ${modelName}`);
    }

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.error("Response (no JSON):", text.substring(0, 1000));
      throw new Error("No JSON found in Gemini response");
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate both outputs exist
    if (!parsed.story || !parsed.insight) {
      throw new Error("Gemini response missing story or insight object");
    }

    if (!parsed.story.wordCount) {
      parsed.story.wordCount = parsed.story.content.split(/\s+/).length;
    }
    if (!parsed.insight.wordCount) {
      parsed.insight.wordCount = parsed.insight.content.split(/\s+/).length;
    }

    return parsed;
  } catch (error) {
    const errMsg = error?.response?.data?.error?.message || error.message || "Unknown Vertex AI error";
    console.error("Vertex AI error:", error?.response?.data || error.message);
    throw new Error("Failed to create story: " + errMsg);
  }
}

// ══════════════════════════════════════════════════════════
// FIRESTORE — SAVE ARTICLE (fictional story)
// ══════════════════════════════════════════════════════════

async function saveArticle(storyData, userId) {
  try {
    const docId = Date.now().toString();

    const firestoreData = {
      title: storyData.title,
      excerpt: storyData.excerpt,
      content: storyData.content,
      slug: storyData.slug,
      perspective: storyData.perspective || "protagonist",
      values: storyData.values || [],
      keyInsight: storyData.keyInsight || "",
      wordCount: storyData.wordCount || 0,
      tags: storyData.tags || [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      userId: userId.toString(),
      published: true,
    };

    await getDB().collection("articles").doc(docId).set(firestoreData);

    return docId;
  } catch (error) {
    console.error("Article save error:", error);
    throw new Error("Failed to save story to database");
  }
}

// ══════════════════════════════════════════════════════════
// FIRESTORE — SAVE INSIGHT (technical concept)
// ══════════════════════════════════════════════════════════

async function saveInsight(insightData, userId, linkedArticleId) {
  try {
    const docId = Date.now().toString() + "-insight";

    const firestoreData = {
      title: insightData.title,
      summary: insightData.summary || "",
      content: insightData.content,
      slug: insightData.slug,
      category: insightData.category || "general",
      origin: insightData.origin || "",
      wordCount: insightData.wordCount || 0,
      tags: insightData.tags || [],
      actionItems: insightData.actionItems || [],
      relatedConcepts: insightData.relatedConcepts || [],
      linkedArticleId: linkedArticleId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      userId: userId.toString(),
      published: true,
    };

    await getDB().collection("insights").doc(docId).set(firestoreData);

    return docId;
  } catch (error) {
    console.error("Insight save error:", error);
    throw new Error("Failed to save insight to database");
  }
}

// ══════════════════════════════════════════════════════════
// TELEGRAM MESSAGING
// ══════════════════════════════════════════════════════════

async function sendTelegramMessage(chatId, text, parseMarkdown = false) {
  try {
    await axios.post(`${getTelegramApiUrl()}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: parseMarkdown ? "Markdown" : "HTML",
    });
  } catch (error) {
    console.error("Telegram send error:", error.message);
  }
}