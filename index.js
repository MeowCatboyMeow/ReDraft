/**
 * ReDraft — SillyTavern Message Refinement Extension
 *
 * Refines completed AI messages by sending them (with quality rules)
 * to an LLM. Supports two modes:
 *   - "st" mode: Uses SillyTavern's built-in generateRaw() (no plugin needed)
 *   - "plugin" mode: Proxies through a server plugin to a separate LLM
 */

const MODULE_NAME = 'redraft';
const PLUGIN_BASE = '/api/plugins/redraft';
const LOG_PREFIX = '[ReDraft]';


// ─── Default Settings ───────────────────────────────────────────────

const defaultSettings = Object.freeze({
    enabled: true,
    autoRefine: false,
    connectionMode: 'st', // 'st' or 'plugin'
    builtInRules: {
        grammar: true,
        echo: true,
        repetition: true,
        voice: true,
        prose: true,
        formatting: true,
        ending: false,   // opinionated — off by default
        lore: false,     // needs rich character context
    },
    customRules: [],
    systemPrompt: '',
    showDiffAfterRefine: true,
    pov: 'auto', // 'auto' | 'detect' | '1st' | '1.5' | '2nd' | '3rd'
    hasSeenHint: false,
});

const POV_LABELS = {
    auto: 'Auto (no instruction)',
    detect: 'Detect from message',
    '1st': '1st person (I/me)',
    '1.5': '1.5th person (I + you)',
    '2nd': '2nd person (you)',
    '3rd': '3rd person (he/she/they)',
};

const POV_INSTRUCTIONS = {
    '1st': 'The message is written in first person (I/me/my). Maintain this perspective exactly \u2014 do not shift to second or third person.',
    '1.5': 'The message uses 1.5th-person PoV: first person (I/me/my) for the AI character\'s perspective, and second person (you/your) when referring to the player\'s character. Maintain this hybrid perspective exactly.',
    '2nd': 'The message is written in second person (you/your). Maintain this perspective exactly \u2014 do not shift to first or third person.',
    '3rd': 'The message is written in third person (he/she/they + character names). Maintain this perspective exactly \u2014 do not shift to first or second person.',
};

const BUILTIN_RULES = {
    grammar: {
        label: 'Fix grammar & spelling',
        prompt: 'Fix grammatical errors, spelling mistakes, and awkward phrasing. Do not alter intentional dialect, slang, verbal tics, or character-specific speech patterns \u2014 only correct genuine errors. Preserve intentional sentence fragments used for rhythm or voice.',
    },
    echo: {
        label: 'Remove echo & restatement',
        prompt: 'Using the "Last user message" from context above, scan for sentences where the character restates, paraphrases, or references the user\'s previous message instead of advancing the scene.\n\nBANNED patterns \u2014 if the sentence matches, cut and replace with forward motion:\n1. Character speaks ABOUT what user said/did (any tense): "You\'re asking me to..." / "You said..." / "You want me to..."\n2. "That/this" referring to user\'s input: "That\'s not what you..." / "This is about..."\n3. Reframing: "Not [user\'s word] \u2014 [character\'s word]." / "In other words..."\n4. Processing narration: "Your words [verb]..." (hung, landed, settled) / Character processing what user said / Italicized replays of user\'s dialogue as character thought.\n\nCheck the WHOLE response, not just the opening. Replace cut content with character action \u2014 what they do next, not what they think about what was said. One-word acknowledgment permitted ("Yeah." / nod), then forward.',
    },
    repetition: {
        label: 'Reduce repetition',
        prompt: 'Using the "Previous response ending" from context above, scan for repetitive elements within this response AND compared to the previous response:\n1. Repeated physical actions: Same gesture appearing twice+ (crossing arms, sighing, looking away). Replace the second instance with a different physical expression.\n2. Repeated sentence structures: Same openings, same punctuation patterns, same metaphor family used twice+.\n3. Repeated emotional beats: Character hitting the same note twice without progression. If angry twice, the second should be a different texture.\n\nDo NOT remove intentional repetition for rhetorical effect (anaphora, callbacks, echoed dialogue). Only flag mechanical/unconscious repetition.',
    },
    voice: {
        label: 'Maintain character voice',
        prompt: 'Using the "Character" context provided above, verify each character\'s dialogue is distinct and consistent:\n1. Speech patterns: If a character uses contractions, slang, verbal tics, or specific vocabulary \u2014 preserve them. Do not polish rough speech into grammatically correct prose.\n2. Voice flattening: If multiple characters speak, their dialogue should sound different. Flag if all characters use the same register or vocabulary level.\n3. Register consistency: A casual character shouldn\'t suddenly become eloquent mid-scene (unless that shift IS the point).\n\nDo not homogenize dialogue. A character\'s voice is more important than technically "correct" writing.',
    },
    prose: {
        label: 'Clean up prose',
        prompt: 'Scan for common AI prose weaknesses. Per issue found, make the minimum surgical fix:\n1. Somatic clich\u00e9s: "breath hitched/caught," "heart skipped/clenched," "stomach dropped/tightened," "shiver down spine." Replace with plain statement or specific physical detail.\n2. Purple prose: "Velvety voice," "liquid tone," "fluid grace," "pregnant pause," cosmic melodrama. Replace with concrete, grounded language.\n3. Filter words: "She noticed," "he felt," "she realized." Cut the filter \u2014 go direct.\n4. Telling over showing: "She felt sad" / "He was angry." Replace with embodied reactions ONLY if the telling is genuinely weaker.\n\nDo NOT over-edit. If prose is functional and voice-consistent, leave it alone. This rule targets clear weaknesses, not style preferences.',
    },
    formatting: {
        label: 'Fix formatting',
        prompt: 'Ensure consistent formatting within the response\'s existing convention:\n1. Fix orphaned formatting marks (unclosed asterisks, mismatched quotes, broken tags)\n2. Fix inconsistent style (mixing *asterisks* and _underscores_ for the same purpose)\n3. Ensure dialogue punctuation is consistent with the established convention\n\nDo not change the author\'s chosen formatting convention \u2014 only correct errors within it.',
    },
    ending: {
        label: 'Fix crafted endings',
        prompt: 'Check if the response ends with a "dismount" \u2014 a crafted landing designed to feel like an ending rather than a mid-scene pause.\n\nDISMOUNT patterns to fix:\n1. Dialogue payload followed by physical stillness: "Her thumb rested on his pulse." \u2014 body part + state verb + location as final beat.\n2. Fragment clusters placed after dialogue for weight: "One beat." / "Counting." / "Still."\n3. Summary narration re-describing the emotional state of the scene.\n4. Poetic/philosophical final line \u2014 theatrical closing statements.\n5. Double dismount: two landing constructions stacked.\n\nFIX: Find the last line of dialogue or action with unresolved consequences. Cut everything after it. If the response has no dialogue (pure narration/action), find the last action with unresolved consequences and cut any stillness or summary after it. The response should end mid-scene.\n\nEXCEPTION: If the scene is genuinely concluding (location change, time skip, departure), one clean landing beat is permitted.',
    },
    lore: {
        label: 'Maintain lore consistency',
        prompt: 'Using the "Character" context provided above, flag only glaring contradictions with established character/world information. Examples: wrong eye color, wrong relationship status, referencing events that didn\'t happen, contradicting established abilities.\n\nDo not invent new lore. When uncertain, preserve the original phrasing rather than "correcting" it. Minor ambiguities are not errors.',
    },
};

