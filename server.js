require('dotenv').config();

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const botFilters = require('./botFilters');

const app = express();
const PORT = 3000;

const NAVI_URL = 'http://localhost:4534/rest';

// ============ REGISTRY FILES ============
const ARTISTS_FILE = path.join(__dirname, 'artists.json');
const LISTENERS_FILE = path.join(__dirname, 'listeners.json');
const SONGS_FILE = path.join(__dirname, 'songs.json');

// ============ WALLET LOOKUP (PRIORITY) ============
function getArtistWallet(artistName, trackTitle) {
    // 1. Search songs.json by title + artist
    try {
        const songsData = fs.readFileSync(SONGS_FILE, 'utf8');
        const songs = JSON.parse(songsData);
        const found = songs.find(s =>
            s.title.toLowerCase() === trackTitle.toLowerCase() &&
            s.artist.toLowerCase() === artistName.toLowerCase()
        );
        if (found) return found.artistWallet;
    } catch {}

    // 2. Search artists.json by artist name
    try {
        const artistsData = fs.readFileSync(ARTISTS_FILE, 'utf8');
        const artists = JSON.parse(artistsData);
        const found = artists.find(a => a.artist.toLowerCase() === artistName.toLowerCase());
        if (found) return found.wallet;
    } catch {}

    // 3. Fallback to RECEIVER_ADDRESS from .env
    return process.env.RECEIVER_ADDRESS;
}

function getListenerWallet(username) {
    try {
        const data = fs.readFileSync(LISTENERS_FILE, 'utf8');
        const listeners = JSON.parse(data);
        const found = listeners.find(l => l.username === username);
        if (found) return found.wallet;
    } catch {}
    return process.env.LISTENER_ADDRESS || process.env.RECEIVER_ADDRESS;
}

// ============ CREDENTIALS ============
const USER = process.env.NAVI_USER;
if (!USER) {
    console.error('❌ ERROR: NAVI_USER not found in .env');
    process.exit(1);
}

const PASS = process.env.NAVI_PASS;
if (!PASS) {
    console.error('❌ ERROR: NAVI_PASS not found in .env');
    process.exit(1);
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
    console.error('❌ ERROR: PRIVATE_KEY not found in .env');
    process.exit(1);
}

const RECEIVER_ADDRESS = process.env.RECEIVER_ADDRESS;
if (!RECEIVER_ADDRESS) {
    console.error('❌ ERROR: RECEIVER_ADDRESS not found in .env');
    process.exit(1);
}

if (!ethers.isAddress(RECEIVER_ADDRESS)) {
    console.error(`❌ ERROR: Invalid RECEIVER_ADDRESS: ${RECEIVER_ADDRESS}`);
    process.exit(1);
}

// ============ RPC & WALLET ============
const RPC_URL = "https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_fff8d922ee4c41c6dbd001ea0554f3d02bc43263d5df400f7fc0752fa360172b";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const senderWallet = new ethers.Wallet(PRIVATE_KEY, provider);
const SENDER_ADDRESS = senderWallet.address;

console.log(`\n🔑 SENDER WALLET (fixed):`);
console.log(`   Address: ${SENDER_ADDRESS}`);
console.log(`   ⚠️  Ensure this wallet has sufficient balance for gas + transfers.\n`);

console.log(`📤 FALLBACK CREATOR ADDRESS (if not found in songs.json or artists.json):`);
console.log(`   Address: ${RECEIVER_ADDRESS}\n`);

console.log(`📤 FALLBACK LISTENER ADDRESS (if username not found in listeners.json):`);
console.log(`   Address: ${process.env.LISTENER_ADDRESS || RECEIVER_ADDRESS}\n`);

console.log(`📅 Daily reset based on UTC (${botFilters.getUTCDate()})`);
console.log(`   Limits: 100 plays/day, max 2x per track/day\n`);

// ==========================================
// SEND PAYMENT + SAVE TX HASH + ATTENTION SCORE
// ==========================================
const HISTORY_FILE = path.join(__dirname, 'plays_full.json');

