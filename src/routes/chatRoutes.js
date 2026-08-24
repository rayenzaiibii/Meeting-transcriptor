const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const HISTORY_FILE = path.join(process.cwd(), 'chat_history.json');
const TRANSCRIPTS_DIR = path.join(process.cwd(), 'my transcripts');

// Utility to read chat history
const readHistory = () => {
    if (!fs.existsSync(HISTORY_FILE)) {
        return [];
    }
    try {
        const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
};

// Utility to save chat history
const saveHistory = (history) => {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
};

// Utility to read all transcripts
const readAllTranscripts = () => {
    if (!fs.existsSync(TRANSCRIPTS_DIR)) {
        return "";
    }
    const files = fs.readdirSync(TRANSCRIPTS_DIR);
    let allText = "";
    for (const file of files) {
        if (file.endsWith('.txt')) {
            const content = fs.readFileSync(path.join(TRANSCRIPTS_DIR, file), 'utf-8');
            allText += `\n\n--- Transcript: ${file} ---\n${content}`;
        }
    }
    return allText;
};

// GET /api/chat/history
router.get('/history', (req, res) => {
    const history = readHistory();
    res.json({ history });
});

// POST /api/chat/message
router.post('/message', async (req, res) => {
    const { message } = req.body;
    
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'YOUR_API_KEY_HERE') {
            return res.status(500).json({ error: 'Please set your GEMINI_API_KEY in the .env file.' });
        }

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const history = readHistory();
        const transcriptsContext = readAllTranscripts();

        const systemPrompt = `You are a helpful meeting assistant. You have access to the following meeting transcripts. 
Answer the user's questions based ONLY on these transcripts. If the answer is not in the transcripts, say so.
        
${transcriptsContext}`;

        let conversationContext = history.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n\n');
        const fullPrompt = `${conversationContext}\n\nUser: ${message}\n\nAssistant:`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: fullPrompt,
            config: {
                systemInstruction: systemPrompt,
            }
        });

        const reply = response.text;

        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: reply });
        saveHistory(history);

        res.json({ reply, history });
    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: 'Failed to communicate with AI.' });
    }
});

module.exports = router;