const DEFAULT_SYSTEM_PROMPT = `You are a roleplay prose editor. You refine AI-generated roleplay messages by applying specific rules while preserving the author's creative intent.

Core principles:
- Preserve the original meaning, narrative direction, and emotional tone
- Preserve the original paragraph structure and sequence of events \u2014 do not reorder content, merge paragraphs, or restructure the narrative flow
- Edits are surgical: change the minimum necessary to satisfy the active rules. Fix the violating sentence, not the paragraph around it
- Keep approximately the same length unless a rule specifically calls for cuts
- Do not add new story elements, actions, or dialogue not present in the original
- Do not censor, sanitize, or tone down content \u2014 the original's maturity level is intentional
- Maintain existing formatting conventions (e.g. *asterisks for actions*, "quotes for dialogue")
- Treat each character as a distinct voice \u2014 do not flatten dialogue into a single register
- When rules conflict, character voice and narrative intent take priority over technical polish

Output format (MANDATORY \u2014 always follow this structure):
1. First, output a changelog inside [CHANGELOG]...[/CHANGELOG] tags listing each change you made and which rule motivated it. One line per change. If a rule required no changes, omit it.
2. Then output the full refined message inside [REFINED]...[/REFINED] tags with no other commentary.

Example:
[CHANGELOG]
- Grammar: Fixed \"their\" \u2192 \"they're\" in paragraph 2
- Repetition: Replaced 3rd use of \"softly\" with \"gently\"
[/CHANGELOG]
[REFINED]
(refined message here)
[/REFINED]

Do NOT output any analysis, reasoning, or commentary outside the tags. Only output the two tagged blocks.

You will be given the original message, a set of refinement rules to apply, and optionally context about the characters and recent conversation. Apply the rules faithfully.`;

// ─── State ──────────────────────────────────────────────────────────

let isRefining = false; // Re-entrancy guard
let pluginAvailable = false; // Whether server plugin is reachable
let eventListenerRefs = {}; // For cleanup

// Global keydown handler for ESC
function onGlobalKeydown(e) {
    if (e.key !== 'Escape') return;
    // Close diff popup first (higher z-index)
    const diffOverlay = document.getElementById('redraft_diff_overlay');
    if (diffOverlay) { closeDiffPopup(); return; }
    // Then close popout
    const popout = document.getElementById('redraft_popout_panel');
    if (popout && popout.style.display !== 'none') { popout.style.display = 'none'; }
}
document.addEventListener('keydown', onGlobalKeydown);

// ─── Helpers ────────────────────────────────────────────────────────

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    const { lodash } = SillyTavern.libs;
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    } else {
        extensionSettings[MODULE_NAME] = lodash.merge(
            structuredClone(defaultSettings),
            extensionSettings[MODULE_NAME],
        );
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

/**
 * Compile active rules into a numbered list string.
 */
function compileRules(settings) {
    const rules = [];

    // Built-in rules — emit detailed prompts, not labels
    for (const [key, rule] of Object.entries(BUILTIN_RULES)) {
        if (settings.builtInRules[key]) {
            rules.push(rule.prompt);
            console.debug(`${LOG_PREFIX} [rules] Built-in ON: ${key}`);
        } else {
            console.debug(`${LOG_PREFIX} [rules] Built-in OFF: ${key}`);
        }
    }

    // Custom rules in order
    for (let i = 0; i < settings.customRules.length; i++) {
        const rule = settings.customRules[i];
        if (rule.enabled && rule.text && rule.text.trim()) {
            rules.push(rule.text.trim());
            console.debug(`${LOG_PREFIX} [rules] Custom #${i} ON: "${rule.text.trim().substring(0, 80)}${rule.text.trim().length > 80 ? '…' : ''}"`);
        } else {
            console.debug(`${LOG_PREFIX} [rules] Custom #${i} SKIPPED (enabled=${rule.enabled}, text=${JSON.stringify(rule.text?.substring?.(0, 40) || rule.text)})`);
        }
    }

    if (rules.length === 0) {
        rules.push('Improve the overall quality of the message');
        console.debug(`${LOG_PREFIX} [rules] No active rules — using fallback`);
    }

    const compiled = rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
    console.debug(`${LOG_PREFIX} [rules] Compiled ${rules.length} rules total`);
    return compiled;
}

/**
 * Strip structured content from text, replacing with placeholders.
 * Protects code fences, HTML/XML tags, and bracket-delimited blocks
 * from being mangled by the refinement LLM.
 * Returns { stripped, blocks } where blocks is the array of original content.
 */
function stripProtectedBlocks(text) {
    const blocks = [];
    let result = text;

    // 1. Code fences: ```...``` (with or without language tag)
    result = result.replace(/```[\s\S]*?```/g, (match) => {
        blocks.push(match);
        return `[PROTECTED_${blocks.length - 1}]`;
    });

    // 2. HTML block-level elements only (not inline formatting like em, span, b, i)
    //    Protects: details, div, table, section, aside, article, nav, pre, fieldset, figure
    //    Also protects custom/extension elements (tags with hyphens or underscores, e.g. <sim-tracker>, <lumia_ooc>)
    const blockTags = 'details|div|table|section|aside|article|nav|pre|fieldset|figure';
    const blockRegex = new RegExp(
        `<((?:${blockTags}|\\w+[-_]\\w[\\w-]*))(\\b[^>]*)>[\\s\\S]*?<\\/\\1>`, 'gi'
    );
    result = result.replace(blockRegex, (match) => {
        blocks.push(match);
        return `[PROTECTED_${blocks.length - 1}]`;
    });

    // 3. Bracket-delimited blocks: [TAG]...[/TAG]
    result = result.replace(/\[([A-Z_]+)\][\s\S]*?\[\/\1\]/gi, (match, tag) => {
        // Don't strip our own CHANGELOG or PROTECTED tags
        if (tag.toUpperCase() === 'CHANGELOG' || tag.toUpperCase().startsWith('PROTECTED')) return match;
        blocks.push(match);
        return `[PROTECTED_${blocks.length - 1}]`;
    });

    return { stripped: result, blocks };
}

/**
 * Restore protected blocks from placeholders.
 */
function restoreProtectedBlocks(text, blocks) {
    // Replace placeholders that the LLM kept intact
    let result = text.replace(/\[PROTECTED_(\d+)\]/g, (_, idx) => {
        return blocks[parseInt(idx, 10)] || '';
    });

    // Safety net: if the LLM dropped any placeholders, append the missing content
    // so protected blocks are never permanently lost
    for (let i = 0; i < blocks.length; i++) {
        if (!text.includes(`[PROTECTED_${i}]`)) {
            result = result + '\n' + blocks[i];
        }
    }

    return result;
}

/**
 * Parse the LLM response, extracting changelog and refined message.
 * Returns { changelog, refined }.
 *
 * Extraction priority:
 *   1. [REFINED]...[/REFINED] tags — positive extraction, ignores all reasoning
 *   2. [CHANGELOG]...[/CHANGELOG] tags — takes text after the block
 *   3. Fallback — uses entire response as refined text
 */
function parseChangelog(responseText) {
    let changelog = null;
    let refined;

    // Priority 1: Look for [REFINED]...[/REFINED] — most reliable
    const refinedMatch = responseText.match(/\[REFINED\]\s*([\s\S]*?)\s*\[\/REFINED\]/i);
    if (refinedMatch) {
        refined = refinedMatch[1].trim();
        // Also extract changelog if present
        const changelogMatch = responseText.match(/\[CHANGELOG\]\s*([\s\S]*?)\s*\[\/CHANGELOG\]/i);
        changelog = changelogMatch ? changelogMatch[1].trim() : null;
    } else {
        // Priority 2: [CHANGELOG]...[/CHANGELOG] — take only text after the block
        let match = responseText.match(/\[CHANGELOG\]\s*([\s\S]*?)\s*\[\/CHANGELOG\]/i);
        if (match) {
            changelog = match[1].trim();
            refined = responseText.substring(match.index + match[0].length).trim();
        } else {
            // Priority 3: Unclosed [CHANGELOG] tag — split on double-newline
            match = responseText.match(/\[CHANGELOG\]\s*([\s\S]*?)$/i);
            if (match) {
                const remainder = match[1];
                const splitIdx = remainder.search(/\n\s*\n/);
                if (splitIdx !== -1) {
                    changelog = remainder.substring(0, splitIdx).trim();
                    refined = remainder.substring(splitIdx).trim();
                }
            }
        }
    }

    // Fallback
    if (!refined) {
        refined = responseText.trim();
    }

    // Always strip any leftover tag markers from the refined text
    refined = refined.replace(/\[\/?(?:REFINED|CHANGELOG)\]/gi, '').trim();

    return { changelog, refined };
}

/**
 * Detect the PoV of a text by checking pronoun frequency.
 * Returns '1st' | '1.5' | '2nd' | '3rd' or null if unclear.
 */
function detectPov(text) {
    const lower = text.toLowerCase();
    const first = (lower.match(/\b(i|me|my|myself|mine)\b/g) || []).length;
    const second = (lower.match(/\b(you|your|yours|yourself)\b/g) || []).length;
    const third = (lower.match(/\b(he|she|they|him|her|them|his|hers|their|theirs)\b/g) || []).length;

    const total = first + second + third;
    if (total < 3) return null; // Too short to detect

    // 1.5th: significant first AND second person
    if (first > total * 0.2 && second > total * 0.2) return '1.5';
    if (first > second && first > third) return '1st';
    if (second > first && second > third) return '2nd';
    if (third > first && third > second) return '3rd';
    return null;
}

/**
 * Call the server plugin API.
 */
async function pluginRequest(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    const response = await fetch(`${PLUGIN_BASE}${endpoint}`, options);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || `Server returned ${response.status}`);
    }
    return data;
}

