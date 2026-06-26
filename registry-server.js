const express = require('express');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
const PORT = 3001;

app.use(express.json());
app.use(express.static('public'));

const ARTISTS_FILE = path.join(__dirname, 'artists.json');
const LISTENERS_FILE = path.join(__dirname, 'listeners.json');

function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ============ ENDPOINTS ============

// Register Artist
app.post('/api/register-artist', (req, res) => {
    const { artist, wallet } = req.body;
    if (!artist || !wallet) {
        return res.status(400).json({ error: 'artist and wallet required' });
    }
    if (!ethers.isAddress(wallet)) {
        return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const artists = readJSON(ARTISTS_FILE);
    const existing = artists.find(a => a.artist.toLowerCase() === artist.toLowerCase());
    if (existing) {
        return res.status(400).json({ error: 'Artist already registered' });
    }

    artists.push({ artist, wallet });
    writeJSON(ARTISTS_FILE, artists);
    res.json({ success: true, message: `Artist "${artist}" registered` });
});

// Register Listener
app.post('/api/register-listener', (req, res) => {
    const { username, wallet } = req.body;
    if (!username || !wallet) {
        return res.status(400).json({ error: 'username and wallet required' });
    }
    if (!ethers.isAddress(wallet)) {
        return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const listeners = readJSON(LISTENERS_FILE);
    const existing = listeners.find(l => l.username === username);
    if (existing) {
        return res.status(400).json({ error: 'Username already registered' });
    }

    listeners.push({ username, wallet });
    writeJSON(LISTENERS_FILE, listeners);
    res.json({ success: true, message: `Listener "${username}" registered` });
});

// Get all artists
app.get('/api/artists', (req, res) => {
    res.json(readJSON(ARTISTS_FILE));
});

// Get all listeners
app.get('/api/listeners', (req, res) => {
    res.json(readJSON(LISTENERS_FILE));
});

// Get transaction history
app.get('/api/history', (req, res) => {
    try {
        const historyFile = path.join(__dirname, 'plays_full.json');
        const data = fs.readFileSync(historyFile, 'utf8');
        res.json(JSON.parse(data));
    } catch {
        res.json([]);
    }
});

// Get stats
app.get('/api/stats', (req, res) => {
    try {
        const historyFile = path.join(__dirname, 'plays_full.json');
        const data = fs.readFileSync(historyFile, 'utf8');
        const history = JSON.parse(data);
        const totalPlays = history.length;
        let totalPaid = 0;
        history.forEach(h => {
            totalPaid += parseFloat(h.amountCreator) + parseFloat(h.amountListener);
        });
        res.json({ totalPlays, totalPaid: totalPaid.toFixed(7) });
    } catch {
        res.json({ totalPlays: 0, totalPaid: '0' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Registry API running at http://localhost:${PORT}`);
    console.log(`   POST /api/register-artist`);
    console.log(`   POST /api/register-listener`);
    console.log(`   GET  /api/artists`);
    console.log(`   GET  /api/listeners`);
    console.log(`   GET  /api/history`);
    console.log(`   GET  /api/stats`);
});