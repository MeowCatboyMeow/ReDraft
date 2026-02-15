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
        grammar: false,
        repetition: false,
        voice: true,
        prose: false,
        formatting: false,
        lore: false,
    },
    customRules: [],
    systemPrompt: '',
});

const BUILTIN_RULE_LABELS = {
    grammar: 'Fix grammar and spelling',
    repetition: 'Remove repetition and redundant phrases',
    voice: 'Maintain character voice and personality',
    prose: 'Improve prose quality and flow',
    formatting: 'Fix formatting and punctuation',
    lore: 'Ensure consistency with established lore',
};

const DEFAULT_SYSTEM_PROMPT = `You are an expert editor. Your task is to refine and improve a roleplay message according to the provided rules. You must:
- Return ONLY the refined message text, with no commentary, explanations, or meta-text
- Preserve the original meaning, intent, and narrative direction
- Keep the same approximate length unless a rule specifically calls for changes
- Do not add new story elements, actions, or dialogue that weren't in the original
- Maintain any existing formatting (markdown, asterisks for actions, quotes for dialogue, etc.)`;

// ─── State ──────────────────────────────────────────────────────────

let isRefining = false; // Re-entrancy guard
let pluginAvailable = false; // Whether server plugin is reachable
let eventListenerRefs = {}; // For cleanup

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

    // Built-in rules first
    for (const [key, label] of Object.entries(BUILTIN_RULE_LABELS)) {
        if (settings.builtInRules[key]) {
            rules.push(label);
        }
    }

    // Custom rules in order
    for (const rule of settings.customRules) {
        if (rule.enabled && rule.text && rule.text.trim()) {
            rules.push(rule.text.trim());
        }
    }

    if (rules.length === 0) {
        rules.push('Improve the overall quality of the message');
    }

    return rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
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

    // Show loading state on the message button
    setMessageButtonLoading(messageIndex, true);

    try {
        // Save original to chatMetadata for undo
        if (!chatMetadata['redraft_originals']) {
            chatMetadata['redraft_originals'] = {};
        }
        chatMetadata['redraft_originals'][messageIndex] = message.mes;
        await saveMetadata();

        // Build the refinement prompt
        const rulesText = compileRules(settings);
        const systemPrompt = settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
        const promptText = `Apply the following refinement rules to the message below.\n\nRules:\n${rulesText}\n\nOriginal message:\n${message.mes}`;

        // Call refinement via the appropriate mode
        let refinedText;
        if (settings.connectionMode === 'plugin') {
            refinedText = await refineViaPlugin(promptText, systemPrompt);
        } else {
            refinedText = await refineViaST(promptText, systemPrompt);
        }

        // Write refined text back
        message.mes = refinedText;
        await saveChat();

        // Re-render the message in the UI
        rerenderMessage(messageIndex);

        // Show undo button
        showUndoButton(messageIndex);

        toastr.success('Message refined', 'ReDraft');
        console.log(`${LOG_PREFIX} Message ${messageIndex} refined successfully (mode: ${settings.connectionMode})`);

    } catch (err) {
        console.error(`${LOG_PREFIX} Refinement failed:`, err.message);
        toastr.error(err.message || 'Refinement failed', 'ReDraft');
    } finally {
        isRefining = false;
        setMessageButtonLoading(messageIndex, false);
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

    await saveMetadata();
    await saveChat();
    rerenderMessage(messageIndex);
    hideUndoButton(messageIndex);

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

// ─── Install Dialog ─────────────────────────────────────────────────

function getInstallCommand() {
    // Detect the extension install path to construct the command
    const isWindows = navigator.platform.indexOf('Win') > -1;
    const basePath = 'node data/default-user/extensions/third-party/redraft/server-plugin/install.js';

    if (isWindows) {
        return basePath.replace(/\//g, '\\');
    }
    return basePath;
}

function showInstallDialog() {
    const dialog = document.getElementById('redraft_install_dialog');
    const commandEl = document.getElementById('redraft_install_command');
    if (!dialog || !commandEl) return;

    commandEl.textContent = getInstallCommand();
    dialog.style.display = '';
}

function hideInstallDialog() {
    const dialog = document.getElementById('redraft_install_dialog');
    if (dialog) dialog.style.display = 'none';
}

// ─── Custom Rules UI ────────────────────────────────────────────────

function renderCustomRules() {
    const container = document.getElementById('redraft_custom_rules_list');
    if (!container) return;

    const { DOMPurify } = SillyTavern.libs;
    const settings = getSettings();

    container.innerHTML = '';

    settings.customRules.forEach((rule, index) => {
        const item = document.createElement('div');
        item.classList.add('redraft-custom-rule-item');
        item.dataset.index = index;

        item.innerHTML = `
            <span class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
            <input type="checkbox" class="redraft-rule-toggle" ${rule.enabled ? 'checked' : ''} />
            <input type="text" class="text_pole redraft-rule-text" value="${DOMPurify.sanitize(rule.text || '')}" placeholder="Enter rule..." />
            <button class="redraft-delete-rule" title="Remove rule"><i class="fa-solid fa-trash-can"></i></button>
        `;

        item.querySelector('.redraft-rule-toggle').addEventListener('change', (e) => {
            settings.customRules[index].enabled = e.target.checked;
            saveSettings();
        });

        item.querySelector('.redraft-rule-text').addEventListener('input', (e) => {
            settings.customRules[index].text = e.target.value;
            saveSettings();
        });

        item.querySelector('.redraft-delete-rule').addEventListener('click', () => {
            settings.customRules.splice(index, 1);
            saveSettings();
            renderCustomRules();
        });

        container.appendChild(item);
    });

    initDragReorder(container, settings);
}

function initDragReorder(container, settings) {
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
                el.style.borderTop = '';
            });
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            item.style.borderTop = `2px solid var(--SmartThemeBodyColor)`;
        });

        item.addEventListener('dragleave', () => {
            item.style.borderTop = '';
        });

        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.style.borderTop = '';
            if (!draggedItem || draggedItem === item) return;

            const fromIndex = parseInt(draggedItem.dataset.index, 10);
            const toIndex = parseInt(item.dataset.index, 10);

            const [moved] = settings.customRules.splice(fromIndex, 1);
            settings.customRules.splice(toIndex, 0, moved);
            saveSettings();
            renderCustomRules();
        });
    });
}