// ─── Plugin Status ──────────────────────────────────────────────────

async function checkPluginStatus() {
    try {
        const status = await pluginRequest('/status');
        pluginAvailable = true;
        updateStatusDot(status.configured);
        updateConnectionInfo(status);
        updatePluginBanner();
        return status;
    } catch {
        pluginAvailable = false;
        updateStatusDot(false, true);
        updateConnectionInfo(null);
        updatePluginBanner();
        return null;
    }
}

function updateStatusDot(configured, error = false) {
    const dot = document.getElementById('redraft_status_dot');
    if (!dot) return;
    const settings = getSettings();

    dot.classList.remove('connected', 'error');

    if (settings.connectionMode === 'st') {
        dot.classList.add('connected');
        dot.title = 'Using ST connection';
    } else if (error || !pluginAvailable) {
        dot.classList.add('error');
        dot.title = 'Server plugin unavailable';
    } else if (configured) {
        dot.classList.add('connected');
        dot.title = 'Connected';
    } else {
        dot.title = 'Not configured';
    }
}

function updateConnectionInfo(status) {
    const info = document.getElementById('redraft_connection_info');
    if (!info) return;
    if (!pluginAvailable) {
        info.textContent = 'Plugin unavailable';
    } else if (status?.configured) {
        info.textContent = `${status.model} (${status.maskedKey})`;
    } else {
        info.textContent = 'Not configured';
    }
}

function updatePluginBanner() {
    const banner = document.getElementById('redraft_plugin_banner');
    if (!banner) return;
    const settings = getSettings();

    // Show banner if in ST mode and plugin is not available
    if (settings.connectionMode === 'st' && !pluginAvailable) {
        banner.style.display = '';
    } else {
        banner.style.display = 'none';
    }
}

function updateConnectionModeUI() {
    const settings = getSettings();
    const pluginFields = document.getElementById('redraft_plugin_fields');
    const stModeInfo = document.getElementById('redraft_st_mode_info');

    if (pluginFields) {
        pluginFields.style.display = settings.connectionMode === 'plugin' ? '' : 'none';
    }
    if (stModeInfo) {
        stModeInfo.style.display = settings.connectionMode === 'st' ? '' : 'none';
    }

    updateStatusDot(null);
    updatePluginBanner();
}

// ─── Core Refinement (Dual-Mode) ────────────────────────────────────

/**
 * Send refinement request via ST's generateRaw().
 */
async function refineViaST(promptText, systemPrompt) {
    const { generateRaw } = SillyTavern.getContext();
    if (typeof generateRaw !== 'function') {
        throw new Error('generateRaw is not available in this version of SillyTavern');
    }

    const result = await generateRaw({ prompt: promptText, systemPrompt: systemPrompt });

    if (!result || typeof result !== 'string' || !result.trim()) {
        throw new Error('ST generated an empty response');
    }

    return result.trim();
}

/**
 * Send refinement request via server plugin.
 */
async function refineViaPlugin(promptText, systemPrompt) {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: promptText },
    ];

    const result = await pluginRequest('/refine', 'POST', { messages });

    if (!result.text || !result.text.trim()) {
        throw new Error('Plugin returned an empty response');
    }

    return result.text.trim();
}

/**
 * Refine a message at the given index.
 * @param {number} messageIndex Index in context.chat
 */
async function redraftMessage(messageIndex) {
    if (isRefining) {
        console.debug(`${LOG_PREFIX} Already refining, skipping`);
        return;
    }

    const context = SillyTavern.getContext();
    const { chat, saveChat, chatMetadata, saveMetadata } = context;

    if (!chat || messageIndex < 0 || messageIndex >= chat.length) {
        toastr.error('Invalid message index', 'ReDraft');
        return;
    }

    const message = chat[messageIndex];
    if (!message || !message.mes) {
        toastr.error('Message has no text content', 'ReDraft');
        return;
    }

    const settings = getSettings();

    // Check if plugin mode is selected but plugin is unavailable
    if (settings.connectionMode === 'plugin' && !pluginAvailable) {
        toastr.error('Server plugin is not available. Switch to ST mode or install the plugin.', 'ReDraft');
        return;
    }

    // Set re-entrancy guard
    isRefining = true;
    setPopoutTriggerLoading(true);

    // Clean up stale undo/diff buttons from prior refinement of this message
    // (fixes compare showing wrong diff after swiping in auto mode)
    hideUndoButton(messageIndex);
    hideDiffButton(messageIndex);

    // Show loading state on the message button + toast
    setMessageButtonLoading(messageIndex, true);
    toastr.info('Refining message\u2026', 'ReDraft');

    try {
        // Save original to chatMetadata for undo
        if (!chatMetadata['redraft_originals']) {
            chatMetadata['redraft_originals'] = {};
        }
        chatMetadata['redraft_originals'][messageIndex] = message.mes;
        await saveMetadata();

        // Strip structured content (code fences, HTML, bracket blocks) before sending to LLM
        const { stripped: strippedMessage, blocks: protectedBlocks } = stripProtectedBlocks(message.mes);

        // Build the refinement prompt
        const rulesText = compileRules(settings);
        const systemPrompt = settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

        // Gather context for the LLM
        const contextParts = [];
        const char = context.characters?.[context.characterId];
        const charDesc = char?.data?.personality
            || char?.data?.description?.substring(0, 500)
            || '';
        if (context.name2 || charDesc) {
            contextParts.push(`Character: ${context.name2 || 'Unknown'}${charDesc ? ' \u2014 ' + charDesc : ''}`);
        }
        if (context.name1) {
            contextParts.push(`User character: ${context.name1}`);
        }

        // Point of view instruction
        let povKey = settings.pov || 'auto';
        if (povKey === 'detect') {
            const detected = detectPov(strippedMessage);
            if (detected) {
                povKey = detected;
                console.debug(`${LOG_PREFIX} Detected PoV: ${detected}`);
            } else {
                povKey = 'auto'; // Couldn't detect, skip instruction
            }
        }
        if (povKey !== 'auto' && POV_INSTRUCTIONS[povKey]) {
            contextParts.push(`Point of view: ${POV_INSTRUCTIONS[povKey]}`);
        }

        // Last user message (for echo detection)
        const lastUserMsg = [...chat].reverse().find(m => m.is_user && m.mes);
        if (lastUserMsg) {
            contextParts.push(`Last user message:\n${lastUserMsg.mes}`);
        }

        // Previous AI response ending (for repetition detection)
        const prevAiMsgs = chat.filter((m, i) => !m.is_user && m.mes && i < messageIndex);
        if (prevAiMsgs.length > 0) {
            const prevTail = prevAiMsgs[prevAiMsgs.length - 1].mes.slice(-200);
            contextParts.push(`Previous response ending (last ~200 chars):\n${prevTail}`);
        }

        const contextBlock = contextParts.length > 0
            ? `Context:\n${contextParts.join('\n\n')}\n\n`
            : '';

        const promptText = `${contextBlock}Apply the following refinement rules to the message below. Any [PROTECTED_N] placeholders are protected regions — output them exactly as-is.

Remember: output [CHANGELOG]...[/CHANGELOG] first, then the refined message inside [REFINED]...[/REFINED]. No other text outside these tags.

Rules:\n${rulesText}\n\nOriginal message:\n${strippedMessage}`;

        console.debug(`${LOG_PREFIX} [prompt] System prompt (${systemPrompt.length} chars):`, systemPrompt.substring(0, 200) + '…');
        console.debug(`${LOG_PREFIX} [prompt] Full refinement prompt (${promptText.length} chars):`);
        console.debug(promptText);

        // Call refinement via the appropriate mode
        let refinedText;
        if (settings.connectionMode === 'plugin') {
            refinedText = await refineViaPlugin(promptText, systemPrompt);
        } else {
            refinedText = await refineViaST(promptText, systemPrompt);
        }

        // Parse changelog from response
        const { changelog, refined: cleanRefined } = parseChangelog(refinedText);
        if (changelog) {
            console.log(`${LOG_PREFIX} [changelog]`, changelog);
        }

        // Restore protected blocks and write refined text back
        refinedText = restoreProtectedBlocks(cleanRefined, protectedBlocks);
        const originalText = message.mes;
        message.mes = refinedText;
        await saveChat();

        // Re-render the message in the UI
        rerenderMessage(messageIndex);

        // Persist diff data so diff button can be restored on reload
        if (!chatMetadata['redraft_diffs']) chatMetadata['redraft_diffs'] = {};
        chatMetadata['redraft_diffs'][messageIndex] = { original: originalText, changelog: changelog || null };
        await saveMetadata();

        // Show undo + diff buttons
        showUndoButton(messageIndex);
        showDiffButton(messageIndex, originalText, refinedText, changelog);

        // Auto-show diff popup if toggle is on
        if (settings.showDiffAfterRefine) {
            showDiffPopup(originalText, refinedText, changelog);
        }

        toastr.success('Message refined', 'ReDraft');
        console.log(`${LOG_PREFIX} Message ${messageIndex} refined successfully (mode: ${settings.connectionMode})`);

    } catch (err) {
        console.error(`${LOG_PREFIX} Refinement failed:`, err.message);
        toastr.error(err.message || 'Refinement failed', 'ReDraft');
    } finally {
        isRefining = false;
        setMessageButtonLoading(messageIndex, false);
        setPopoutTriggerLoading(false);
    }
}

