/**
 * ONE-TIME MIGRATION SCRIPT
 * Rewrites all existing stories through the new 5-phase narrative architecture.
 * Preserves: doc IDs, userId, createdAt, tags, linkedArticleId in insights.
 * Updates: title, slug, excerpt, content, keyInsight, wordCount, perspective, values.
 *
 * Deploy as a temporary Cloud Function, run once, then remove.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const gauravContext = require("./gaurav-context");

// Lazy-init
let db;
function getDB() {
  if (!db) {
    if (!admin.apps.length) admin.initializeApp();
    db = admin.firestore();
  }
  return db;
}

const VERTEX_PROJECT = "gauravrajwanshiwebsite";
const VERTEX_LOCATION = "us-central1";

async function getModelName() {
  try {
    const rc = admin.remoteConfig();
    const template = await rc.getTemplate();
    const param = template.parameters["gemini_model"];
    if (param && param.defaultValue && param.defaultValue.value) {
      return param.defaultValue.value;
    }
  } catch (_) {}
  return "gemini-2.5-pro";
}

async function getAccessToken() {
  const response = await axios.get(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  return response.data.access_token;
}

/**
 * Rewrite prompt — takes the EXISTING story content and rewrites it
 * through the 5-phase architecture. Much more reliable than trying
 * to regenerate from scratch without the original raw thought.
 */
function buildRewritePrompt(existingStory, linkedInsight) {
  const insightContext = linkedInsight
    ? `\nThe linked insight is: "${linkedInsight.title}" — ${linkedInsight.summary || ""}`
    : "";

  return `REWRITE the following story using the 5-phase narrative architecture. Make it SHORTER, SHARPER, and more compelling.

═══ EXISTING STORY TO REWRITE ═══
Title: ${existingStory.title}
Key Insight: ${existingStory.keyInsight || ""}
Tags: ${(existingStory.tags || []).join(", ")}
${insightContext}

Original content:
${existingStory.content}

═══ YOUR TASK ═══
Rewrite this story following the 5-phase narrative architecture:
1. A RECOGNIZABLE NORMAL — character in their everyday routine, blind spot subtly anchored
2. A COMPLICATION — specific disruption, stakes established
3. THE INTUITIVE WRONG MOVE — the natural reaction the reader would also make
4. THE TURN — reality hits, foundational assumption shatters (this is the HEART)
5. THE CRYSTALLIZATION — new understanding settles with surprising economy

RULES:
- Scale length: 120-600 words (shorter than original — trim aggressively)
- End on The Crystallization and STOP — NO moral, NO summary, NO "looking back..." wrap-up
- Keep the same core concept/lesson but deliver it through narrative, not exposition
- Invent fictional characters and companies (no real names except Gaurav Rajwanshi)
- Third person preferred
- Short paragraphs (1-3 sentences)
- Ground in specific sensory details

GOLD STANDARD (match this caliber):
"Raj was the manager everyone came to, and he was proud of it. Every question that hit the team's channel he answered within minutes — correctly, completely. It felt like leadership. Then he took two weeks off for his father's surgery and left his phone in a drawer. He came back braced for a mess. Instead he found the channel full of his people answering each other, and one decision — on a vendor he'd have rejected outright — that turned out better than his own call would have been. Sitting there, he understood that for two years his speed hadn't been helping his team think. It had been replacing their thinking."

═══ OUTPUT FORMAT ═══
Return ONLY valid JSON (no markdown wrapping, no code blocks):
{
  "title": "New punchy title under 60 characters",
  "slug": "url-friendly-slug",
  "excerpt": "1-2 sentence social media teaser",
  "content": "The rewritten story in markdown — 5-phase architecture",
  "perspective": "protagonist | character | observer",
  "values": ["value1", "value2"],
  "keyInsight": "One memorable sentence takeaway",
  "wordCount": integer
}`;
}

const SYSTEM_PROMPT = `You are a world-class narrative architect and developmental editor.

Your sole task is to transform existing stories into punchy, high-signal, deeply resonant narratives using the 5-phase architecture.

TONE: Authentic, sharp, grounded, emotionally intelligent. Zero corporate jargon, zero clichés.

CRITICAL PROHIBITION:
- NEVER append a "moral of the story" or explainer paragraph
- No summary paragraphs, no reflection paragraphs, no "looking back..." wrap-ups
- End on The Crystallization and STOP

BANNED PHRASES:
- "In today's fast-paced world" or any cliché
- "This wasn't just X; it was Y" — any variation
- Synergy, leverage, paradigm shift, game-changer
- "Let's dive in", "Without further ado", "Here's the thing"
- Motivational poster language
- Preachy or lecturing tone`;

