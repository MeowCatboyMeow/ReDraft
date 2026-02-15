const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const MODULE_NAME = 'redraft';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY_SIZE_BYTES = 512 * 1024; // 512 KB

let cachedConfig = null;

/**
 * Read and cache config from disk.
 * @returns {object|null} The config object or null if not configured.
 */
function readConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            return null;
        }
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        cachedConfig = JSON.parse(raw);
        return cachedConfig;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to read config:`, err.message);
        return null;
    }
}

/**
 * Mask an API key for safe display.
 * @param {string} key
 * @returns {string}
 */
function maskKey(key) {
    if (!key || key.length < 8) return '****';
    return key.slice(0, 3) + '...' + key.slice(-4);
}

/**
 * Sanitize error messages to strip any credential fragments.
 * @param {string} message
 * @returns {string}
 */
function sanitizeError(message) {
    const config = cachedConfig;
    if (config && config.apiKey && message.includes(config.apiKey)) {
        message = message.replace(new RegExp(config.apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
    }
    return message;
}

/**
 * Initialize the ReDraft server plugin.
 * @param {import('express').Router} router
 */
async function init(router) {
    // Load config on startup
    readConfig();

    // Watch config file for changes
    const configDir = path.dirname(CONFIG_PATH);
    fs.watch(configDir, (eventType, filename) => {
        if (filename === 'config.json') {
            console.log(`[${MODULE_NAME}] Config file changed, reloading...`);
            readConfig();
        }
    });

    /**
     * POST /config — Save API credentials to disk.
     * Accepts: { apiUrl, apiKey, model, maxTokens? }
     */
    router.post('/config', (req, res) => {
        try {
            const { apiUrl, apiKey, model, maxTokens } = req.body;

            // Validate required fields
            if (!apiUrl || typeof apiUrl !== 'string' || !apiUrl.trim()) {
                return res.status(400).json({ error: 'apiUrl is required and must be a non-empty string' });
            }
            if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
                return res.status(400).json({ error: 'apiKey is required and must be a non-empty string' });
            }
            if (!model || typeof model !== 'string' || !model.trim()) {
                return res.status(400).json({ error: 'model is required and must be a non-empty string' });
            }

            const config = {
                apiUrl: apiUrl.trim().replace(/\/+$/, ''), // Strip trailing slashes
                apiKey: apiKey.trim(),
                model: model.trim(),
                maxTokens: Number(maxTokens) || 4096,
            };

            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
            cachedConfig = config;

            console.log(`[${MODULE_NAME}] Config saved successfully`);
            return res.json({ ok: true });
        } catch (err) {
            console.error(`[${MODULE_NAME}] Error saving config:`, err.message);
            return res.status(500).json({ error: 'Failed to save configuration' });
        }
    });

    /**
     * GET /status — Return plugin status (no secrets exposed).
     */
    router.get('/status', (req, res) => {
        const config = readConfig();
        if (!config || !config.apiKey || !config.apiUrl) {
            return res.json({
                configured: false,
                apiUrl: null,
                model: null,
                maskedKey: null,
            });
        }

        return res.json({
            configured: true,
            apiUrl: config.apiUrl,
            model: config.model || null,
            maskedKey: maskKey(config.apiKey),
        });
    });

    /**
     * POST /refine — Proxy refinement request to configured LLM.
     * Accepts: { messages: [{role, content}] }
     * Returns: { text: string }
     */
    router.post('/refine', async (req, res) => {
        try {
            // Check body size
            const bodySize = JSON.stringify(req.body).length;
            if (bodySize > MAX_BODY_SIZE_BYTES) {
                return res.status(413).json({ error: 'Request body too large' });
            }

            // Validate messages
            const { messages } = req.body;
            if (!Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ error: 'messages must be a non-empty array' });
            }

            for (const msg of messages) {
                if (!msg.role || typeof msg.role !== 'string') {
                    return res.status(400).json({ error: 'Each message must have a string "role"' });
                }
                if (!msg.content || typeof msg.content !== 'string') {
                    return res.status(400).json({ error: 'Each message must have a string "content"' });
                }
            }

            // Read config
            const config = readConfig();
            if (!config || !config.apiKey || !config.apiUrl) {
                return res.status(503).json({ error: 'ReDraft is not configured. Please set up API credentials.' });
            }

            // Build request to LLM
            const endpoint = `${config.apiUrl}/chat/completions`;
            const payload = {
                model: config.model,
                messages: messages,
                max_tokens: config.maxTokens || 4096,
                temperature: 0.3, // Low temp for consistent refinement
            };

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errorBody = await response.text();
                const sanitized = sanitizeError(errorBody);
                console.error(`[${MODULE_NAME}] LLM API error (${response.status}):`, sanitized);
                return res.status(502).json({ error: `LLM API returned ${response.status}: ${sanitized.slice(0, 200)}` });
            }

            const data = await response.json();
            const text = data?.choices?.[0]?.message?.content;

            if (!text) {
                return res.status(502).json({ error: 'LLM returned an empty or malformed response' });
            }

            return res.json({ text });

        } catch (err) {
            if (err.name === 'AbortError') {
                console.error(`[${MODULE_NAME}] LLM request timed out after ${REQUEST_TIMEOUT_MS}ms`);
                return res.status(504).json({ error: 'LLM request timed out' });
            }
            console.error(`[${MODULE_NAME}] Refine error:`, sanitizeError(err.message));
            return res.status(500).json({ error: 'Internal error during refinement' });
        }
    });

    console.log(`[${MODULE_NAME}] Plugin loaded. Config ${cachedConfig ? 'found' : 'not found — configure via UI'}.`);
}

async function exit() {
    console.log(`[${MODULE_NAME}] Plugin unloaded.`);
}

module.exports = {
    init,
    exit,
    info: {
        id: 'redraft',
        name: 'ReDraft',
        description: 'Server-side proxy for ReDraft message refinement. Securely stores API credentials and proxies refinement requests to a separate LLM.',
    },
};