/**
 * Undo a refinement — restore original text.
 * @param {number} messageIndex
 */
async function undoRedraft(messageIndex) {
    const context = SillyTavern.getContext();
    const { chat, saveChat, chatMetadata, saveMetadata } = context;

    const originals = chatMetadata['redraft_originals'];
    if (!originals || !originals[messageIndex]) {
        toastr.warning('No original text to restore', 'ReDraft');
        return;
    }

    chat[messageIndex].mes = originals[messageIndex];
    delete originals[messageIndex];

    // Also clean up persisted diff data
    const diffs = chatMetadata['redraft_diffs'];
    if (diffs) delete diffs[messageIndex];

    await saveMetadata();
    await saveChat();
    rerenderMessage(messageIndex);
    hideUndoButton(messageIndex);
    hideDiffButton(messageIndex);

    toastr.info('Original message restored', 'ReDraft');
    console.log(`${LOG_PREFIX} Message ${messageIndex} restored`);
}

/**
 * Re-render a single message in the UI.
 */
function rerenderMessage(messageIndex) {
    const context = SillyTavern.getContext();
    const mesBlock = document.querySelector(`.mes[mesid="${messageIndex}"] .mes_text`);
    if (mesBlock && context.chat[messageIndex]) {
        const { messageFormatting } = context;
        if (typeof messageFormatting === 'function') {
            mesBlock.innerHTML = messageFormatting(context.chat[messageIndex].mes, context.chat[messageIndex].name, false, false, messageIndex);
        } else {
            mesBlock.textContent = context.chat[messageIndex].mes;
        }
    }
}

// ─── Per-Message Buttons ────────────────────────────────────────────

function addMessageButtons() {
    document.querySelectorAll('.mes[is_system="false"]').forEach(mesEl => {
        const isUser = mesEl.getAttribute('is_user') === 'true';
        if (isUser) return;

        const mesId = parseInt(mesEl.getAttribute('mesid'), 10);
        const buttonsRow = mesEl.querySelector('.mes_buttons');
        if (!buttonsRow) return;

        if (buttonsRow.querySelector('.redraft-msg-btn')) return;

        const btn = document.createElement('div');
        btn.classList.add('mes_button', 'redraft-msg-btn');
        btn.title = 'ReDraft';
        btn.innerHTML = '<i class="fa-solid fa-pen-nib"></i>';
        btn.addEventListener('click', SillyTavern.libs.lodash.debounce(() => {
            redraftMessage(mesId);
        }, 500, { leading: true, trailing: false }));

        buttonsRow.prepend(btn);
    });
}

function setMessageButtonLoading(messageIndex, loading) {
    const btn = document.querySelector(`.mes[mesid="${messageIndex}"] .redraft-msg-btn`);
    if (!btn) return;
    if (loading) {
        btn.classList.add('redraft-loading');
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    } else {
        btn.classList.remove('redraft-loading');
        btn.innerHTML = '<i class="fa-solid fa-pen-nib"></i>';
    }
}

function setPopoutTriggerLoading(loading) {
    const trigger = document.getElementById('redraft_popout_trigger');
    if (!trigger) return;
    if (loading) {
        trigger.classList.add('redraft-refining');
        trigger.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    } else {
        trigger.classList.remove('redraft-refining');
        trigger.innerHTML = '<i class="fa-solid fa-pen-nib"></i><span class="redraft-auto-dot"></span>';
        updatePopoutAutoState();
    }
}

function showUndoButton(messageIndex) {
    const mesEl = document.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (!mesEl) return;
    const buttonsRow = mesEl.querySelector('.mes_buttons');
    if (!buttonsRow || buttonsRow.querySelector('.redraft-undo-btn')) return;

    const btn = document.createElement('div');
    btn.classList.add('mes_button', 'redraft-undo-btn');
    btn.title = 'Undo ReDraft';
    btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
    btn.addEventListener('click', () => undoRedraft(messageIndex));

    // Insert after the redraft button for consistent order: [refine] [undo] [diff]
    const refineBtn = buttonsRow.querySelector('.redraft-msg-btn');
    if (refineBtn) {
        refineBtn.after(btn);
    } else {
        buttonsRow.prepend(btn);
    }
}

function hideUndoButton(messageIndex) {
    const btn = document.querySelector(`.mes[mesid="${messageIndex}"] .redraft-undo-btn`);
    if (btn) btn.remove();
}

function showDiffButton(messageIndex, originalText, refinedText, changelog = null) {
    const mesEl = document.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (!mesEl) return;
    const buttonsRow = mesEl.querySelector('.mes_buttons');
    if (!buttonsRow || buttonsRow.querySelector('.redraft-diff-btn')) return;

    const btn = document.createElement('div');
    btn.classList.add('mes_button', 'redraft-diff-btn');
    btn.title = 'View ReDraft Changes';
    btn.innerHTML = '<i class="fa-solid fa-code-compare"></i>';
    btn.addEventListener('click', () => showDiffPopup(originalText, refinedText, changelog));

    // Insert after undo, or after refine, for consistent order: [refine] [undo] [diff]
    const undoBtn = buttonsRow.querySelector('.redraft-undo-btn');
    const refineBtn2 = buttonsRow.querySelector('.redraft-msg-btn');
    const anchor = undoBtn || refineBtn2;
    if (anchor) {
        anchor.after(btn);
    } else {
        buttonsRow.prepend(btn);
    }
}

function hideDiffButton(messageIndex) {
    const btn = document.querySelector(`.mes[mesid="${messageIndex}"] .redraft-diff-btn`);
    if (btn) btn.remove();
}

