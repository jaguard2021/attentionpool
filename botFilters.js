const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'plays.json');

const CONFIG = {
    MIN_DURATION: 30,
    COMPLETION_THRESHOLD: 0.9,
    MAX_PLAYS_PER_DAY: 100,
    MIN_INTERVAL_SECONDS: 30,
    MAX_REWARD_PER_TRACK_PER_DAY: 2,
    USE_PASSPORT: false,
    PASSPORT_API_KEY: '',
    MAX_DURATION_JUMP: 10,
};

let currentTrack = null;
let currentTrackProgress = 0;
let trackStartTime = null;
let lastDuration = 0;
let idleCounter = 0;

function getUTCDate() {
    return new Date().toISOString().split('T')[0];
}

function loadHistory() {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function saveHistory(history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function isTrackChanged(track) {
    const trackId = track.id || `${track.artist}-${track.title}`;
    if (!currentTrack) return true;
    return currentTrack.id !== trackId;
}

function isTrackCompleted(track) {
    const duration = track.duration || 0;
    const totalDuration = track.totalDuration || track.duration || 0;
    if (!totalDuration || totalDuration === 0) {
        return duration >= CONFIG.MIN_DURATION;
    }
    return duration >= totalDuration * CONFIG.COMPLETION_THRESHOLD;
}

function isSeekDetected(track) {
    const currentDuration = track.duration || 0;
    if (lastDuration === 0) {
        lastDuration = currentDuration;
        return false;
    }
    const durationJump = currentDuration - lastDuration;
    if (durationJump > CONFIG.MAX_DURATION_JUMP) {
        console.log(`   ⚠️ SEEK DETECTED! Duration jumped ${durationJump}s in 10s.`);
        return true;
    }
    lastDuration = currentDuration;
    return false;
}

function checkDailyLimit(walletAddress) {
    const history = loadHistory();
    const todayUTC = getUTCDate();
    const todayPlays = history.filter(entry =>
        entry.wallet === walletAddress && entry.date === todayUTC
    );
    if (todayPlays.length >= CONFIG.MAX_PLAYS_PER_DAY) {
        return {
            passed: false,
            reason: `Daily limit reached (${CONFIG.MAX_PLAYS_PER_DAY} plays).`
        };
    }
    return { passed: true, remaining: CONFIG.MAX_PLAYS_PER_DAY - todayPlays.length };
}

function checkTrackLimit(walletAddress, trackId, trackTitle) {
    const history = loadHistory();
    const todayUTC = getUTCDate();
    const trackPlaysToday = history.filter(entry =>
        entry.wallet === walletAddress &&
        entry.date === todayUTC &&
        entry.trackId === trackId
    );
    const count = trackPlaysToday.length;
    if (count >= CONFIG.MAX_REWARD_PER_TRACK_PER_DAY) {
        return {
            passed: false,
            reason: `Track "${trackTitle}" already rewarded ${count} times today (max ${CONFIG.MAX_REWARD_PER_TRACK_PER_DAY}).`
        };
    }
    return { passed: true, remaining: CONFIG.MAX_REWARD_PER_TRACK_PER_DAY - count, count };
}

function checkInterval(walletAddress) {
    const history = loadHistory();
    const lastPlay = history
        .filter(entry => entry.wallet === walletAddress)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    if (lastPlay) {
        const diffSeconds = (new Date() - new Date(lastPlay.timestamp)) / 1000;
        if (diffSeconds < CONFIG.MIN_INTERVAL_SECONDS) {
            return {
                passed: false,
                reason: `Too fast! Wait ${CONFIG.MIN_INTERVAL_SECONDS}s between plays (${Math.round(diffSeconds)}s since last).`
            };
        }
    }
    return { passed: true };
}

async function checkPassport(walletAddress) {
    if (!CONFIG.USE_PASSPORT) {
        return { passed: true, reason: 'Passport inactive (skip).' };
    }
    try {
        const axios = require('axios');
        const response = await axios.get(
            `https://api.passport.gitcoin.co/v1/score/${walletAddress}`,
            { headers: { 'X-API-Key': CONFIG.PASSPORT_API_KEY } }
        );
        const score = response.data.score;
        if (score < 20) {
            return {
                passed: false,
                reason: `Passport score too low (${score}). Minimum 20 required.`
            };
        }
        return { passed: true, reason: `Passport score: ${score} (passed).` };
    } catch (error) {
        console.log(`   ⚠️ Passport API error: ${error.message}`);
        return { passed: true, reason: 'Passport API error, skipped.' };
    }
}

function recordPlay(walletAddress, trackTitle, artist, trackId) {
    const history = loadHistory();
    const entry = {
        wallet: walletAddress,
        date: getUTCDate(),
        timestamp: new Date().toISOString(),
        title: trackTitle,
        artist,
        trackId,
    };
    history.push(entry);
    saveHistory(history);
}

async function processTrack(walletAddress, track) {
    const results = [];
    const trackId = track.id || `${track.artist}-${track.title}`;
    const trackTitle = track.title || track.name || 'Unknown';
    const artist = track.artist || 'Unknown Artist';
    const duration = track.duration || 0;
    const totalDuration = track.totalDuration || track.duration || 0;
    const progress = totalDuration > 0 ? (duration / totalDuration) : 0;

    const trackChanged = isTrackChanged(track);

    if (trackChanged) {
        lastDuration = 0;

        if (currentTrack && isTrackCompleted(currentTrack)) {
            const prevTrackId = currentTrack.id || `${currentTrack.artist}-${currentTrack.title}`;
            const prevTitle = currentTrack.title || currentTrack.name || 'Unknown';
            const prevArtist = currentTrack.artist || 'Unknown Artist';

            console.log(`   ✅ Track "${prevTitle}" completed (${Math.round(currentTrackProgress * 100)}%) — processing reward...`);

            const dailyCheck = checkDailyLimit(walletAddress);
            results.push(dailyCheck.reason || `Plays remaining today: ${dailyCheck.remaining}`);
            if (!dailyCheck.passed) {
                currentTrack = track;
                currentTrackProgress = progress;
                trackStartTime = Date.now();
                return { passed: false, results, filter: 'daily_limit' };
            }

            const trackLimitCheck = checkTrackLimit(walletAddress, prevTrackId, prevTitle);
            results.push(trackLimitCheck.reason);
            if (!trackLimitCheck.passed) {
                currentTrack = track;
                currentTrackProgress = progress;
                trackStartTime = Date.now();
                return { passed: false, results, filter: 'track_limit' };
            }

            const intervalCheck = checkInterval(walletAddress);
            results.push(intervalCheck.reason);
            if (!intervalCheck.passed) {
                currentTrack = track;
                currentTrackProgress = progress;
                trackStartTime = Date.now();
                return { passed: false, results, filter: 'too_fast' };
            }

            const passportCheck = await checkPassport(walletAddress);
            results.push(passportCheck.reason);
            if (!passportCheck.passed) {
                currentTrack = track;
                currentTrackProgress = progress;
                trackStartTime = Date.now();
                return { passed: false, results, filter: 'passport' };
            }

            recordPlay(walletAddress, prevTitle, prevArtist, prevTrackId);
            results.push(`✅ All filters passed! (${trackLimitCheck.count + 1}/${CONFIG.MAX_REWARD_PER_TRACK_PER_DAY} for this track today)`);

            currentTrack = track;
            currentTrackProgress = progress;
            trackStartTime = Date.now();

            return { passed: true, results, trackTitle: prevTitle, artist: prevArtist, trackId: prevTrackId };

        } else {
            if (currentTrack) {
                const prevTitle = currentTrack.title || currentTrack.name || 'Unknown';
                console.log(`   ⏳ Track "${prevTitle}" not completed (${Math.round(currentTrackProgress * 100)}%) — reward cancelled.`);
            }
            currentTrack = track;
            currentTrackProgress = progress;
            trackStartTime = Date.now();
            return { passed: false, results: ['⏳ Track not completed, waiting...'], filter: 'not_completed' };
        }
    }

    if (isSeekDetected(track)) {
        currentTrack = track;
        currentTrackProgress = progress;
        trackStartTime = Date.now();
        return {
            passed: false,
            results: ['⚠️ SEEK DETECTED! Reward cancelled.'],
            filter: 'seek_detected'
        };
    }

    currentTrack = track;
    currentTrackProgress = progress;
    trackStartTime = Date.now();

    return {
        passed: false,
        results: [`⏳ Still playing: "${trackTitle}" (${Math.round(progress * 100)}%)`],
        filter: 'still_playing'
    };
}

function resetIdleCounter() {
    idleCounter = 0;
}

module.exports = {
    CONFIG,
    processTrack,
    recordPlay,
    loadHistory,
    resetIdleCounter,
    getUTCDate,
    getCurrentTrack: () => currentTrack,
};