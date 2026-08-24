require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// Import routes
const { authRouter } = require('./routes/authRoutes');
const meetRoutes = require('./routes/meetRoutes');
const chatRoutes = require('./routes/chatRoutes');

// 1. GLOBAL MIDDLEWARE (Must come before routes)
app.use(cors({
    origin: 'http://localhost:5173',
    credentials: true 
}));
app.use(express.json());

// 2. MOUNT ROUTES
app.use('/auth', authRouter);       
app.use('/api/meet', meetRoutes);   
app.use('/api/chat', chatRoutes);

// A simple home route to verify the server is working
app.get('/', (req, res) => {
    res.send('Your Node.js server is successfully running!');
});

// 3. START THE SERVER (Must be at the very bottom)
app.listen(PORT, () => {
    console.log(`Backend API is running on http://localhost:${PORT}`);
});