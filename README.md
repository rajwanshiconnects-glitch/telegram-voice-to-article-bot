# Telegram Story Teller Agent

AI-powered writing partner that transforms your Telegram messages into stories, insights, branded infographics, and distributes them across LinkedIn and Telegram.

## What It Does

```
You send a message → Bot generates:
├── 📝 Fictional story (your ghostwriter)
├── 🧠 Technical insight (knowledge base)
├── 🎨 Branded infographic (black + gold)
└── 📤 Distributes to:
    ├── 💼 LinkedIn (auto-post with image)
    ├── 📢 Telegram Channel (your "status")
    └── 💬 Telegram DM (infographic sent back to you)
```

## Tech Stack

- **AI:** Gemini 2.5 Pro via Vertex AI
- **Backend:** Firebase Cloud Functions (Node 20)
- **Database:** Firestore
- **Storage:** Firebase Storage (infographic images)
- **Infographic:** sharp + SVG rendering
- **Distribution:** LinkedIn Posts API v2 + Telegram Bot API

## Setup

### 1. Environment Variables

Set these via Firebase Functions config or environment:

```bash
# Required — already configured
TELEGRAM_BOT_TOKEN=your-telegram-bot-token

# LinkedIn (optional — add when ready)
LINKEDIN_CLIENT_ID=your-linkedin-app-client-id
LINKEDIN_CLIENT_SECRET=your-linkedin-app-client-secret

# Telegram Channel (optional — add when ready)
TELEGRAM_CHANNEL_ID=@your_channel_username
```

### 2. LinkedIn Setup (One-Time)

1. Go to [LinkedIn Developer Portal](https://developer.linkedin.com/)
2. Create an app → Request "Share on LinkedIn" product
3. Add redirect URL: `https://us-central1-gauravrajwanshiwebsite.cloudfunctions.net/linkedinCallback`
4. Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`
5. Visit: `https://us-central1-gauravrajwanshiwebsite.cloudfunctions.net/linkedinAuth`
6. Authorize → Done! Tokens are stored automatically.

### 3. Telegram Channel Setup

1. Create a Telegram Channel (e.g., `@gaurav_insights`)
2. Add your bot as a channel admin with "Post Messages" permission
3. Set `TELEGRAM_CHANNEL_ID=@gaurav_insights`

### 4. Deploy

```bash
cd functions
npm install
firebase deploy --only functions
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message + help |
| `/linkedinStatus` | Check LinkedIn connection status |

## Architecture

```
functions/
├── index.js           # Main webhook + LinkedIn OAuth endpoints
├── gaurav-context.js   # Professional context for story generation
├── infographic.js      # SVG → PNG infographic generator (sharp)
├── linkedin.js         # LinkedIn OAuth 2.0 + posting
├── distributor.js      # Multi-channel distribution orchestrator
└── package.json
```