// ─── Settings UI Binding ────────────────────────────────────────────

function bindSettingsUI() {
    const settings = getSettings();

    // Connection mode selector
    const modeSelect = document.getElementById('redraft_connection_mode');
    if (modeSelect) {
        modeSelect.value = settings.connectionMode;
        modeSelect.addEventListener('change', (e) => {
            settings.connectionMode = e.target.value;
            saveSettings();
            updateConnectionModeUI();
        });
    }

    // Enable toggle
    const enabledEl = document.getElementById('redraft_enabled');
    if (enabledEl) {
        enabledEl.checked = settings.enabled;
        enabledEl.addEventListener('change', (e) => {
            settings.enabled = e.target.checked;
            saveSettings();
            updatePopoutAutoState();
        });
    }

    // Auto-refine toggle
    const autoEl = document.getElementById('redraft_auto_refine');
    if (autoEl) {
        autoEl.checked = settings.autoRefine;
        autoEl.addEventListener('change', (e) => {
            settings.autoRefine = e.target.checked;
            saveSettings();
            updatePopoutAutoState();
        });
    }

    // System prompt
    const promptEl = document.getElementById('redraft_system_prompt');
    if (promptEl) {
        promptEl.value = settings.systemPrompt || '';
        promptEl.addEventListener('input', (e) => {
            settings.systemPrompt = e.target.value;
            saveSettings();
        });
    }

    // Built-in rule toggles
    for (const key of Object.keys(BUILTIN_RULE_LABELS)) {
        const el = document.getElementById(`redraft_rule_${key}`);
        if (el) {
            el.checked = settings.builtInRules[key];
            el.addEventListener('change', (e) => {
                settings.builtInRules[key] = e.target.checked;
                saveSettings();
            });
        }
    }

    // Save connection button
    const saveConnBtn = document.getElementById('redraft_save_connection');
    if (saveConnBtn) {
        saveConnBtn.addEventListener('click', saveConnection);
    }

    // Add custom rule button
    const addRuleBtn = document.getElementById('redraft_add_rule');
    if (addRuleBtn) {
        addRuleBtn.addEventListener('click', () => {
            settings.customRules.push({ text: '', enabled: true });
            saveSettings();
            renderCustomRules();
        });
    }

    // Install banner button
    const installBtn = document.getElementById('redraft_install_btn');
    if (installBtn) {
        installBtn.addEventListener('click', showInstallDialog);
    }

    // Install dialog close
    const installDialogClose = document.getElementById('redraft_install_dialog_close');
    if (installDialogClose) {
        installDialogClose.addEventListener('click', hideInstallDialog);
    }

    // Copy command button
    const copyBtn = document.getElementById('redraft_copy_command');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const command = getInstallCommand();
            navigator.clipboard.writeText(command).then(() => {
                toastr.success('Command copied to clipboard', 'ReDraft');
            }).catch(() => {
                toastr.warning('Could not copy — please select and copy manually', 'ReDraft');
            });
        });
    }

    // Click outside install dialog to close
    const installDialog = document.getElementById('redraft_install_dialog');
    if (installDialog) {
        installDialog.addEventListener('click', (e) => {
            if (e.target === installDialog) hideInstallDialog();
        });
    }

    // Popout panel bindings
    const popoutClose = document.getElementById('redraft_popout_close');
    if (popoutClose) {
        popoutClose.addEventListener('click', togglePopout);
    }

    const popoutAuto = document.getElementById('redraft_popout_auto');
    if (popoutAuto) {
        popoutAuto.checked = settings.autoRefine;
        popoutAuto.addEventListener('change', (e) => {
            settings.autoRefine = e.target.checked;
            if (autoEl) autoEl.checked = e.target.checked;
            saveSettings();
            updatePopoutAutoState();
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
            document.getElementById('extensionsMenuButton')?.click();
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
    const { chatMetadata } = SillyTavern.getContext();
    const originals = chatMetadata?.['redraft_originals'];
    if (originals) {
        for (const idx of Object.keys(originals)) {
            showUndoButton(parseInt(idx, 10));
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

            <!-- Server Plugin Install Banner (shown only when plugin unavailable) -->
            <div id="redraft_plugin_banner" class="redraft-plugin-banner" style="display: none;">
                <div class="redraft-banner-text">
                    <i class="fa-solid fa-info-circle"></i>
                    <span>Using ST's built-in API. For a separate refinement LLM, install the server plugin.</span>
                </div>
                <div id="redraft_install_btn" class="menu_button" title="Show install command">
                    <i class="fa-solid fa-download"></i>
                    <span>Install Server Plugin</span>
                </div>
            </div>

            <!-- Connection Section -->
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <span>Connection</span>
                    <span id="redraft_status_dot" class="redraft-status-dot" title="Not configured"></span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="redraft-form-group">
                        <label for="redraft_connection_mode">Refinement Mode</label>
                        <select id="redraft_connection_mode">
                            <option value="st">Use current ST connection</option>
                            <option value="plugin">Use separate LLM (server plugin)</option>
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
                        <label class="checkbox_label">
                            <input type="checkbox" id="redraft_rule_grammar" />
                            <span>Fix grammar and spelling</span>
                        </label>
                        <label class="checkbox_label">
                            <input type="checkbox" id="redraft_rule_repetition" />
                            <span>Remove repetition and redundant phrases</span>
                        </label>
                        <label class="checkbox_label">
                            <input type="checkbox" id="redraft_rule_voice" />
                            <span>Maintain character voice and personality</span>
                        </label>
                        <label class="checkbox_label">
                            <input type="checkbox" id="redraft_rule_prose" />
                            <span>Improve prose quality and flow</span>
                        </label>
                        <label class="checkbox_label">
                            <input type="checkbox" id="redraft_rule_formatting" />
                            <span>Fix formatting and punctuation</span>
                        </label>
                        <label class="checkbox_label">
                            <input type="checkbox" id="redraft_rule_lore" />
                            <span>Ensure consistency with established lore</span>
                        </label>
                    </div>

                    <hr />

                    <div class="redraft-custom-rules-header">
                        <small>Custom Rules (ordered by priority)</small>
                        <div id="redraft_add_rule" class="menu_button" title="Add custom rule">
                            <i class="fa-solid fa-plus"></i>
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
                    <label class="checkbox_label">
                        <input type="checkbox" id="redraft_enabled" />
                        <span>Enable ReDraft</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="redraft_auto_refine" />
                        <span>Auto-refine new AI messages</span>
                    </label>
                    <div class="redraft-form-group">
                        <label for="redraft_system_prompt">System Prompt Override</label>
                        <textarea id="redraft_system_prompt" class="text_pole textarea_compact" rows="4"
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
</div>

<!-- Install Command Dialog (hidden, shown by JS) -->
<div id="redraft_install_dialog" class="redraft-install-dialog" style="display: none;">
    <div class="redraft-install-dialog-content">
        <div class="redraft-install-dialog-header">
            <span>Install ReDraft Server Plugin</span>
            <div id="redraft_install_dialog_close" class="dragClose" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </div>
        </div>
        <p>Run this command in your SillyTavern root directory, then restart:</p>
        <div class="redraft-install-command-block">
            <code id="redraft_install_command"></code>
            <div id="redraft_copy_command" class="menu_button" title="Copy to clipboard">
                <i class="fa-solid fa-copy"></i>
            </div>
        </div>
        <small class="redraft-install-hint">This copies the plugin files and enables server plugins in your
            config.</small>
    </div>
</div>`;

    const container = document.getElementById('extensions_settings2');
    if (container) {
        container.insertAdjacentHTML('beforeend', settingsHtml);

        // Move popout panel and install dialog to body for proper positioning
        const popout = document.getElementById('redraft_popout_panel');
        if (popout) document.body.appendChild(popout);

        const installDialog = document.getElementById('redraft_install_dialog');
        if (installDialog) document.body.appendChild(installDialog);
    }

    // Initialize settings and bind UI
    getSettings();
    bindSettingsUI();

    // Create floating popout trigger
    createPopoutTrigger();

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
