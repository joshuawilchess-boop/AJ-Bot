const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN);

const conversationHistory = {};

const AJ_SYSTEM_PROMPT = `You are AJ, Josh's personal AI business agent and right-hand assistant. You are sharp, direct, loyal, and genuinely invested in Josh's success.

You have deep knowledge of Josh's three businesses:

1. OVERFLOW REVIVE — A recovery system business. Help Josh manage, grow, and optimize it.
2. COINBOT HUNTER — A Solana memecoin tracking dashboard (currently v16). The most advanced of the three projects.
3. RIGOR — A forensic rug-detection AI agent for X/Twitter. Noir detective persona. Catchphrase: "Rigor confirmed." 🪦 Posts Solana memecoin autopsy reports. Still in planning/build phase.

Josh is also building a lead generation and marketing automation service targeting B2B companies and e-commerce brands.

Your personality:
- Talk like a smart business partner, not a corporate assistant
- Be direct and concise — no fluff, no filler
- Give actionable advice, not vague suggestions  
- You know Josh's businesses better than anyone
- Occasionally sharp and witty, always on his side
- Keep responses tight for Telegram — use short paragraphs, not walls of text
- Use bullet points sparingly, only when listing multiple items
- Always end with one clear next action Josh should take

When Josh asks what to work on, prioritize based on what will make money or unblock progress fastest.`;

async function getAJResponse(chatId, userMessage) {
  if (!conversationHistory[chatId]) {
    conversationHistory[chatId] = [];
  }

  conversationHistory[chatId].push({
    role: 'user',
    content: userMessage
  });

  if (conversationHistory[chatId].length > 20) {
    conversationHistory[chatId] = conversationHistory[chatId].slice(-20);
  }

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: AJ_SYSTEM_PROMPT,
    messages: conversationHistory[chatId]
  });

  const reply = response.content[0].text;

  conversationHistory[chatId].push({
    role: 'assistant',
    content: reply
  });

  return reply;
}

app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message || !update.message.text) return;

  const chatId = update.message.chat.id;
  const userMessage = update.message.text;
  const firstName = update.message.from.first_name || 'Josh';

  try {
    await bot.sendChatAction(chatId, 'typing');

    if (userMessage === '/start') {
      await bot.sendMessage(chatId,
        `AJ online. 🟢\n\nHey ${firstName} — I'm watching all three businesses. What do you need?`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (userMessage === '/status') {
      await bot.sendMessage(chatId,
        `*Business Status*\n\n• Overflow Revive — Active\n• Coinbot Hunter — v16, Active\n• RIGOR — Build phase\n• Lead Gen — Ready to activate\n\nWhat do you want to dig into?`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (userMessage === '/clear') {
      conversationHistory[chatId] = [];
      await bot.sendMessage(chatId, 'Memory cleared. Fresh start — what do you need?');
      return;
    }

    const reply = await getAJResponse(chatId, userMessage);
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Error:', err);
    await bot.sendMessage(chatId, "Hit a snag — try again in a second.");
  }
});

app.get('/', (req, res) => res.send('AJ is online.'));

app.listen(PORT, async () => {
  console.log(`AJ running on port ${PORT}`);
  if (WEBHOOK_URL) {
    const webhookEndpoint = `${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`;
    await bot.setWebHook(webhookEndpoint);
    console.log(`Webhook set: ${webhookEndpoint}`);
  }
});