// ─── Diff Engine ───────────────────────────────────────────────────────────

/**
 * Tokenize text into words and whitespace for diffing.
 * Keeps whitespace as separate tokens so formatting is preserved.
 */
function tokenize(text) {
    return text.match(/\S+|\s+/g) || [];
}

/**
 * Compute LCS (Longest Common Subsequence) table for two token arrays.
 */
function lcsTable(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp;
}

/**
 * Compute word-level diff between original and refined text.
 * Returns array of {type: 'equal'|'delete'|'insert', text} segments.
 */
function computeWordDiff(original, refined) {
    const a = tokenize(original);
    const b = tokenize(refined);
    const dp = lcsTable(a, b);

    // Backtrace to build diff
    const diff = [];
    let i = a.length, j = b.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            diff.push({ type: 'equal', text: a[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.push({ type: 'insert', text: b[j - 1] });
            j--;
        } else {
            diff.push({ type: 'delete', text: a[i - 1] });
            i--;
        }
    }
    diff.reverse();

    // Merge consecutive segments of the same type
    const merged = [];
    for (const seg of diff) {
        if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
            merged[merged.length - 1].text += seg.text;
        } else {
            merged.push({ ...seg });
        }
    }
    return merged;
}

/**
 * Show a diff popup comparing original vs refined text.
 */
function showDiffPopup(original, refined, changelog = null) {
    // Remove any existing popup
    closeDiffPopup();

    if (original === refined) {
        toastr.info('No changes were made', 'ReDraft');
        return;
    }

    const diff = computeWordDiff(original, refined);

    // Build diff HTML
    const { DOMPurify } = SillyTavern.libs;
    let diffHtml = '';
    for (const seg of diff) {
        const escaped = DOMPurify.sanitize(seg.text, { ALLOWED_TAGS: [] })
            .replace(/\n/g, '<br>');
        switch (seg.type) {
            case 'delete':
                diffHtml += `<span class="redraft-diff-del">${escaped}</span>`;
                break;
            case 'insert':
                diffHtml += `<span class="redraft-diff-ins">${escaped}</span>`;
                break;
            default:
                diffHtml += escaped;
        }
    }

    // Count changed words (not segments)
    const countWords = (segments, type) => segments
        .filter(s => s.type === type)
        .reduce((n, s) => n + s.text.trim().split(/\s+/).filter(Boolean).length, 0);
    const delCount = countWords(diff, 'delete');
    const insCount = countWords(diff, 'insert');

    // Build changelog section if available
    let changelogHtml = '';
    if (changelog) {
        const sanitizedLog = DOMPurify.sanitize(changelog, { ALLOWED_TAGS: [] })
            .replace(/\n/g, '<br>');
        changelogHtml = `
            <details class="redraft-changelog">
                <summary class="redraft-changelog-summary">
                    <i class="fa-solid fa-clipboard-list"></i> Change Log
                </summary>
                <div class="redraft-changelog-body">${sanitizedLog}</div>
            </details>
        `;
    }

    const overlay = document.createElement('div');
    overlay.id = 'redraft_diff_overlay';
    overlay.classList.add('redraft-diff-overlay');
    overlay.innerHTML = `
        <div class="redraft-diff-panel">
            <div class="redraft-diff-header">
                <span class="redraft-diff-title">ReDraft Changes</span>
                <span class="redraft-diff-stats">
                    <span class="redraft-diff-stat-del">−${delCount}</span>
                    <span class="redraft-diff-stat-ins">+${insCount}</span>
                </span>
                <div class="redraft-diff-close" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </div>
            </div>
            ${changelogHtml}
            <div class="redraft-diff-body">${diffHtml}</div>
        </div>
    `;

    // Close handlers
    overlay.querySelector('.redraft-diff-close').addEventListener('click', closeDiffPopup);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeDiffPopup();
    });

    document.body.appendChild(overlay);
}

function closeDiffPopup() {
    const overlay = document.getElementById('redraft_diff_overlay');
    if (overlay) overlay.remove();
}

// ─── Floating Popout ────────────────────────────────────────────────

function createPopoutTrigger() {
    if (document.getElementById('redraft_popout_trigger')) return;

    const trigger = document.createElement('div');
    trigger.id = 'redraft_popout_trigger';
    trigger.classList.add('redraft-popout-trigger');
    trigger.title = 'ReDraft';
    trigger.innerHTML = `
        <i class="fa-solid fa-pen-nib"></i>
        <span class="redraft-auto-dot"></span>
    `;
    trigger.addEventListener('click', togglePopout);
    document.body.appendChild(trigger);

    updatePopoutAutoState();
}

function togglePopout() {
    const panel = document.getElementById('redraft_popout_panel');
    if (!panel) return;
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'block';

    if (!isVisible) {
        const autoCheckbox = document.getElementById('redraft_popout_auto');
        if (autoCheckbox) {
            autoCheckbox.checked = getSettings().autoRefine;
        }
        updatePopoutStatus();

        // Click-outside to close
        const closeOnOutsideClick = (e) => {
            if (!panel.contains(e.target) && !e.target.closest('.redraft-popout-trigger')) {
                panel.style.display = 'none';
                document.removeEventListener('pointerdown', closeOnOutsideClick, true);
            }
        };
        // Defer so the opening click doesn't immediately close it
        requestAnimationFrame(() => {
            document.addEventListener('pointerdown', closeOnOutsideClick, true);
        });
    }
}

function updatePopoutAutoState() {
    const trigger = document.getElementById('redraft_popout_trigger');
    if (!trigger) return;
    const settings = getSettings();
    trigger.classList.toggle('auto-active', settings.autoRefine && settings.enabled);
}

async function updatePopoutStatus() {
    const el = document.getElementById('redraft_popout_status');
    if (!el) return;
    const settings = getSettings();

    if (settings.connectionMode === 'st') {
        el.textContent = 'Using ST connection';
    } else if (!pluginAvailable) {
        el.textContent = 'Plugin unavailable';
    } else {
        try {
            const status = await pluginRequest('/status');
            el.textContent = status.configured ? `${status.model} ready` : 'Not configured';
        } catch {
            el.textContent = 'Plugin unavailable';
        }
    }
}

// ─── Custom Rules UI ────────────────────────────────────────────────

function renderCustomRules() {
    const container = document.getElementById('redraft_custom_rules_list');
    const settings = getSettings();
    console.debug(`${LOG_PREFIX} renderCustomRules: container found=${!!container}, rules count=${settings.customRules?.length}`);
    if (!container) return;

    const { DOMPurify } = SillyTavern.libs;

    container.innerHTML = '';

    settings.customRules.forEach((rule, index) => {
        const item = document.createElement('div');
        item.classList.add('redraft-custom-rule-item');
        item.dataset.index = index;

        item.innerHTML = `
            <span class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
            <input type="checkbox" class="redraft-rule-toggle" ${rule.enabled ? 'checked' : ''} />
            <textarea class="text_pole redraft-rule-text" rows="1" placeholder="Enter rule...">${DOMPurify.sanitize(rule.text || '')}</textarea>
            <button class="redraft-delete-rule" title="Remove rule"><i class="fa-solid fa-trash-can"></i></button>
        `;

        item.querySelector('.redraft-rule-toggle').addEventListener('change', (e) => {
            getSettings().customRules[index].enabled = e.target.checked;
            saveSettings();
            updateCustomRulesToggle();
        });

        item.querySelector('.redraft-rule-text').addEventListener('input', (e) => {
            getSettings().customRules[index].text = e.target.value;
            saveSettings();
        });

        item.querySelector('.redraft-delete-rule').addEventListener('click', () => {
            getSettings().customRules.splice(index, 1);
            saveSettings();
            renderCustomRules();
        });

        container.appendChild(item);
    });

    initDragReorder(container);
    updateCustomRulesToggle();
}

/**
 * Sync the master custom-rules toggle state.
 * Checked = all enabled, unchecked = all disabled, indeterminate = mixed.
 */
