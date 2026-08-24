const express = require('express');
const router = express.Router();
const { oauth2Client } = require('../config/googleAuth');

// We will store the tokens here temporarily in memory for this project
let sessionTokens = null;

// Route: GET /auth/login
router.get('/login', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/meetings.space.readonly'
    ];

    // Generate the Google login URL
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: scopes
    });

    // Automatically redirect the browser to the Google login screen
    res.redirect(authUrl);
});

// Route: GET /auth/google/callback
router.get('/google/callback', async (req, res) => {
    const code = req.query.code;
    
    if (!code) {
        return res.status(400).send('No authorization code returned from Google.');
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        
        // Save the tokens in memory and set them in the client
        sessionTokens = tokens;
        oauth2Client.setCredentials(tokens);
        
        // Redirect back to the React/Next.js frontend
        res.redirect('http://localhost:5173');
    } catch (error) {
        console.error('Error retrieving access token', error);
        res.status(500).send('Authentication failed.');
    }
});

// Route: GET /auth/status
router.get('/status', (req, res) => {
    res.json({ authenticated: sessionTokens !== null });
});

// Export a function to allow other files to access the current tokens
const getTokens = () => sessionTokens;

module.exports = { authRouter: router, getTokens };