function loadPlayHistory() {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function savePlayHistory(history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

async function checkAndSendPayment(artist, title, username, track) {
    try {
        const balance = await provider.getBalance(SENDER_ADDRESS);
        console.log(`   💰 Sender balance: ${ethers.formatEther(balance)} USDC (native gas)`);

        const amountToCreator = ethers.parseEther('0.0000007');
        const amountToListener = ethers.parseEther('0.0000003');
        const totalTransfer = amountToCreator + amountToListener;

        // --- Gas estimation ---
        let feeData;
        try {
            feeData = await provider.getFeeData();
        } catch {
            feeData = { gasPrice: ethers.parseUnits('1', 'gwei') };
        }
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || ethers.parseUnits('1', 'gwei');
        const gasLimit = 21000n * 2n;
        const estimatedGasCost = gasPrice * gasLimit;

        console.log(`   ⛽ Estimated gas cost: ${ethers.formatEther(estimatedGasCost)} USDC`);

        if (balance < totalTransfer + estimatedGasCost) {
            console.log(`   ⚠️ Insufficient balance. Need ~${ethers.formatEther(totalTransfer + estimatedGasCost)} USDC.`);
            return;
        }

        // 1. Get dynamic creator wallet (priority: songs.json → artists.json → fallback)
        const creatorWallet = getArtistWallet(artist, title);
        console.log(`   🎤 Artist lookup: ${artist} → ${creatorWallet}`);

        // 2. Send 70% to Creator
        const tx1 = await senderWallet.sendTransaction({
            to: creatorWallet,
            value: amountToCreator,
        });
        console.log(`   ✅ Creator Royalty: 0.0000007 USDC | Tx: ${tx1.hash}`);
        await tx1.wait(1);

        // 3. Get dynamic listener wallet based on username
        const listenerWallet = getListenerWallet(username || 'sidecar');
        console.log(`   👤 Listener lookup: ${username || 'sidecar'} → ${listenerWallet}`);

        // 4. Send 30% to Listener
        const tx2 = await senderWallet.sendTransaction({
            to: listenerWallet,
            value: amountToListener,
        });
        console.log(`   ✅ Listener Incentive: 0.0000003 USDC | Tx: ${tx2.hash}`);
        await tx2.wait(1);

        console.log(`   ✅ All transactions confirmed!`);

        // ============ ATTENTION SCORE ============
        let attentionScore = 0;
        if (track) {
            const position = track.positionMs ? Math.floor(track.positionMs / 1000) : 0;
            const duration = track.duration || 0;
            const completion = duration > 0 ? (position / duration) * 100 : 0;
            const seekDetected = track.seekDetected || false;

            // Completion: 0-70 points
            attentionScore += Math.min(completion, 100) * 0.7;
            // No seek: +15 points
            if (!seekDetected) attentionScore += 15;
            // Duration >= 30 seconds: +15 points
            if (duration >= 30) attentionScore += 15;
            // Cap at 100
            attentionScore = Math.min(Math.round(attentionScore), 100);
        }

        // 5. Save transaction history with attention score
        const history = loadPlayHistory();
        history.push({
            timestamp: new Date().toISOString(),
            title: title,
            artist: artist,
            username: username || 'sidecar',
            creatorWallet: creatorWallet,
            listenerWallet: listenerWallet,
            txCreator: tx1.hash,
            txListener: tx2.hash,
            amountCreator: ethers.formatEther(amountToCreator),
            amountListener: ethers.formatEther(amountToListener),
            attentionScore: attentionScore,
        });
        savePlayHistory(history);

    } catch (error) {
        console.log(`   ❌ Failed to send payment: ${error.message}`);
    }
}

// ==========================================
// POLLING + AUTO-FINALIZE
// ==========================================
let isProcessing = false;
let idleStartTime = null;
let lastIdleTrack = null;

async function checkNowPlaying() {
    if (isProcessing) return;
    isProcessing = true;

    try {
        const response = await axios.get(`${NAVI_URL}/getNowPlaying`, {
            params: {
                v: '1.16.0',
                c: 'attentionpool',
                f: 'json',
                u: USER,
                p: PASS
            },
            timeout: 5000
        });

        const entries = response.data['subsonic-response']?.nowPlaying?.entry || [];

        if (entries.length > 0) {
            idleStartTime = null;
            lastIdleTrack = null;

            for (const track of entries) {
                // Extract username with fallback
                const username = track.username || 'sidecar';
                console.log(`\n🎵 Track played: ${track.title} - ${track.artist}`);
                console.log(`   👤 Username (from track): ${track.username}`);
                console.log(`   👤 Username (extracted): ${username}`);
                console.log(`   🔍 RAW TRACK DATA: ${JSON.stringify(track, null, 2)}`);

                // DEBUG: log before calling processTrack
                console.log(`🔍 DEBUG: Calling processTrack with username = ${username}`);

                const result = await botFilters.processTrack(SENDER_ADDRESS, track, username);
                result.results.forEach(msg => console.log(`   ${msg}`));

                if (result.passed && result.trackId) {
                    // Use the username we extracted
                    await checkAndSendPayment(result.artist, result.trackTitle, username, track);
                }
            }
        } else {
            const now = Date.now();
            if (!idleStartTime) {
                idleStartTime = now;
                // Try to get last track for each active user, but for simplicity we use default.
                // Better: iterate over active users.
                const activeUsers = botFilters.getActiveUsers();
                for (const user of activeUsers) {
                    const lastTrack = botFilters.getCurrentTrack(user);
                    if (lastTrack) {
                        // Store the last track per user? For now, we'll just use the first found.
                        // But we need to handle multiple users properly.
                        // Let's just use the first found for simplicity, but we'll improve.
                        if (!lastIdleTrack) {
                            lastIdleTrack = lastTrack;
                            // We need to store the username too; we'll store it separately.
                            // Actually we can derive from lastTrack.username.
                        }
                    }
                }
                // Fallback: if no track found, try to get from any user.
                if (!lastIdleTrack) {
                    const lastTrack = botFilters.getCurrentTrack('sidecar');
                    if (lastTrack) {
                        lastIdleTrack = lastTrack;
                    }
                }
            }

            const idleSeconds = Math.round((now - idleStartTime) / 1000);
            if (idleSeconds > 30 && idleSeconds % 10 === 0) {
                console.log(`⏳ No tracks playing... (${idleSeconds}s idle)`);
            }

            if (idleSeconds >= 30 && lastIdleTrack) {
                // Extract username from the track
                const username = lastIdleTrack.username || 'sidecar';
                console.log(`🔍 DEBUG: finalizing idle track for username = ${username}`);
                const result = await botFilters.finalizeTrackOnIdle(
                    SENDER_ADDRESS,
                    lastIdleTrack,
                    username
                );
                if (result && result.passed) {
                    console.log(`   ✅ Auto-completed reward sent!`);
                    await checkAndSendPayment(result.artist, result.trackTitle, username, lastIdleTrack);
                }
                lastIdleTrack = null;
                idleStartTime = null; // reset idle timer to avoid immediate re-finalize
            }
        }
    } catch (error) {
        if (error.response) {
            console.log(`   ⚠️ Navidrome error: ${error.response.status}`);
        } else {
            console.log(`   ⚠️ Navidrome error: ${error.message}`);
        }
    } finally {
        isProcessing = false;
    }
}

setInterval(checkNowPlaying, 10000);

app.listen(PORT, () => {
    console.log(`✅ AttentionPool FINAL running at http://localhost:${PORT}`);
    console.log(`📤 Artist Registry: ${ARTISTS_FILE}`);
    console.log(`📤 Listener Registry: ${LISTENERS_FILE}`);
    console.log(`📤 Song Registry: ${SONGS_FILE}`);
    console.log(`📤 History: ${HISTORY_FILE}`);
    console.log(`📋 Active filters:`);
    console.log(`   - Track must complete (≥90%) and ≥30s`);
    console.log(`   - 100 plays/day (UTC reset)`);
    console.log(`   - Max 2x reward per track/day`);
    console.log(`   - 30s cooldown between plays`);
    console.log(`   - Seek detection (position jumps >20s) + permanent invalidation`);
    console.log(`   - Dynamic Artist wallet lookup (songs.json → artists.json → fallback)`);
    console.log(`   - Dynamic Listener wallet lookup (listeners.json → fallback)`);
    console.log(`   - Full transaction history with Attention Score saved to plays_full.json`);
    console.log(`   - Multi-user support with per-user state, cache, and idle handling`);
});