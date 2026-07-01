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
    MAX_DURATION_JUMP: 20,
    IDLE_TIMEOUT: 30,
};

// === PER-USER STATE ===
const userStates = {};

function getState(username) {
    if (!userStates[username]) {
        userStates[username] = {
            currentTrack: null,
            currentTrackProgress: 0,
            trackStartTime: null,
            lastDuration: 0,
            seekNotified: false,
        };
    }
    return userStates[username];
}

function getActiveUsers() {
    return Object.keys(userStates);
}

// === PER-USER CACHE (key: username:trackId) ===
const finalizedTracks = new Set();
const seekInvalidatedTracks = new Set();
let lastResetDate = getUTCDate();

function getTrackKey(username, trackId) {
    return `${username}:${trackId}`;
}

function getUTCDate() {
    return new Date().toISOString().split('T')[0];
}

function resetCaches() {
    const today = getUTCDate();
    if (today !== lastResetDate) {
        finalizedTracks.clear();
        seekInvalidatedTracks.clear();
        lastResetDate = today;
        console.log(`🔄 Track caches reset for new day (${today})`);
    }
}

function loadHistory() {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function saveHistory(history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function getCurrentPosition(track) {
    if (track.positionMs !== undefined && track.positionMs !== null) {
        return Math.floor(track.positionMs / 1000);
    }
    if (track.position !== undefined && track.position !== null) {
        return track.position;
    }
    if (track.current !== undefined && track.current !== null) {
        return track.current;
    }
    return 0;
}

function getTotalDuration(track) {
    if (track.totalDuration !== undefined && track.totalDuration !== null) {
        return track.totalDuration;
    }
    return track.duration || 0;
}

function isTrackCompleted(track) {
    const position = getCurrentPosition(track);
    const totalDuration = getTotalDuration(track);
    if (totalDuration > 0 && totalDuration < CONFIG.MIN_DURATION) {
        return false;
    }
    if (position === 0) return false;
    if (totalDuration === 0) return position >= CONFIG.MIN_DURATION;
    return (position / totalDuration) >= CONFIG.COMPLETION_THRESHOLD;
}

function checkDailyLimit(username) {
    const history = loadHistory();
    const todayUTC = getUTCDate();
    const todayPlays = history.filter(entry =>
        entry.username === username && entry.date === todayUTC
    );
    if (todayPlays.length >= CONFIG.MAX_PLAYS_PER_DAY) {
        return {
            passed: false,
            reason: `Daily limit reached (${CONFIG.MAX_PLAYS_PER_DAY} plays) for ${username}.`
        };
    }
    return { passed: true, remaining: CONFIG.MAX_PLAYS_PER_DAY - todayPlays.length };
}

function checkTrackLimit(username, trackId, trackTitle) {
    const history = loadHistory();
    const todayUTC = getUTCDate();
    const trackPlaysToday = history.filter(entry =>
        entry.username === username &&
        entry.date === todayUTC &&
        entry.trackId === trackId
    );
    const count = trackPlaysToday.length;
    if (count >= CONFIG.MAX_REWARD_PER_TRACK_PER_DAY) {
        return {
            passed: false,
            reason: `Track "${trackTitle}" already rewarded ${count} times today (max ${CONFIG.MAX_REWARD_PER_TRACK_PER_DAY}) for ${username}.`
        };
    }
    return {
        passed: true,
        reason: `Track rewards remaining: ${CONFIG.MAX_REWARD_PER_TRACK_PER_DAY - count}`,
        remaining: CONFIG.MAX_REWARD_PER_TRACK_PER_DAY - count,
        count
    };
}

function checkInterval(username) {
    const history = loadHistory();
    const lastPlay = history
        .filter(entry => entry.username === username)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    if (lastPlay) {
        const diffSeconds = (new Date() - new Date(lastPlay.timestamp)) / 1000;
        if (diffSeconds < CONFIG.MIN_INTERVAL_SECONDS) {
            return {
                passed: false,
                reason: `Too fast! Wait ${CONFIG.MIN_INTERVAL_SECONDS}s between plays (${Math.round(diffSeconds)}s since last for ${username}).`
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

function recordPlay(walletAddress, trackTitle, artist, trackId, username) {
    const history = loadHistory();
    history.push({
        wallet: walletAddress,
        username: username || 'unknown',
        date: getUTCDate(),
        timestamp: new Date().toISOString(),
        title: trackTitle,
        artist,
        trackId,
    });
    saveHistory(history);
}

function resetTrackState(username) {
    const state = getState(username);
    state.currentTrack = null;
    state.currentTrackProgress = 0;
    state.trackStartTime = null;
    state.lastDuration = 0;
    state.seekNotified = false;
}

// === LAYER 1: PROCESS TRACK (reject short tracks immediately) ===
async function processTrack(walletAddress, track, username) {
    const results = [];
    const state = getState(username);
    const trackId = track.id || `${track.artist}-${track.title}`;
    const trackKey = getTrackKey(username, trackId);
    const trackTitle = track.title || track.name || 'Unknown';
    const artist = track.artist || 'Unknown Artist';
    const position = getCurrentPosition(track);
    const totalDuration = getTotalDuration(track);
    const progress = totalDuration > 0 ? (position / totalDuration) : 0;

    resetCaches();

    // --- EARLY REJECTION: Short tracks ---
    if (totalDuration > 0 && totalDuration < CONFIG.MIN_DURATION) {
        console.log(
            `   ⛔ Track "${trackTitle}" too short (${totalDuration}s < ${CONFIG.MIN_DURATION}s)`
        );
        finalizedTracks.add(trackKey);
        return {
            passed: false,
            results: [
                `⛔ Track rejected: duration ${totalDuration}s below minimum ${CONFIG.MIN_DURATION}s`
            ],
            filter: 'track_too_short'
        };
    }

    if (finalizedTracks.has(trackKey)) {
        console.log(`   ⏳ Track "${trackTitle}" already finalized for user ${username}, skipping.`);
        return {
            passed: false,
            results: [`⏳ Track already finalized for ${username}, skipping.`],
            filter: 'already_finalized'
        };
    }

    if (seekInvalidatedTracks.has(trackKey)) {
        if (!state.seekNotified) {
            console.log(`   ⛔ Track "${trackTitle}" invalidated by previous seek for user ${username}.`);
            state.seekNotified = true;
        }
        return {
            passed: false,
            results: [],
            filter: 'seek_invalidated'
        };
    }

    if (position > 0) {
        console.log(`   📍 Position: ${position}s / ${totalDuration}s (${Math.round(progress * 100)}%)`);
    }

    const trackChanged = state.currentTrack ? (state.currentTrack.id !== trackId) : true;

    if (trackChanged) {
        state.seekNotified = false;
        state.lastDuration = 0;

        if (state.currentTrack && isTrackCompleted(state.currentTrack)) {
            const prevTrackId = state.currentTrack.id || `${state.currentTrack.artist}-${state.currentTrack.title}`;
            const prevTrackKey = getTrackKey(username, prevTrackId);
            const prevTitle = state.currentTrack.title || state.currentTrack.name || 'Unknown';
            const prevArtist = state.currentTrack.artist || 'Unknown Artist';

            if (seekInvalidatedTracks.has(prevTrackKey)) {
                console.log(`   ⛔ Track "${prevTitle}" invalidated by previous seek for ${username}.`);
                seekInvalidatedTracks.delete(prevTrackKey);
                state.currentTrack = track;
                state.currentTrackProgress = progress;
                state.trackStartTime = Date.now();
                return {
                    passed: false,
                    results: [`⛔ Track invalid due to previous seek for ${username}.`],
                    filter: 'seek_invalidated'
                };
            }

            console.log(`   ✅ Track "${prevTitle}" completed (${Math.round(state.currentTrackProgress * 100)}%) — processing reward...`);

            const dailyCheck = checkDailyLimit(username);
            results.push(dailyCheck.reason || `Plays remaining today: ${dailyCheck.remaining}`);
            if (!dailyCheck.passed) {
                state.currentTrack = track;
                state.currentTrackProgress = progress;
                state.trackStartTime = Date.now();
                return { passed: false, results, filter: 'daily_limit' };
            }

            const trackLimitCheck = checkTrackLimit(username, prevTrackId, prevTitle);
            results.push(trackLimitCheck.reason);
            if (!trackLimitCheck.passed) {
                state.currentTrack = track;
                state.currentTrackProgress = progress;
                state.trackStartTime = Date.now();
                return { passed: false, results, filter: 'track_limit' };
            }

            const intervalCheck = checkInterval(username);
            results.push(intervalCheck.reason);
            if (!intervalCheck.passed) {
                state.currentTrack = track;
                state.currentTrackProgress = progress;
                state.trackStartTime = Date.now();
                return { passed: false, results, filter: 'too_fast' };
            }

            const passportCheck = await checkPassport(walletAddress);
            results.push(passportCheck.reason);
            if (!passportCheck.passed) {
                state.currentTrack = track;
                state.currentTrackProgress = progress;
                state.trackStartTime = Date.now();
                return { passed: false, results, filter: 'passport' };
            }

            recordPlay(walletAddress, prevTitle, prevArtist, prevTrackId, username);
            results.push(`✅ All filters passed! (${trackLimitCheck.count + 1}/${CONFIG.MAX_REWARD_PER_TRACK_PER_DAY} for this track today)`);

            finalizedTracks.add(prevTrackKey);
            seekInvalidatedTracks.delete(prevTrackKey);

            state.currentTrack = track;
            state.currentTrackProgress = progress;
            state.trackStartTime = Date.now();

            return { passed: true, results, trackTitle: prevTitle, artist: prevArtist, trackId: prevTrackId };
        } else {
            if (state.currentTrack) {
                const prevTitle = state.currentTrack.title || state.currentTrack.name || 'Unknown';
                console.log(`   ⏳ Track "${prevTitle}" not completed (${Math.round(state.currentTrackProgress * 100)}%) — reward cancelled.`);
                const prevTrackId = state.currentTrack.id || `${state.currentTrack.artist}-${state.currentTrack.title}`;
                const prevTrackKey = getTrackKey(username, prevTrackId);
                seekInvalidatedTracks.delete(prevTrackKey);
            }
            state.currentTrack = track;
            state.currentTrackProgress = progress;
            state.trackStartTime = Date.now();
            return { passed: false, results: ['⏳ Track not completed, waiting...'], filter: 'not_completed' };
        }
    }

    // Same track: check seek
    const currentPosition = getCurrentPosition(track);
    console.log(`   🐞 DEBUG position=${currentPosition}s last=${state.lastDuration}s (user: ${username})`);
    if (state.lastDuration > 0) {
        const jump = currentPosition - state.lastDuration;
        if (jump > CONFIG.MAX_DURATION_JUMP) {
            console.log(`   ⚠️ SEEK DETECTED! ${state.lastDuration}s -> ${currentPosition}s (jump: ${jump}s) (user: ${username})`);
            state.lastDuration = currentPosition;
            const invalidKey = getTrackKey(username, trackId);
            seekInvalidatedTracks.add(invalidKey);
            console.log(`   ⛔ Track "${trackTitle}" marked as invalid due to seek for ${username}.`);
            state.seekNotified = true;
            state.currentTrack = track;
            state.currentTrackProgress = progress;
            state.trackStartTime = Date.now();
            return {
                passed: false,
                results: ['⚠️ SEEK DETECTED! Reward cancelled. Track invalidated.'],
                filter: 'seek_detected'
            };
        }
    }
    state.lastDuration = currentPosition;

    state.currentTrack = track;
    state.currentTrackProgress = progress;
    state.trackStartTime = Date.now();

    return {
        passed: false,
        results: [`⏳ Still playing: "${trackTitle}" (${Math.round(progress * 100)}%)`],
        filter: 'still_playing'
    };
}

// === LAYER 2: FINALIZE TRACK ON IDLE (safety net for short tracks) ===
async function finalizeTrackOnIdle(walletAddress, track, username) {
    if (!track) return null;
    const state = getState(username);
    const trackId = track.id || `${track.artist}-${track.title}`;
    const trackKey = getTrackKey(username, trackId);
    const trackTitle = track.title || track.name || 'Unknown';
    const artist = track.artist || 'Unknown Artist';
    const duration = getTotalDuration(track);

    // Safety net: reject short tracks in case they bypassed processTrack
    if (duration > 0 && duration < CONFIG.MIN_DURATION) {
        console.log(
            `   ⛔ Track "${trackTitle}" duration ${duration}s below minimum ${CONFIG.MIN_DURATION}s (idle safety)`
        );
        return null;
    }

    if (finalizedTracks.has(trackKey)) {
        console.log(`   ⏳ Track "${trackTitle}" already finalized for ${username}, skipping.`);
        return null;
    }

    if (seekInvalidatedTracks.has(trackKey)) {
        console.log(`   ⛔ Track "${trackTitle}" invalidated by previous seek for ${username}.`);
        return null;
    }

    const position = getCurrentPosition(track);
    let isComplete = false;

    if (duration > 0) {
        const remaining = duration - position;
        if (duration >= CONFIG.MIN_DURATION && remaining <= 10) {
            console.log(`   ✅ Track assumed completed (${remaining}s remaining before idle) (user: ${username})`);
            isComplete = true;
        } else if ((position / duration) >= CONFIG.COMPLETION_THRESHOLD) {
            isComplete = true;
        } else {
            console.log(`   ⏳ Track not completed (${Math.round(position/duration*100)}%) — not finalizing. (user: ${username})`);
            return null;
        }
    } else {
        if (!isTrackCompleted(track)) {
            console.log(`   ⏳ Track not completed — not finalizing.`);
            return null;
        }
        isComplete = true;
    }

    if (!isComplete) {
        console.log(`   ⏳ Track not completed — not finalizing.`);
        return null;
    }

    console.log(`   ✅ Track "${trackTitle}" auto-finalized (idle timeout) (user: ${username}).`);

    const dailyCheck = checkDailyLimit(username);
    if (!dailyCheck.passed) {
        console.log(`   ⛔ ${dailyCheck.reason}`);
        return null;
    }

    const trackLimitCheck = checkTrackLimit(username, trackId, trackTitle);
    if (!trackLimitCheck.passed) {
        console.log(`   ⛔ ${trackLimitCheck.reason}`);
        return null;
    }

    const intervalCheck = checkInterval(username);
    if (!intervalCheck.passed) {
        console.log(`   ⛔ ${intervalCheck.reason}`);
        return null;
    }

    const passportCheck = await checkPassport(walletAddress);
    if (!passportCheck.passed) {
        console.log(`   ⛔ ${passportCheck.reason}`);
        return null;
    }

    recordPlay(walletAddress, trackTitle, artist, trackId, username);
    console.log(`   ✅ All filters passed! (${trackLimitCheck.count + 1}/${CONFIG.MAX_REWARD_PER_TRACK_PER_DAY} for this track today)`);

    finalizedTracks.add(trackKey);
    seekInvalidatedTracks.delete(trackKey);
    resetTrackState(username);

    return { passed: true, trackTitle, artist, trackId };
}

function resetIdleCounter() {}

module.exports = {
    CONFIG,
    processTrack,
    recordPlay,
    loadHistory,
    resetIdleCounter,
    getUTCDate,
    getCurrentTrack: (username) => {
        const state = getState(username);
        return state.currentTrack;
    },
    getActiveUsers,
    resetTrackState,
    finalizeTrackOnIdle,
};