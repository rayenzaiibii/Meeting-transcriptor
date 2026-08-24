const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { getTokens } = require('./authRoutes');
const { oauth2Client } = require('../config/googleAuth');

// Node.js built-in modules for interacting with files and folders
const fs = require('fs');
const path = require('path');

router.get('/transcript', async (req, res) => {
    // 1. Check if we are authenticated
    const tokens = getTokens();
    if (!tokens) {
        return res.status(401).send('Not authenticated. Please visit http://localhost:5000/auth/login first.');
    }

    // 2. Get the meeting code from the URL (e.g., abc-defg-hij)
    const spaceId = req.query.spaceId;
    if (!spaceId) {
        return res.status(400).send('Please provide a spaceId parameter. Example: /api/meet/transcript?spaceId=abc-defg-hij');
    }

    try {
        // Initialize the Google Meet API client
        const meet = google.meet({ version: 'v2', auth: oauth2Client });
        
        console.log(`Looking for meeting records in space: ${spaceId}`);

        // Step 1: Get the Conference Records for this space using a filter
        const recordsResponse = await meet.conferenceRecords.list({
            filter: `space.meeting_code = "${spaceId}"`
        });

        const records = recordsResponse.data.conferenceRecords;
        if (!records || records.length === 0) {
            return res.status(404).send('No meeting records found for this space.');
        }
        
        const recordName = records[0].name;
        console.log(`Found meeting record: ${recordName}`);

        // Step 2: Get the Transcripts for this specific meeting record
        const transcriptsResponse = await meet.conferenceRecords.transcripts.list({
            parent: recordName
        });

        const transcripts = transcriptsResponse.data.transcripts;
        if (!transcripts || transcripts.length === 0) {
            return res.status(404).send('No transcripts found for this meeting. Was transcription turned on?');
        }

        const transcriptName = transcripts[0].name;
        console.log(`Found transcript document: ${transcriptName}`);

        // Step 3: Get the actual text entries line-by-line
        const entriesResponse = await meet.conferenceRecords.transcripts.entries.list({
            parent: transcriptName,
            pageSize: 100 // Adjust if it's a very long meeting
        });

        const entries = entriesResponse.data.transcriptEntries;
        
        if (!entries || entries.length === 0) {
            return res.status(404).send('Transcript is empty.');
        }

        // --- Translate IDs to Names and Format ---
        const participantCache = {};
        const formattedLines = [];

        for (const entry of entries) {
            let speakerName = 'Unknown Speaker';
            
            if (entry.participant) {
                if (!participantCache[entry.participant]) {
                    try {
                        const participantRes = await meet.conferenceRecords.participants.get({
                            name: entry.participant
                        });
                        const pData = participantRes.data;
                        
                        const displayName = pData.signedinUser?.displayName || pData.anonymousUser?.displayName || 'Unknown';
                        participantCache[entry.participant] = displayName;
                    } catch (err) {
                        console.error('Could not fetch participant name:', err.message);
                        participantCache[entry.participant] = 'Unknown Speaker';
                    }
                }
                speakerName = participantCache[entry.participant];
            }

            const text = entry.text || '';
            formattedLines.push(`[${speakerName}]: ${text}`);
        }

        // Join all the lines together with a line break
        const finalTranscriptText = formattedLines.join('\n');

        // --- Save directly to a local folder ---
        
        // 1. Point to a folder named "my transcripts" in your root directory
        const folderPath = path.join(process.cwd(), 'my transcripts');

        // 2. If the folder doesn't exist yet, have Node create it automatically
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath);
        }

        // 3. Define the exact file name and path
        const fileName = `Meeting_Transcript_${spaceId}.txt`;
        const filePath = path.join(folderPath, fileName);

        // 4. Write the text data into the file 
        fs.writeFileSync(filePath, finalTranscriptText);
        
        // 5. Send a simple JSON success message back to the browser
        res.json({
            success: true,
            message: `Transcript successfully saved to your project folder!`,
            file: fileName,
            location: filePath
        });

    } catch (error) {
        console.error('Error fetching transcript:', error);
        res.status(500).json({ error: 'Failed to retrieve transcript. Ensure the meeting code is correct.' });
    }
});

module.exports = router;