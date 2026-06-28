const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

const app = express();
const PORT = 3001;

app.use(express.json());
app.use(express.static('public'));

// =============================================
// FILE PATHS
// =============================================
const ARTISTS_FILE = path.join(__dirname, 'artists.json');
const LISTENERS_FILE = path.join(__dirname, 'listeners.json');
const SONGS_FILE = path.join(__dirname, 'songs.json');
const HISTORY_FILE = path.join(__dirname, 'plays_full.json');

// =============================================
// HELPER FUNCTIONS
// =============================================
function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// =============================================
// REGISTER ARTIST
// =============================================
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

// =============================================
// REGISTER LISTENER
// =============================================
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

// =============================================
// REGISTER SONG — SHA-256 TRACK ID
// =============================================
app.post('/api/register-song', (req, res) => {
    const { title, artist, artistWallet } = req.body;
    if (!title || !artist || !artistWallet) {
        return res.status(400).json({ error: 'title, artist, and artistWallet required' });
    }
    if (!ethers.isAddress(artistWallet)) {
        return res.status(400).json({ error: 'Invalid artist wallet address' });
    }

    const songs = readJSON(SONGS_FILE);
    const existing = songs.find(s =>
        s.title.toLowerCase() === title.toLowerCase() &&
        s.artist.toLowerCase() === artist.toLowerCase()
    );
    if (existing) {
        return res.status(400).json({ error: 'Song already registered' });
    }

    // Generate Track ID using SHA-256 (stable, collision-resistant)
    const trackId = crypto
        .createHash('sha256')
        .update(`${title}:${artist}`)
        .digest('hex')
        .slice(0, 24);

    songs.push({
        trackId,
        title,
        artist,
        artistWallet,
        registered: true,
        registeredAt: new Date().toISOString()
    });
    writeJSON(SONGS_FILE, songs);
    res.json({
        success: true,
        message: `Song "${title}" registered`,
        trackId
    });
});

// =============================================
// GET ENDPOINTS
// =============================================
app.get('/api/artists', (req, res) => {
    res.json(readJSON(ARTISTS_FILE));
});

app.get('/api/listeners', (req, res) => {
    res.json(readJSON(LISTENERS_FILE));
});

app.get('/api/songs', (req, res) => {
    res.json(readJSON(SONGS_FILE));
});

// =============================================
// HISTORY & STATS
// =============================================
app.get('/api/history', (req, res) => {
    try {
        const data = fs.readFileSync(HISTORY_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch {
        res.json([]);
    }
});

app.get('/api/stats', (req, res) => {
    try {
        const data = fs.readFileSync(HISTORY_FILE, 'utf8');
        const history = JSON.parse(data);
        const totalPlays = history.length;
        let totalPaid = 0;
        history.forEach(h => {
            totalPaid += parseFloat(h.amountCreator || 0) + parseFloat(h.amountListener || 0);
        });
        // Average attention score
        let totalScore = 0;
        let scoredPlays = 0;
        history.forEach(h => {
            if (h.attentionScore !== undefined) {
                totalScore += h.attentionScore;
                scoredPlays++;
            }
        });
        const avgScore = scoredPlays > 0 ? Math.round(totalScore / scoredPlays) : 0;

        res.json({
            totalPlays,
            totalPaid: totalPaid.toFixed(7),
            averageAttentionScore: avgScore
        });
    } catch {
        res.json({ totalPlays: 0, totalPaid: '0', averageAttentionScore: 0 });
    }
});

// =============================================
// ARTIST STATS (per wallet)
// =============================================
app.get('/api/artist-stats/:wallet', (req, res) => {
    const wallet = req.params.wallet;
    try {
        const data = fs.readFileSync(HISTORY_FILE, 'utf8');
        const history = JSON.parse(data);
        const plays = history.filter(h =>
            h.creatorWallet && h.creatorWallet.toLowerCase() === wallet.toLowerCase()
        );
        const totalPlays = plays.length;
        let totalRoyalties = 0;
        plays.forEach(p => {
            totalRoyalties += parseFloat(p.amountCreator || 0);
        });
        const songs = new Set(plays.map(p => p.title));
        // Average attention score for this artist
        let totalScore = 0;
        let scoredPlays = 0;
        plays.forEach(p => {
            if (p.attentionScore !== undefined) {
                totalScore += p.attentionScore;
                scoredPlays++;
            }
        });
        const avgScore = scoredPlays > 0 ? Math.round(totalScore / scoredPlays) : 0;

        res.json({
            wallet,
            totalPlays,
            totalRoyalties: totalRoyalties.toFixed(7),
            uniqueSongs: songs.size,
            averageAttentionScore: avgScore
        });
    } catch {
        res.json({ wallet, totalPlays: 0, totalRoyalties: '0', uniqueSongs: 0, averageAttentionScore: 0 });
    }
});

// =============================================
// START SERVER
// =============================================
app.listen(PORT, () => {
    console.log(`✅ Registry API running at http://localhost:${PORT}`);
    console.log(`   POST /api/register-artist`);
    console.log(`   POST /api/register-listener`);
    console.log(`   POST /api/register-song (SHA-256 Track ID)`);
    console.log(`   GET  /api/artists`);
    console.log(`   GET  /api/listeners`);
    console.log(`   GET  /api/songs`);
    console.log(`   GET  /api/history`);
    console.log(`   GET  /api/stats (includes avg Attention Score)`);
    console.log(`   GET  /api/artist-stats/:wallet`);
});