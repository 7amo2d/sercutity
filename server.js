const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Secure In-Memory Active Sessions Store
const activeSessions = new Map();

// High-Performance Rate Limiter Guard
const rateLimitMap = new Map();
function rateLimitGuard(req, res, next) {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    
    if (rateLimitMap.has(clientIp)) {
        const lastReq = rateLimitMap.get(clientIp);
        if (now - lastReq < 800) {
            return res.status(429).json({
                success: false,
                error: 'تنبيه الأمان: تم رصد طلبات متكررة. يرجى التمهل لحماية حسابك.'
            });
        }
    }
    rateLimitMap.set(clientIp, now);
    next();
}

function sanitizeToken(token) {
    if (!token) return null;
    const clean = token.trim().replace(/^Bot\s+/i, '').replace(/["']/g, '');
    if (clean.length < 25) return null;
    return clean;
}

function getTokenFingerprint(token) {
    return crypto.createHash('sha256').update(token).digest('hex').substring(0, 16);
}

function resolveDiscordAsset(url) {
    if (!url) return null;
    const clean = url.trim();
    if (clean.startsWith('mp:external/')) return clean;
    if (clean.startsWith('http://') || clean.startsWith('https://')) {
        return 'mp:external/' + clean.replace(/^https?:\/\//, '');
    }
    return clean;
}

// Fast Account Token Verification Endpoint
app.post('/api/verify-token', rateLimitGuard, async (req, res) => {
    const { token } = req.body;
    const cleanToken = sanitizeToken(token);
    if (!cleanToken) {
        return res.status(400).json({ success: false, error: 'رمز الحساب غير صالح.' });
    }

    try {
        const response = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { 'Authorization': cleanToken }
        });

        if (!response.ok) {
            return res.status(401).json({ success: false, error: 'رمز الحساب غير صحيح أو منتهي الصلاحية.' });
        }

        const userData = await response.json();
        const avatarUrl = userData.avatar 
            ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.${userData.avatar.startsWith('a_') ? 'gif' : 'png'}?size=256`
            : 'https://cdn.discordapp.com/embed/avatars/0.png';

        const bannerUrl = userData.banner 
            ? `https://cdn.discordapp.com/banners/${userData.id}/${userData.banner}.${userData.banner.startsWith('a_') ? 'gif' : 'png'}?size=600`
            : null;

        return res.json({
            success: true,
            account: {
                id: userData.id,
                username: userData.username,
                globalName: userData.global_name || userData.username,
                discriminator: userData.discriminator,
                avatar: avatarUrl,
                banner: bannerUrl,
                accentColor: userData.accent_color ? `#${userData.accent_color.toString(16).padStart(6, '0')}` : '#5865f2'
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'تعذر الاتصال بخوادم ديسكورد للفحص.' });
    }
});

// Live Presence Deployment Endpoint
app.post('/api/start-presence', rateLimitGuard, (req, res) => {
    const { 
        token, type, name, streamUrl, details, state, 
        largeImg, largeTxt, smallImg, smallTxt, 
        btn1Text, btn1Url, btn2Text, btn2Url, 
        customStartTime, partyCurrent, partyMax,
        showTimestamp
    } = req.body;

    const cleanToken = sanitizeToken(token);
    if (!cleanToken) {
        return res.status(400).json({ success: false, error: 'رمز الحساب غير صالح.' });
    }

    const fingerprint = getTokenFingerprint(cleanToken);
    let conflictInfo = null;

    if (activeSessions.has(fingerprint)) {
        const oldSession = activeSessions.get(fingerprint);
        conflictInfo = `تم تحديث النشاط بنجاح واستبدال الوضع القديم (${oldSession.type}) بالوضع الجديد (${type}).`;
        try {
            oldSession.ws.close(1000, 'Replaced by user request');
            if (oldSession.heartbeat) clearInterval(oldSession.heartbeat);
        } catch (e) {}
        activeSessions.delete(fingerprint);
    }

    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    let heartbeatInterval = null;
    const sessionData = { ws, startTime: Date.now(), type, fingerprint };

    ws.on('open', () => {});

    ws.on('message', (data) => {
        try {
            const payload = JSON.parse(data);
            if (payload.op === 10) {
                const interval = payload.d.heartbeat_interval;
                heartbeatInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ op: 1, d: null }));
                    }
                }, interval);
                sessionData.heartbeat = heartbeatInterval;

                let typeCode = 0;
                if (type === 'COMPETING') typeCode = 5;
                if (type === 'LISTENING') typeCode = 2;
                if (type === 'WATCHING') typeCode = 3;
                if (type === 'PLAYING') typeCode = 0;
                if (type === 'STREAMING') typeCode = 1;
                if (type === 'VR') typeCode = 0;

                let startTimestamp = Date.now();
                if (customStartTime && !isNaN(parseInt(customStartTime))) {
                    startTimestamp = parseInt(customStartTime);
                }

                const activity = {
                    name: name || 'Titan Engine',
                    type: typeCode
                };

                if (showTimestamp !== false) {
                    activity.timestamps = { start: startTimestamp };
                }

                if (type === 'VR') {
                    activity.name = name || 'VRChat';
                    activity.application_id = "109204093820921038";
                    activity.platform = "meta_quest";
                    activity.flags = 1;
                }

                if (type === 'STREAMING' && streamUrl) {
                    activity.url = streamUrl;
                }

                if (details) activity.details = details;
                if (state) activity.state = state;

                const assets = {};
                if (largeImg) assets.large_image = resolveDiscordAsset(largeImg);
                if (largeTxt) assets.large_text = largeTxt;
                if (smallImg) assets.small_image = resolveDiscordAsset(smallImg);
                if (smallTxt) assets.small_text = smallTxt;
                if (Object.keys(assets).length > 0) activity.assets = assets;

                if (partyCurrent && partyMax && !isNaN(parseInt(partyCurrent)) && !isNaN(parseInt(partyMax))) {
                    activity.party = {
                        id: 'squad_party_' + Date.now(),
                        size: [parseInt(partyCurrent), parseInt(partyMax)]
                    };
                }

                const buttons = [];
                if (btn1Text && btn1Url) buttons.push({ label: btn1Text, url: btn1Url });
                if (btn2Text && btn2Url) buttons.push({ label: btn2Text, url: btn2Url });
                if (buttons.length > 0) {
                    activity.buttons = buttons;
                    activity.metadata = { button_urls: buttons.map(b => b.url) };
                }

                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: cleanToken,
                        properties: { os: 'windows', browser: 'Discord Client', device: 'Desktop' },
                        presence: {
                            since: Date.now(),
                            activities: [activity],
                            status: 'online',
                            afk: false
                        },
                        intents: 0
                    }
                }));
            }
        } catch (err) {}
    });

    ws.on('close', () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        activeSessions.delete(fingerprint);
    });

    ws.on('error', () => {});

    activeSessions.set(fingerprint, sessionData);
    res.json({ 
        success: true, 
        message: conflictInfo ? conflictInfo : `تم تفعيل وضع (${type}) بنجاح على حسابك!` 
    });
});

app.post('/api/stop-presence', rateLimitGuard, (req, res) => {
    const { token } = req.body;
    const cleanToken = sanitizeToken(token);
    if (!cleanToken) return res.status(400).json({ success: false, error: 'الرمز غير صالح.' });

    const fingerprint = getTokenFingerprint(cleanToken);

    if (activeSessions.has(fingerprint)) {
        const session = activeSessions.get(fingerprint);
        try {
            session.ws.close(1000, 'User stop requested');
            if (session.heartbeat) clearInterval(session.heartbeat);
        } catch (e) {}
        activeSessions.delete(fingerprint);
        return res.json({ success: true, message: 'تم إيقاف النشاط وإعادة الحساب للوضع الطبيعي.' });
    }
    res.status(404).json({ success: false, error: 'لا يوجد نشاط شغال حالياً لهذا الحساب.' });
});

app.get('/api/status', (req, res) => {
    res.json({ 
        status: 'online', 
        active: activeSessions.size, 
        version: 'v2.2.1',
        powered_by: 'Powered By TC Team - 7amo' 
    });
});

app.listen(PORT, () => {
    console.log(`Titan Engine v2.2.1 Active on port ${PORT} | Powered By TC Team - 7amo`);
});