function updateCustomRulesToggle() {
    const toggle = document.getElementById('redraft_custom_rules_toggle');
    if (!toggle) return;
    const rules = getSettings().customRules;
    if (rules.length === 0) {
        toggle.checked = false;
        toggle.indeterminate = false;
        return;
    }
    const enabledCount = rules.filter(r => r.enabled).length;
    toggle.checked = enabledCount === rules.length;
    toggle.indeterminate = enabledCount > 0 && enabledCount < rules.length;
}

function initDragReorder(container) {
    let draggedItem = null;

    container.querySelectorAll('.drag-handle').forEach(handle => {
        const item = handle.closest('.redraft-custom-rule-item');
        item.setAttribute('draggable', true);

        item.addEventListener('dragstart', (e) => {
            draggedItem = item;
            item.style.opacity = '0.4';
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragend', () => {
            item.style.opacity = '';
            draggedItem = null;
            container.querySelectorAll('.redraft-custom-rule-item').forEach(el => {
                el.classList.remove('redraft-drag-over');
            });
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            item.classList.add('redraft-drag-over');
        });

        item.addEventListener('dragleave', () => {
            item.classList.remove('redraft-drag-over');
        });

        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('redraft-drag-over');
            if (!draggedItem || draggedItem === item) return;

            const fromIndex = parseInt(draggedItem.dataset.index, 10);
            const toIndex = parseInt(item.dataset.index, 10);

            const s = getSettings();
            const [moved] = s.customRules.splice(fromIndex, 1);
            s.customRules.splice(toIndex, 0, moved);
            saveSettings();
            renderCustomRules();
        });
    });
}

/**
 * Export custom rules as a JSON file download.
 */
function exportCustomRules() {
    const settings = getSettings();
    if (!settings.customRules || settings.customRules.length === 0) {
        toastr.warning('No custom rules to export', 'ReDraft');
        return;
    }

    const data = {
        name: 'ReDraft Custom Rules',
        version: 1,
        rules: settings.customRules.map(r => ({
            label: r.label || '',
            text: r.text || '',
            enabled: r.enabled !== false,
        })),
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'redraft-rules.json';
    a.click();
    URL.revokeObjectURL(url);

    toastr.success(`Exported ${data.rules.length} rules`, 'ReDraft');
}

/**
 * Import custom rules from a JSON file.
 * @param {File} file
 */
async function importCustomRules(file) {
    try {
        const text = await file.text();
        const data = JSON.parse(text);

        // Validate
        if (!data.rules || !Array.isArray(data.rules) || data.rules.length === 0) {
            toastr.error('Invalid file: must contain a non-empty "rules" array', 'ReDraft');
            return;
        }

        // Parse valid rules, skip empty ones
        const importedRules = data.rules
            .filter(r => r && typeof r.text === 'string' && r.text.trim())
            .map(r => ({
                label: r.label || '',
                text: r.text.trim(),
                enabled: r.enabled !== false,
            }));

        if (importedRules.length === 0) {
            toastr.error('No valid rules found in file', 'ReDraft');
            return;
        }

        const ruleName = data.name || file.name.replace(/\.json$/i, '');

        // Prompt user: Append or Replace
        const s = getSettings();
        const hasExisting = s.customRules.length > 0;

        if (hasExisting) {
            const replace = confirm(
                `Import "${ruleName}" (${importedRules.length} rules)?\n\n` +
                `OK = Replace existing ${s.customRules.length} rules\n` +
                `Cancel = Append after existing rules`
            );

            if (replace) {
                s.customRules = importedRules;
            } else {
                s.customRules.push(...importedRules);
            }
        } else {
            s.customRules = importedRules;
        }

        saveSettings();
        renderCustomRules();
        toastr.success(`Imported ${importedRules.length} rules from "${ruleName}"`, 'ReDraft');

    } catch (err) {
        console.error(`${LOG_PREFIX} Import failed:`, err);
        toastr.error('Failed to import: ' + (err.message || 'Invalid JSON'), 'ReDraft');
    }
}

// ─── Settings UI Binding ────────────────────────────────────────────

function bindSettingsUI() {
    // IMPORTANT: Always use getSettings() fresh in each handler — ST may replace
    // the extension_settings object during save/load, making cached refs stale.
    const initSettings = getSettings();


    // Connection mode selector
    const modeSelect = document.getElementById('redraft_connection_mode');
    if (modeSelect) {
        modeSelect.value = initSettings.connectionMode;
        modeSelect.addEventListener('change', (e) => {
            getSettings().connectionMode = e.target.value;
            saveSettings();
            updateConnectionModeUI();
        });
    }

    // Enable toggle
    const enabledEl = document.getElementById('redraft_enabled');
    if (enabledEl) {
        enabledEl.checked = initSettings.enabled;
        enabledEl.addEventListener('change', (e) => {
            getSettings().enabled = e.target.checked;
            saveSettings();
            updatePopoutAutoState();
        });
    }

    // Auto-refine toggle
    const autoEl = document.getElementById('redraft_auto_refine');
    if (autoEl) {
        autoEl.checked = initSettings.autoRefine;
        autoEl.addEventListener('change', (e) => {
            getSettings().autoRefine = e.target.checked;
            saveSettings();
            updatePopoutAutoState();
        });
    }

    // Show diff after refinement toggle
    const diffEl = document.getElementById('redraft_show_diff');
    if (diffEl) {
        diffEl.checked = initSettings.showDiffAfterRefine;
        diffEl.addEventListener('change', (e) => {
            getSettings().showDiffAfterRefine = e.target.checked;
            saveSettings();
        });
    }

    // System prompt
    const promptEl = document.getElementById('redraft_system_prompt');
    if (promptEl) {
        promptEl.value = initSettings.systemPrompt || '';
        promptEl.addEventListener('input', (e) => {
            getSettings().systemPrompt = e.target.value;
            saveSettings();
        });
    }

    // PoV selector
    const povEl = document.getElementById('redraft_pov');
    if (povEl) {
        povEl.value = initSettings.pov || 'auto';
        povEl.addEventListener('change', (e) => {
            const s = getSettings();
            s.pov = e.target.value;
            // Sync with popout selector
            const popoutPov = document.getElementById('redraft_popout_pov');
            if (popoutPov) popoutPov.value = e.target.value;
            saveSettings();
        });
    }

    // Built-in rule toggles
    for (const key of Object.keys(BUILTIN_RULES)) {
        const el = document.getElementById(`redraft_rule_${key}`);
        if (el) {
            el.checked = initSettings.builtInRules[key];
            el.addEventListener('change', (e) => {
                getSettings().builtInRules[key] = e.target.checked;
                saveSettings();
            });
        }
    }

    // Save connection button
    const saveConnBtn = document.getElementById('redraft_save_connection');
    if (saveConnBtn) {
        saveConnBtn.addEventListener('click', saveConnection);
    }

    // Import custom rules button
    const importBtn = document.getElementById('redraft_import_rules');
    const importFile = document.getElementById('redraft_import_rules_file');
    if (importBtn && importFile) {
        importBtn.addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                importCustomRules(file);
                e.target.value = ''; // Reset so same file can be re-imported
            }
        });
    }

    // Export custom rules button
    const exportBtn = document.getElementById('redraft_export_rules');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportCustomRules);
    }

    // Master custom-rules toggle
    const customRulesToggle = document.getElementById('redraft_custom_rules_toggle');
    if (customRulesToggle) {
        customRulesToggle.addEventListener('change', (e) => {
            const s = getSettings();
            const enable = e.target.checked;
            s.customRules.forEach(r => r.enabled = enable);
            saveSettings();
            renderCustomRules();
        });
    }

    // Add custom rule button
    const addRuleBtn = document.getElementById('redraft_add_rule');

    if (addRuleBtn) {
        addRuleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const s = getSettings();
            s.customRules.push({ text: '', enabled: true });
            saveSettings();
            renderCustomRules();

            // Auto-focus the new rule's textarea
            const ruleInputs = document.querySelectorAll('.redraft-rule-text');

            if (ruleInputs.length > 0) {
                ruleInputs[ruleInputs.length - 1].focus();
            }
        });
    }



    // Popout panel bindings
    const popoutClose = document.getElementById('redraft_popout_close');
    if (popoutClose) {
        popoutClose.addEventListener('click', togglePopout);
    }

    const popoutAuto = document.getElementById('redraft_popout_auto');
    if (popoutAuto) {
        popoutAuto.checked = initSettings.autoRefine;
        popoutAuto.addEventListener('change', (e) => {
            const s = getSettings();
            s.autoRefine = e.target.checked;
            if (autoEl) autoEl.checked = e.target.checked;
            saveSettings();
            updatePopoutAutoState();
        });
    }

    // Popout PoV selector
    const popoutPov = document.getElementById('redraft_popout_pov');
    if (popoutPov) {
        popoutPov.value = initSettings.pov || 'auto';
        popoutPov.addEventListener('change', (e) => {
            const s = getSettings();
            s.pov = e.target.value;
            // Sync with main settings panel
            const mainPov = document.getElementById('redraft_pov');
            if (mainPov) mainPov.value = e.target.value;
            saveSettings();
        });
    }

    const popoutRefine = document.getElementById('redraft_popout_refine');
    if (popoutRefine) {
        popoutRefine.addEventListener('click', SillyTavern.libs.lodash.debounce(() => {
            const lastAiIdx = findLastAiMessageIndex();
            if (lastAiIdx >= 0) {
                redraftMessage(lastAiIdx);
            } else {
                toastr.warning('No AI message found to refine', 'ReDraft');
            }
        }, 500, { leading: true, trailing: false }));
    }

    const popoutOpenSettings = document.getElementById('redraft_popout_open_settings');

    if (popoutOpenSettings) {
        popoutOpenSettings.addEventListener('click', () => {

            togglePopout();

            // Check if extensions panel is already visible
            const extPanel = document.getElementById('top-settings-holder');
            const isPanelOpen = extPanel && extPanel.style.display !== 'none' && !extPanel.classList.contains('displayNone');


            if (!isPanelOpen) {
                // Only click if panel is closed
                const extBtn = document.getElementById('extensionsMenuButton');

                if (extBtn) extBtn.click();
            }

            // Scroll to and open the ReDraft drawer
            setTimeout(() => {
                const redraftSettings = document.getElementById('redraft_settings');

                if (redraftSettings) {
                    redraftSettings.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Open the drawer if it's closed
                    const drawerContent = redraftSettings.querySelector('.inline-drawer-content');
                    if (drawerContent && !drawerContent.classList.contains('open') && getComputedStyle(drawerContent).display === 'none') {
                        const drawerToggle = redraftSettings.querySelector('.inline-drawer-toggle');
                        if (drawerToggle) drawerToggle.click();
                    }
                }
            }, 300);
        });
    }

    // Render custom rules
    renderCustomRules();

    // Set initial connection mode UI
    updateConnectionModeUI();
}

