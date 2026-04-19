const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const gauravContext = require("./gaurav-context");

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
const VERTEX_MODEL = "gemini-2.5-pro";

function getVertexUrl() {
  return `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}:generateContent`;
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
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(200).send("OK");
    return;
  }

  try {
    const update = req.body;
    const message = update.message;

    if (!message || !message.text) {
      res.status(200).send("OK");
      return;
    }

    const chatId = message.chat.id;
    const userId = message.from.id;
    const userText = message.text.trim();

    // Skip bot commands like /start
    if (userText === "/start") {
      await sendTelegramMessage(
        chatId,
        "👋 Hey! I'm your personal writing partner.\n\nJust send me any thought, idea, or observation — even just a few words — and I'll turn it into a story-style article for your website.\n\nPowered by Gemini 3.1 Pro via Vertex AI ⚡\n\nTry it now! Send me something like:\n\"Slowification, Simplification, Amplification\""
      );
      res.status(200).send("OK");
      return;
    }

    // Step 1: Acknowledge
    await sendTelegramMessage(chatId, "📝 Got it. Let me think about this...");

    // Step 2: Save raw thought to notebook (memory)
    await saveToNotebook(userText, userId);

    // Step 3: Fetch past context (memory)
    const pastNotes = await getRecentNotes(userId, 15);
    const pastStories = await getRecentStories(userId, 5);

    // Step 4: Generate story + insight with Gemini via Vertex AI
    await sendTelegramMessage(chatId, "✍️ Crafting your story & insight with Gemini 2.5 Pro...");
    const result = await generateStoryAndInsight(userText, pastNotes, pastStories);

    // Step 5: Save article (fictional story) to Firestore
    const articleId = await saveArticle(result.story, userId);

    // Step 6: Save insight (technical concept) to Firestore
    const insightId = await saveInsight(result.insight, userId, articleId);

    // Step 7: Send result
    const successMsg =
      `✨ Published!\n\n` +
      `📝 Story: ${result.story.title}\n` +
      `🧠 Insight: ${result.insight.title}\n\n` +
      `💡 ${result.story.keyInsight}\n\n` +
      `🔗 View: https://gauravrajwanshi.com/my-stories.html\n\n` +
      `✅ Story ID: ${articleId} | Insight ID: ${insightId}`;
    await sendTelegramMessage(chatId, successMsg, false);

    res.status(200).send("OK");
  } catch (error) {
    console.error("Error:", error);
    if (req.body.message?.chat?.id) {
      await sendTelegramMessage(
        req.body.message.chat.id,
        "❌ Error: " + error.message
      );
    }
    res.status(200).send("OK");
  }
});

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
// GEMINI 2.5 PRO — STORY + INSIGHT GENERATION (Vertex AI)
// ══════════════════════════════════════════════════════════

