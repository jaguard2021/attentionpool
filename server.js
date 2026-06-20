require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { ethers } = require('ethers');
const botFilters = require('./botFilters');

const app = express();
const PORT = 3000;

const NAVI_URL = 'http://localhost:4534/rest';

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

const RPC_URL = "https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_fff8d922ee4c41c6dbd001ea0554f3d02bc43263d5df400f7fc0752fa360172b";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const senderWallet = new ethers.Wallet(PRIVATE_KEY, provider);
const SENDER_ADDRESS = senderWallet.address;

console.log(`\n🔑 SENDER WALLET (fixed):`);
console.log(`   Address: ${SENDER_ADDRESS}`);
console.log(`   ⚠️  Ensure this wallet has sufficient balance for gas + transfers.\n`);

console.log(`📤 SENDING ROYALTIES TO CREATOR:`);
console.log(`   Address: ${RECEIVER_ADDRESS}\n`);

console.log(`📅 Daily reset based on UTC (${botFilters.getUTCDate()})`);
console.log(`   Limits: 100 plays/day, max 2x per track/day\n`);

async function checkAndSendPayment(artist, title) {
    try {
        const balance = await provider.getBalance(SENDER_ADDRESS);
        console.log(`   💰 Sender balance: ${ethers.formatEther(balance)} USDC (testnet)`);

        const amountToCreator = ethers.parseEther('0.0000007');
        const amountToListener = ethers.parseEther('0.0000003');
        const totalTransfer = amountToCreator + amountToListener;
        const estimatedGas = ethers.parseEther('0.001');

        if (balance < totalTransfer + estimatedGas) {
            console.log(`   ⚠️ Insufficient balance. Need ~${ethers.formatEther(totalTransfer + estimatedGas)} USDC.`);
            return;
        }

        const tx1 = await senderWallet.sendTransaction({
            to: RECEIVER_ADDRESS,
            value: amountToCreator,
        });
        console.log(`   ✅ Creator Royalty: 0.0000007 USDC | Tx: ${tx1.hash}`);
        await tx1.wait(1);

        const tx2 = await senderWallet.sendTransaction({
            to: SENDER_ADDRESS,
            value: amountToListener,
        });
        console.log(`   ✅ Listener Incentive: 0.0000003 USDC | Tx: ${tx2.hash}`);
        await tx2.wait(1);

        console.log(`   ✅ Both transactions confirmed!`);
    } catch (error) {
        console.log(`   ❌ Failed to send split payment: ${error.message}`);
    }
}

let lastActivityTime = Date.now();

async function checkNowPlaying() {
    try {
        const response = await axios.get(`${NAVI_URL}/getNowPlaying`, {
            params: {
                v: '1.16.0',
                c: 'attentionpool',
                f: 'json',
                u: USER,
                p: PASS
            }
        });

        const entries = response.data['subsonic-response']?.nowPlaying?.entry || [];
        if (entries.length > 0) {
            lastActivityTime = Date.now();
            botFilters.resetIdleCounter();

            for (const track of entries) {
                console.log(`\n🎵 Track played: ${track.title} - ${track.artist}`);

                const result = await botFilters.processTrack(SENDER_ADDRESS, track);
                result.results.forEach(msg => console.log(`   ${msg}`));

                if (result.passed) {
                    await checkAndSendPayment(result.artist, result.trackTitle);
                }
            }
        } else {
            const idleSeconds = Math.round((Date.now() - lastActivityTime) / 1000);
            if (idleSeconds > 30 && idleSeconds % 10 === 0) {
                console.log(`⏳ No tracks playing... (${idleSeconds}s idle)`);
            }
        }
    } catch (error) {
        if (error.response) {
            console.log(`   ⚠️ Navidrome error: ${error.response.status}`);
        }
    }
}

setInterval(checkNowPlaying, 10000);

app.listen(PORT, () => {
    console.log(`✅ AttentionPool FINAL running at http://localhost:${PORT}`);
    console.log(`📤 Sending to Creator: ${RECEIVER_ADDRESS}`);
    console.log(`📤 Sending to Listener (you): ${SENDER_ADDRESS}`);
    console.log(`📋 Active filters:`);
    console.log(`   - Track must complete (≥90%)`);
    console.log(`   - 100 plays/day (UTC reset)`);
    console.log(`   - Max 2x reward per track/day`);
    console.log(`   - 30s cooldown between plays`);
    console.log(`   - Seek detection (duration jumps)`);
    console.log(`   - Gitcoin Passport (inactive)`);
});