async function saveConnection() {
    const apiUrl = document.getElementById('redraft_api_url')?.value?.trim();
    const apiKey = document.getElementById('redraft_api_key')?.value?.trim();
    const model = document.getElementById('redraft_model')?.value?.trim();
    const maxTokens = document.getElementById('redraft_max_tokens')?.value;

    if (!apiUrl || !apiKey || !model) {
        toastr.warning('Please fill in API URL, Key, and Model', 'ReDraft');
        return;
    }

    try {
        await pluginRequest('/config', 'POST', {
            apiUrl,
            apiKey,
            model,
            maxTokens: maxTokens ? parseInt(maxTokens, 10) : 4096,
        });

        const keyField = document.getElementById('redraft_api_key');
        if (keyField) keyField.value = '';

        toastr.success('Connection saved', 'ReDraft');
        await checkPluginStatus();
    } catch (err) {
        toastr.error(err.message || 'Failed to save connection', 'ReDraft');
    }
}

// ─── Event Handlers ─────────────────────────────────────────────────

function findLastAiMessageIndex() {
    const { chat } = SillyTavern.getContext();
    if (!chat) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) {
            return i;
        }
    }
    return -1;
}

function onCharacterMessageRendered(messageIndex) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoRefine) return;
    if (isRefining) return;

    setTimeout(() => {
        redraftMessage(messageIndex);
    }, 100);
}

function onMessageRendered() {
    addMessageButtons();
    const context = SillyTavern.getContext();
    const { chat, chatMetadata } = context;
    const originals = chatMetadata?.['redraft_originals'];
    const diffs = chatMetadata?.['redraft_diffs'];
    if (originals) {
        for (const idx of Object.keys(originals)) {
            const i = parseInt(idx, 10);
            showUndoButton(i);
            // Restore diff button if persisted diff data exists
            if (diffs && diffs[idx] && chat[i]) {
                showDiffButton(i, diffs[idx].original, chat[i].mes, diffs[idx].changelog);
            }
        }
    }
}

function onChatChanged() {
    addMessageButtons();
}

// ─── Slash Command ──────────────────────────────────────────────────

function registerSlashCommand() {
    const context = SillyTavern.getContext();
    const {
        SlashCommandParser,
        SlashCommand,
        SlashCommandArgument,
        ARGUMENT_TYPE,
    } = context;

    if (!SlashCommandParser || !SlashCommand) {
        console.warn(`${LOG_PREFIX} SlashCommandParser not available, skipping command registration`);
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'redraft',
        callback: async (namedArgs, unnamedArgs) => {
            const settings = getSettings();
            if (!settings.enabled) {
                toastr.warning('ReDraft is disabled', 'ReDraft');
                return '';
            }

            let idx;
            const rawArg = unnamedArgs?.toString()?.trim();
            if (rawArg && !isNaN(rawArg)) {
                idx = parseInt(rawArg, 10);
            } else {
                idx = findLastAiMessageIndex();
            }

            if (idx < 0) {
                toastr.warning('No message found to refine', 'ReDraft');
                return '';
            }

            await redraftMessage(idx);
            return '';
        },
        aliases: [],
        returns: 'empty string',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message index to refine (defaults to last AI message)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
        ],
        helpString: '<div>Refine a message using ReDraft. Optionally provide a message index, otherwise refines the last AI message.</div>',
    }));

    console.log(`${LOG_PREFIX} Slash command /redraft registered`);
}

// ─── Initialization ─────────────────────────────────────────────────

