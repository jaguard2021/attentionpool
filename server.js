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

// ============ REGISTRY ============
const ARTISTS_FILE = path.join(__dirname, 'artists.json');
const LISTENERS_FILE = path.join(__dirname, 'listeners.json');

function getArtistWallet(artistName) {
    try {
        const data = fs.readFileSync(ARTISTS_FILE, 'utf8');
        const artists = JSON.parse(data);
        const found = artists.find(a => a.artist.toLowerCase() === artistName.toLowerCase());
        if (found) return found.wallet;
    } catch {}
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
// ===================================

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
// ====================================

const RPC_URL = "https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_fff8d922ee4c41c6dbd001ea0554f3d02bc43263d5df400f7fc0752fa360172b";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const senderWallet = new ethers.Wallet(PRIVATE_KEY, provider);
const SENDER_ADDRESS = senderWallet.address;

console.log(`\n🔑 SENDER WALLET (fixed):`);
console.log(`   Address: ${SENDER_ADDRESS}`);
console.log(`   ⚠️  Ensure this wallet has sufficient balance for gas + transfers.\n`);

console.log(`📤 FALLBACK CREATOR ADDRESS (if artist not found):`);
console.log(`   Address: ${RECEIVER_ADDRESS}\n`);

console.log(`📤 FALLBACK LISTENER ADDRESS (if username not found):`);
console.log(`   Address: ${process.env.LISTENER_ADDRESS || RECEIVER_ADDRESS}\n`);

console.log(`📅 Daily reset based on UTC (${botFilters.getUTCDate()})`);
console.log(`   Limits: 100 plays/day, max 2x per track/day\n`);

// ==========================================
// FUNGSI KIRIM PAYMENT + SAVE TX HASH
// ==========================================
const HISTORY_FILE = path.join(__dirname, 'plays_full.json');

function loadPlayHistory() {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function savePlayHistory(history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

async function checkAndSendPayment(artist, title, username) {
    try {
        const balance = await provider.getBalance(SENDER_ADDRESS);
        console.log(`   💰 Sender balance: ${ethers.formatEther(balance)} USDC (native gas)`);

        const amountToCreator = ethers.parseEther('0.0000007');
        const amountToListener = ethers.parseEther('0.0000003');
        const totalTransfer = amountToCreator + amountToListener;

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

        const creatorWallet = getArtistWallet(artist);
        console.log(`   🎤 Artist lookup: ${artist} → ${creatorWallet}`);

        const tx1 = await senderWallet.sendTransaction({
            to: creatorWallet,
            value: amountToCreator,
        });
        console.log(`   ✅ Creator Royalty: 0.0000007 USDC | Tx: ${tx1.hash}`);
        await tx1.wait(1);

        const listenerWallet = getListenerWallet(username || 'sidecar');
        console.log(`   👤 Listener lookup: ${username || 'sidecar'} → ${listenerWallet}`);

        const tx2 = await senderWallet.sendTransaction({
            to: listenerWallet,
            value: amountToListener,
        });
        console.log(`   ✅ Listener Incentive: 0.0000003 USDC | Tx: ${tx2.hash}`);
        await tx2.wait(1);

        console.log(`   ✅ All transactions confirmed!`);

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
        });
        savePlayHistory(history);

    } catch (error) {
        console.log(`   ❌ Failed to send payment: ${error.message}`);
    }
}

// ==========================================
// IDLE STATE PER USER (FIX)
// ==========================================
const idleStates = {};

function getIdleState(username) {
    if (!idleStates[username]) {
        idleStates[username] = {
            idleStartTime: null,
            lastTrack: null,
        };
    }
    return idleStates[username];
}

// ==========================================
// FUNGSI PANTAU LAGU + AUTO-FINALIZE PER USER
// ==========================================
let isProcessing = false;

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
            // Reset idle untuk semua user yang sedang aktif
            for (const track of entries) {
                const username = track.username || 'sidecar';
                const idleState = getIdleState(username);
                idleState.idleStartTime = null;
                idleState.lastTrack = null;
            }

            // Proses setiap track
            for (const track of entries) {
                const username = track.username || 'sidecar';
                console.log(`\n🎵 Track played: ${track.title} - ${track.artist}`);
                console.log(`   👤 Username: ${username}`);
                console.log(`   🔍 RAW TRACK DATA: ${JSON.stringify(track, null, 2)}`);

                const result = await botFilters.processTrack(SENDER_ADDRESS, track, username);
                result.results.forEach(msg => console.log(`   ${msg}`));

                if (result.passed && result.trackId) {
                    await checkAndSendPayment(result.artist, result.trackTitle, username);
                }
            }
        } else {
            // Tidak ada track: cek idle per user
            const activeUsers = botFilters.getActiveUsers();

            for (const username of activeUsers) {
                const idleState = getIdleState(username);
                const lastTrack = botFilters.getCurrentTrack(username);

                if (!lastTrack) {
                    // User tidak punya track terakhir, skip
                    continue;
                }

                if (!idleState.idleStartTime) {
                    idleState.idleStartTime = Date.now();
                    idleState.lastTrack = lastTrack;
                }

                const idleSeconds = Math.round((Date.now() - idleState.idleStartTime) / 1000);

                if (idleSeconds > 30 && idleSeconds % 10 === 0) {
                    console.log(`⏳ No tracks playing for ${username}... (${idleSeconds}s idle)`);
                }

                if (idleSeconds >= 30 && idleState.lastTrack) {
                    const result = await botFilters.finalizeTrackOnIdle(
                        SENDER_ADDRESS,
                        idleState.lastTrack,
                        username
                    );
                    if (result && result.passed) {
                        console.log(`   ✅ Auto-completed reward sent for ${username}!`);
                        await checkAndSendPayment(result.artist, result.trackTitle, username);
                    }
                    idleState.lastTrack = null;
                    idleState.idleStartTime = null;
                }
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
    console.log(`📤 History: ${HISTORY_FILE}`);
    console.log(`📋 Active filters:`);
    console.log(`   - Track must complete (≥90%) and ≥30s`);
    console.log(`   - 100 plays/day (UTC reset)`);
    console.log(`   - Max 2x reward per track/day`);
    console.log(`   - 30s cooldown between plays`);
    console.log(`   - Seek detection (position jumps >20s) + permanent invalidation`);
    console.log(`   - Dynamic Artist wallet lookup (artists.json)`);
    console.log(`   - Dynamic Listener wallet lookup (listeners.json)`);
    console.log(`   - Full transaction history saved to plays_full.json`);
    console.log(`   - ✅ MULTI-USER SUPPORT (state, idle, and history per username)`);
});