async function rewriteStory(existingStory, linkedInsight, modelName, accessToken) {
  const prompt = buildRewritePrompt(existingStory, linkedInsight);
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${modelName}:generateContent`;

  const response = await axios.post(
    url,
    {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
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
  if (!text) throw new Error("Empty response");

  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");

  return JSON.parse(jsonMatch[0]);
}

// ══════════════════════════════════════════════════════════
// MAIN MIGRATION HANDLER — call via HTTP once, then delete
// ══════════════════════════════════════════════════════════

exports.migrateStories = functions
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onRequest(async (req, res) => {
    const results = { success: [], failed: [], skipped: [] };

    try {
      const modelName = await getModelName();
      const accessToken = await getAccessToken();
      console.log(`Migration starting with model: ${modelName}`);

      // 1. Fetch all articles
      const articlesSnap = await getDB().collection("articles").get();
      const articles = [];
      articlesSnap.forEach((doc) => {
        const data = doc.data();
        if (doc.id === "FNccRRyg3igEVlmQY4lm") return; // skip test doc
        articles.push({ id: doc.id, ...data });
      });
      console.log(`Found ${articles.length} articles to migrate`);

      // 2. Fetch all insights and build lookup by linkedArticleId
      const insightsSnap = await getDB().collection("insights").get();
      const insightByArticle = {};
      insightsSnap.forEach((doc) => {
        const data = doc.data();
        if (data.linkedArticleId) {
          insightByArticle[data.linkedArticleId] = { id: doc.id, ...data };
        }
      });
      console.log(`Found ${Object.keys(insightByArticle).length} linked insights`);

      // 3. Process each article sequentially (avoid rate limits)
      for (const article of articles) {
        try {
          // Skip already-migrated stories (original stories were 800-1000 words)
          if (article.wordCount && article.wordCount < 500) {
            console.log(`  ⏭️ Skipping "${article.title}" (${article.wordCount} words — already migrated)`);
            results.skipped.push({ id: article.id, title: article.title, words: article.wordCount });
            continue;
          }

          console.log(`\n━━━ Rewriting: "${article.title}" (${article.id}) ━━━`);
          const linkedInsight = insightByArticle[article.id] || null;

          const rewritten = await rewriteStory(article, linkedInsight, modelName, accessToken);

          // Validate output
          if (!rewritten.content || !rewritten.title) {
            throw new Error("Missing title or content in rewritten story");
          }

          // Compute word count if missing
          if (!rewritten.wordCount) {
            rewritten.wordCount = rewritten.content.split(/\s+/).length;
          }

          // Update ONLY story fields — preserve userId, createdAt, published, tags (merge)
          const updateData = {
            title: rewritten.title,
            slug: rewritten.slug || article.slug,
            excerpt: rewritten.excerpt || article.excerpt,
            content: rewritten.content,
            perspective: rewritten.perspective || article.perspective,
            values: rewritten.values || article.values,
            keyInsight: rewritten.keyInsight || article.keyInsight,
            wordCount: rewritten.wordCount,
            // Preserve original fields:
            // userId — NOT touched
            // createdAt — NOT touched
            // published — NOT touched
            // tags — preserve original tags
          };

          await getDB().collection("articles").doc(article.id).update(updateData);

          results.success.push({
            id: article.id,
            oldTitle: article.title,
            newTitle: rewritten.title,
            oldWords: article.wordCount,
            newWords: rewritten.wordCount,
            linkedInsightId: linkedInsight?.id || "none",
          });

          console.log(`  ✅ Done: "${rewritten.title}" (${rewritten.wordCount} words, was ${article.wordCount})`);

          // Delay to avoid rate limiting (429 errors)
          await new Promise((r) => setTimeout(r, 4000));
        } catch (err) {
          console.error(`  ❌ Failed: "${article.title}" — ${err.message}`);
          results.failed.push({ id: article.id, title: article.title, error: err.message });
        }
      }

      console.log(`\n══════ MIGRATION COMPLETE ══════`);
      console.log(`Success: ${results.success.length}`);
      console.log(`Failed: ${results.failed.length}`);
      console.log(`Skipped: ${results.skipped.length}`);

      res.status(200).json(results);
    } catch (error) {
      console.error("Migration fatal error:", error);
      res.status(500).json({ error: error.message, partial: results });
    }
  });