(async function init() {
    console.log(`${LOG_PREFIX} Loading...`);

    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    // Load settings HTML (inlined to avoid path resolution issues with third-party extensions)
    const settingsHtml = `
<div id="redraft_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>ReDraft</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

            <!-- Top-level toggles -->
            <label class="checkbox_label">
                <input type="checkbox" id="redraft_enabled" />
                <span>Enable ReDraft</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="redraft_auto_refine" />
                <span>Auto-refine new AI messages</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="redraft_show_diff" />
                <span>Show diff after refinement</span>
            </label>

            <!-- Connection Section -->
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <span>Connection <span id="redraft_status_dot" class="redraft-status-dot" title="Not configured"></span></span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="redraft-form-group">
                        <label for="redraft_connection_mode">Refinement Mode</label>
                        <select id="redraft_connection_mode">
                            <option value="st">Use current ST connection</option>
                            <option value="plugin" disabled>Separate LLM (Coming Soon)</option>
                        </select>
                    </div>

                    <!-- Plugin connection fields (shown only in plugin mode) -->
                    <div id="redraft_plugin_fields" style="display: none;">
                        <div class="redraft-form-group">
                            <label for="redraft_api_url">API URL</label>
                            <input id="redraft_api_url" type="text" class="text_pole"
                                placeholder="https://api.openai.com/v1" />
                        </div>
                        <div class="redraft-form-group">
                            <label for="redraft_api_key">API Key</label>
                            <input id="redraft_api_key" type="password" class="text_pole" placeholder="sk-..."
                                autocomplete="off" />
                        </div>
                        <div class="redraft-form-group">
                            <label for="redraft_model">Model</label>
                            <input id="redraft_model" type="text" class="text_pole" placeholder="gpt-4o-mini" />
                        </div>
                        <div class="redraft-form-group">
                            <label for="redraft_max_tokens">Max Tokens</label>
                            <input id="redraft_max_tokens" type="number" class="text_pole" placeholder="4096" min="1"
                                max="128000" />
                        </div>
                        <div class="redraft-button-row">
                            <div id="redraft_save_connection" class="menu_button">
                                <i class="fa-solid fa-save"></i>
                                <span>Save Connection</span>
                            </div>
                            <span id="redraft_connection_info" class="redraft-connection-info"></span>
                        </div>
                    </div>

                    <!-- ST mode info -->
                    <div id="redraft_st_mode_info" class="redraft-st-mode-info">
                        <small>Refinement will use your currently selected API and model in SillyTavern.</small>
                    </div>
                </div>
            </div>

            <!-- Rules Section -->
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <span>Rules</span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="redraft-section-hint">Active rules are sent to the refinement LLM along with the
                        message.</small>

                    <div class="redraft-rules-builtins">
                        <label class="checkbox_label" title="Fix grammatical errors, spelling mistakes, and awkward phrasing. Preserves intentional dialect, slang, and character-specific speech.">
                            <input type="checkbox" id="redraft_rule_grammar" />
                            <span>Fix grammar &amp; spelling</span>
                        </label>
                        <label class="checkbox_label" title="Remove sentences where the character restates or paraphrases the user's previous message instead of advancing the scene.">
                            <input type="checkbox" id="redraft_rule_echo" />
                            <span>Remove echo &amp; restatement</span>
                        </label>
                        <label class="checkbox_label" title="Reduce repeated gestures, sentence structures, and emotional beats within the response and compared to the previous one.">
                            <input type="checkbox" id="redraft_rule_repetition" />
                            <span>Reduce repetition</span>
                        </label>
                        <label class="checkbox_label" title="Ensure each character's dialogue is distinct and consistent with their established speech patterns and personality.">
                            <input type="checkbox" id="redraft_rule_voice" />
                            <span>Maintain character voice</span>
                        </label>
                        <label class="checkbox_label" title="Fix common AI prose weaknesses: somatic clichés, purple prose, filter words, and telling over showing.">
                            <input type="checkbox" id="redraft_rule_prose" />
                            <span>Clean up prose</span>
                        </label>
                        <label class="checkbox_label" title="Fix orphaned formatting marks, inconsistent style, and dialogue punctuation errors.">
                            <input type="checkbox" id="redraft_rule_formatting" />
                            <span>Fix formatting</span>
                        </label>
                        <label class="checkbox_label" title="Remove theatrical 'dismount' endings — crafted landing lines that make the response feel concluded instead of mid-scene.">
                            <input type="checkbox" id="redraft_rule_ending" />
                            <span>Fix crafted endings</span>
                        </label>
                        <label class="checkbox_label" title="Flag glaring contradictions with established character and world information. Won't invent new lore.">
                            <input type="checkbox" id="redraft_rule_lore" />
                            <span>Maintain lore consistency</span>
                        </label>
                    </div>

                    <hr />

                    <div class="redraft-custom-rules-header">
                        <label class="checkbox_label" style="margin:0;gap:4px;">
                            <input type="checkbox" id="redraft_custom_rules_toggle" title="Enable/disable all custom rules" />
                            <small>Custom Rules (ordered by priority)</small>
                        </label>
                        <div>
                            <div id="redraft_import_rules" class="menu_button menu_button_icon" title="Import rules from JSON">
                                <i class="fa-solid fa-file-import"></i>
                            </div>
                            <input type="file" id="redraft_import_rules_file" accept=".json" hidden />
                            <div id="redraft_export_rules" class="menu_button menu_button_icon" title="Export rules to JSON">
                                <i class="fa-solid fa-file-export"></i>
                            </div>
                            <div id="redraft_add_rule" class="menu_button menu_button_icon" title="Add custom rule">
                                <i class="fa-solid fa-plus"></i>
                            </div>
                        </div>
                    </div>

                    <div id="redraft_custom_rules_list" class="redraft-custom-rules-list">
                        <!-- Custom rules injected here by JS -->
                    </div>
                </div>
            </div>

            <!-- Advanced Section -->
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <span>Advanced</span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="redraft-form-group redraft-pov-group">
                        <label for="redraft_pov">Point of View</label>
                        <select id="redraft_pov">
                            <option value="auto">Auto (no instruction)</option>
                            <option value="detect">Detect from message</option>
                            <option value="1st">1st person (I/me)</option>
                            <option value="1.5">1.5th person (I + you)</option>
                            <option value="2nd">2nd person (you)</option>
                            <option value="3rd">3rd person (he/she/they)</option>
                        </select>
                    </div>
                    <div class="redraft-form-group">
                        <label for="redraft_system_prompt">System Prompt Override</label>
                        <textarea id="redraft_system_prompt" class="text_pole textarea_compact" rows="3"
                            style="resize:vertical;field-sizing:content;max-height:50vh;"
                            placeholder="Leave blank for default refinement prompt..."></textarea>
                    </div>
                </div>
            </div>

        </div>
    </div>
</div>

<!-- Floating Popout Panel (injected near bottom of body by JS) -->
<div id="redraft_popout_panel" class="redraft-popout-panel" style="display: none;">
    <div class="redraft-popout-header">
        <span class="redraft-popout-title">ReDraft</span>
        <div id="redraft_popout_close" class="dragClose" title="Close">
            <i class="fa-solid fa-xmark"></i>
        </div>
    </div>
    <div class="redraft-popout-body">
        <label class="checkbox_label">
            <input type="checkbox" id="redraft_popout_auto" />
            <span>Auto-refine</span>
        </label>
        <div class="redraft-popout-pov">
            <small>PoV</small>
            <select id="redraft_popout_pov">
                <option value="auto">Auto</option>
                <option value="detect">Detect</option>
                <option value="1st">1st</option>
                <option value="1.5">1.5th</option>
                <option value="2nd">2nd</option>
                <option value="3rd">3rd</option>
            </select>
        </div>
        <div id="redraft_popout_status" class="redraft-popout-status"></div>
        <div id="redraft_popout_refine" class="menu_button">
            <i class="fa-solid fa-pen-nib"></i>
            <span>Refine Last Message</span>
        </div>
        <div id="redraft_popout_open_settings" class="menu_button">
            <i class="fa-solid fa-gear"></i>
            <span>Full Settings</span>
        </div>
    </div>
</div>`;

    const container = document.getElementById('extensions_settings2');
    if (container) {
        container.insertAdjacentHTML('beforeend', settingsHtml);

        // Move popout panel to body for proper positioning
        const popout = document.getElementById('redraft_popout_panel');
        if (popout) document.body.appendChild(popout);
    }

    // Initialize settings and bind UI
    getSettings();
    bindSettingsUI();

    // Create floating popout trigger
    createPopoutTrigger();

    // First-run hint — show once to help users find the popout
    const initSettings = getSettings();
    if (!initSettings.hasSeenHint) {
        toastr.info(
            'Use the ✏️ button in the bottom-right corner to quickly refine messages, toggle auto-refine, and adjust settings.',
            'ReDraft — Tip',
            { timeOut: 8000, extendedTimeOut: 4000, positionClass: 'toast-bottom-right' }
        );
        initSettings.hasSeenHint = true;
        saveSettings();
    }

    // Check plugin status
    await checkPluginStatus();

    // Register events
    eventListenerRefs.messageRendered = () => onMessageRendered();
    eventListenerRefs.charMessageRendered = (idx) => onCharacterMessageRendered(idx);
    eventListenerRefs.chatChanged = () => onChatChanged();

    eventSource.on(event_types.USER_MESSAGE_RENDERED, eventListenerRefs.messageRendered);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, eventListenerRefs.charMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, eventListenerRefs.chatChanged);

    // Add buttons to any existing messages
    addMessageButtons();

    // Register slash command
    registerSlashCommand();

    console.log(`${LOG_PREFIX} Loaded successfully (mode: ${getSettings().connectionMode})`);
})();