async function generateStoryAndInsight(currentNote, pastNotes, pastStories) {
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

  const systemPrompt = `You are Gaurav Rajwanshi's personal ghostwriter AND knowledge architect. You produce TWO outputs from every idea:
1. A FICTIONAL STORY (for the articles collection) — narrative, emotional, visual
2. A TECHNICAL INSIGHT (for the insights collection) — the real concept, framework, or model explained clearly

${gauravContext.profile}

${gauravContext.careerStories}

${gauravContext.storytelling}

YOUR WRITING VOICE FOR STORIES (match this exactly):
- First person ("I") — always as Gaurav
- Conversational warmth — like sharing a story over coffee with a smart friend
- Short paragraphs (2-4 sentences max)
- Mix short punchy sentences with longer flowing ones
- Use **bold** sparingly for key insights that anchor the reader
- Concrete and specific — never vague or abstract
- Subtle wit, never forced humor
- Confident but humble — "I've learned" not "you should"

YOUR WRITING VOICE FOR INSIGHTS:
- Clear, authoritative, educational tone
- First person where it adds value, but can be more instructional
- Explain the concept as if teaching a sharp colleague who hasn't encountered it before
- Include the origin/source of the concept (who created it, when, why)
- Practical application — HOW someone would use this in their work
- Structured with clear sections: What it is → Why it matters → How to apply it

BANNED PHRASES AND PATTERNS (never use these in EITHER output):
- "In today's fast-paced world" or any cliché opener
- "This wasn't just X; it was Y" — BANNED pattern, never use this construction
- "It is not just X, it is Y" — BANNED pattern, never use this construction
- "This isn't just X; it's Y" — BANNED pattern, any variation of "not just...it was/is" is forbidden
- Corporate buzzwords: synergy, leverage, paradigm shift
- "Let's dive in", "Without further ado"
- Dictionary definitions as openers
- Motivational poster language
- Preachy or lecturing tone
- Any filler paragraph that says nothing

NAMES AND COMPANIES — CRITICAL RULE (for STORIES only):
- NEVER use real company names in stories
- ALWAYS invent fictional company names that sound realistic
- ALWAYS invent fictional character names
- HOWEVER: Gaurav Rajwanshi is always real. He is the only real person.
- In INSIGHTS: you CAN reference real companies, authors, and sources when explaining where a concept comes from

MAKING STORIES FEEL REAL:
- Always anchor scenes with SPECIFIC details: people's names, the city, the time of day, the month and year, the weather, physical objects in the room
- Mention specific things: the whiteboard markers that were drying out, the half-eaten sandwich on someone's desk, the Teams notification that kept pinging
- Use real UK/global cities: London, Manchester, Dublin, Singapore, Mumbai, Toronto`;

  const prompt = `CREATE TWO OUTPUTS from Gaurav's note below:
1. A FICTIONAL STORY (for the articles collection)
2. A TECHNICAL INSIGHT (for the insights collection)

═══ GAURAV'S CURRENT NOTE ═══
"${currentNote}"

═══ GAURAV'S RECENT THOUGHTS (his notebook — use for context and patterns) ═══
${notebookContext}

═══ RECENTLY PUBLISHED STORIES (avoid repeating these angles) ═══
${storiesContext}

═══ OUTPUT 1: FICTIONAL STORY (articles collection) ═══

**OPENING HOOK (first 3-5 lines — this is DO OR DIE)**
The reader decides in the FIRST 3-5 LINES whether to keep reading. You MUST:
- Start mid-scene with sensory details the reader can SEE and FEEL
- OR open with a statement that creates FOMO
- Follow the PIXAR setup: establish the world then break it

**THE STORY (60-70% of the article)**
- Gaurav is ALWAYS the real character
- Create 2-3 FICTIONAL supporting characters with DIVERSE names (mix genders, ethnicities)
- Use FICTIONAL company names
- Ground it in SPECIFIC realistic details: city, floor number, month, year, time of day, weather, objects
- Include at least ONE moment of tension, failure, or surprise
- Use DIALOGUE — real conversations
- Weave in the core concept naturally through the story

**VALUES & INSIGHT (2-3 paragraphs)**
- Name 1-2 values, state the key insight, end with a challenge
- Length: 800-1500 words

═══ OUTPUT 2: TECHNICAL INSIGHT (insights collection) ═══

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

═══ CRITICAL RULES ═══
- Even if Gaurav sends just 2-3 words, YOU must understand the concept and build BOTH outputs
- Research/know what the words or concepts mean
- The story should SHOW the concept in action; the insight should EXPLAIN the concept directly
- NEVER use the pattern "This wasn't just X; it was Y" or any variation

═══ OUTPUT FORMAT ═══
Return ONLY valid JSON (no markdown wrapping, no code blocks, no explanation):
{
  "story": {
    "title": "Curiosity-sparking title under 60 characters",
    "slug": "url-friendly-slug-with-hyphens",
    "excerpt": "1-2 sentence social media teaser that makes people click",
    "content": "The full fictional story article in markdown",
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
      getVertexUrl(),
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
    console.log("Gemini 2.5 Pro response length:", text?.length);

    if (!text) {
      console.error("Full Vertex AI response:", JSON.stringify(response.data));
      throw new Error("Empty response from Gemini 2.5 Pro");
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