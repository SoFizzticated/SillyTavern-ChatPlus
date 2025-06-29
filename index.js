// =========================
// 1. Imports & Constants
// =========================
import { addJQueryHighlight } from './jquery-highlight.js';
import { getGroupPastChats } from '../../../group-chats.js';
import { getPastCharacterChats, animation_duration, animation_easing, getGeneratingApi, selectCharacterById } from '../../../../script.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { debounce, timestampToMoment, sortMoments, uuidv4, waitUntilCondition } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';
import { t } from '../../../i18n.js';

const {
    getCurrentChatId,
    renameChat,
    getRequestHeaders,
    openGroupChat,
    openCharacterChat,
    getThumbnailUrl,
    extensionSettings,
    saveSettingsDebounced
} = SillyTavern.getContext();
const MODULE_NAME = 'chatsPlus';
const defaultSettings = { pinnedChats: [] };
if (!('folders' in defaultSettings)) defaultSettings.folders = [];
if (!('chatFolders' in defaultSettings)) defaultSettings.chatFolders = {};
const MAX_RECENT_CHATS = 100;

// =========================
// 2. Settings & State Management
// =========================
let activateTab = null;
let refreshFoldersTab = null; // will be defined after function definitions
let recentChatsTabContainer = null;

/**
 * Get the extension settings object, initializing if necessary.
 * @returns {Object} The settings object for this extension.
 */
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extensionSettings[MODULE_NAME][key] === undefined) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

/**
 * Get the list of pinned chats from settings.
 * @returns {Array} Array of pinned chat objects.
 */
function getPinnedChats() {
    try { return getSettings().pinnedChats || []; } catch { return []; }
}

/**
 * Set the list of pinned chats in settings.
 * @param {Array} pinned - Array of pinned chat objects.
 */
function setPinnedChats(pinned) {
    getSettings().pinnedChats = pinned;
    saveSettingsDebounced();
}

/**
 * Check if a chat is pinned.
 * @param {Object} chat - Chat object.
 * @returns {boolean} True if pinned, false otherwise.
 */
function isChatPinned(chat) {
    const pinned = getPinnedChats();
    return pinned.some(x => x.characterId === chat.characterId && x.file_name === chat.file_name);
}

/**
 * Toggle the pinned state of a chat.
 * @param {Object} chat - Chat object.
 */
function togglePinChat(chat) {
    let pinned = getPinnedChats();
    const idx = pinned.findIndex(x => x.characterId === chat.characterId && x.file_name === chat.file_name);
    if (idx === -1) pinned.push({ characterId: chat.characterId, file_name: chat.file_name });
    else pinned.splice(idx, 1);
    setPinnedChats(pinned);
}

/**
 * Get the list of folders from settings.
 * @returns {Array} Array of folder objects.
 */
function getFolders() {
    try {
        const folders = getSettings().folders || [];
        // Ensure all folders have a parent property (for backward compatibility)
        for (const folder of folders) {
            if (!('parent' in folder)) folder.parent = null;
        }
        return folders;
    } catch { return []; }
}

/**
 * Set the list of folders in settings.
 * @param {Array} folders - Array of folder objects.
 */
function setFolders(folders) {
    getSettings().folders = folders;
    saveSettingsDebounced();
}

/**
 * Add a new folder with the given name and optional parent.
 * @param {string} name - Name of the new folder.
 * @param {string|null} parent - Parent folder ID, or null for root.
 */
function addFolder(name, parent = null) {
    const folders = getFolders();
    const id = 'folder_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    console.log(`Adding folder: ${name}, ID: ${id}, Parent: ${parent}`);
    folders.push({ id, name, parent });
    setFolders(folders);
}

/**
 * Remove a folder by its ID.
 * @param {string} id - Folder ID.
 */
function removeFolder(id) {
    let folders = getFolders();
    folders = folders.filter(f => f.id !== id);
    setFolders(folders);
}

/**
 * Get the chat-to-folders mapping from settings.
 * @returns {Object} Map of chat key to array of folder IDs.
 */
function getChatFoldersMap() {
    try { return getSettings().chatFolders || {}; } catch { return {}; }
}

/**
 * Set the chat-to-folders mapping in settings.
 * @param {Object} map - Map of chat key to array of folder IDs.
 */
function setChatFoldersMap(map) {
    getSettings().chatFolders = map;
    saveSettingsDebounced();
}

/**
 * Assign a chat to a folder.
 * @param {Object} chat - Chat object.
 * @param {string} folderId - Folder ID.
 */
function assignChatToFolder(chat, folderId) {
    const map = getChatFoldersMap();
    const key = chat.characterId + ':' + chat.file_name;
    if (!Array.isArray(map[key])) map[key] = [];
    if (!map[key].includes(folderId)) map[key].push(folderId);
    setChatFoldersMap(map);
}

/**
 * Remove a chat from a folder.
 * @param {Object} chat - Chat object.
 * @param {string} folderId - Folder ID.
 */
function removeChatFromFolder(chat, folderId) {
    const map = getChatFoldersMap();
    const key = chat.characterId + ':' + chat.file_name;
    if (Array.isArray(map[key])) {
        map[key] = map[key].filter(id => id !== folderId);
        if (map[key].length === 0) delete map[key];
    }
    setChatFoldersMap(map);
}

/**
 * Get all folder IDs assigned to a chat.
 * @param {Object} chat - Chat object.
 * @returns {Array} Array of folder IDs.
 */
function getChatFolderIds(chat) {
    const map = getChatFoldersMap();
    const key = chat.characterId + ':' + chat.file_name;
    return Array.isArray(map[key]) ? map[key] : [];
}

/**
 * Get the first folder ID assigned to a chat (legacy compatibility).
 * @param {Object} chat - Chat object.
 * @returns {string|null} Folder ID or null.
 */
function getChatFolderId(chat) {
    const ids = getChatFolderIds(chat);
    return ids.length > 0 ? ids[0] : null;
}

// =========================
// 3. Utility Functions
// =========================
/**
 * Prompt the user to select a folder or 'Pinned' for a chat using a SillyTavern popup.
 * Shows folders as a tree with indentation.
 * @param {Object} chat - Chat object.
 * @returns {Promise<string|null>} The selected folderId, 'pinned', or null if cancelled.
 */
async function promptSelectFolderOrPinned(chat) {
    const folders = getFolders().slice().sort((a, b) => a.name.localeCompare(b.name));
    // Helper: build tree
    function buildFolderTreeForPopup(folders) {
        const idToNode = {};
        folders.forEach(folder => {
            idToNode[folder.id] = { ...folder, children: [] };
        });
        const roots = [];
        folders.forEach(folder => {
            if (folder.parent && idToNode[folder.parent]) {
                idToNode[folder.parent].children.push(idToNode[folder.id]);
            } else {
                roots.push(idToNode[folder.id]);
            }
        });
        return roots;
    }
    // Helper: render radios as tree, with chat previews
    function renderFolderRadios(nodes, radioName, container, level = 0) {
        nodes.forEach(folder => {
            const label = document.createElement('label');
            label.style.display = 'flex';
            label.style.alignItems = 'center';
            label.style.marginLeft = (level * 20) + 'px';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = radioName;
            radio.value = folder.id;
            label.appendChild(radio);
            label.appendChild(document.createTextNode(' 📁 ' + folder.name));
            container.appendChild(label);
            // --- Chat preview for this folder ---
            const folderChats = Object.entries(getChatFoldersMap())
                .filter(([key, ids]) => Array.isArray(ids) && ids.includes(folder.id))
                .map(([key]) => {
                    const [characterId, file_name] = key.split(':');
                    return { characterId, file_name };
                });
            if (folderChats.length > 0) {
                const previewContainer = document.createElement('div');
                previewContainer.className = 'folder-preview-chats';
                previewContainer.style.marginLeft = (level * 20 + 32) + 'px';
                previewContainer.style.marginBottom = '4px';
                folderChats.slice(0, 3).forEach(chatObj => {
                    // Find character info
                    let char = null;
                    if (SillyTavern.getContext().characters && SillyTavern.getContext().characters[chatObj.characterId]) {
                        char = SillyTavern.getContext().characters[chatObj.characterId];
                    }
                    const chat = {
                        character: char ? (char.name || chatObj.characterId) : chatObj.characterId,
                        avatar: char ? char.avatar : '',
                        file_name: chatObj.file_name,
                        characterId: chatObj.characterId,
                        stat: undefined
                    };
                    // Try to get stat if available
                    if (typeof getPastCharacterChats === 'function') {
                        // This is async, but for preview, we skip stat or use cached if available
                        // Optionally, you could cache stats elsewhere for more detail
                    }
                    // Render preview using .tabItem-singleline style
                    const tabItem = document.createElement('div');
                    tabItem.classList.add('tabItem', 'tabItem-singleline');
                    tabItem.style.display = 'flex';
                    tabItem.style.flexDirection = 'row';
                    tabItem.style.alignItems = 'center';
                    tabItem.style.gap = '10px';
                    tabItem.style.marginBottom = '2px';
                    const previewImg = document.createElement('img');
                    previewImg.className = 'tabItem-previewImg';
                    previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                    previewImg.alt = chat.character || '';
                    const nameRow = document.createElement('div');
                    nameRow.className = 'tabItem-nameRow';
                    nameRow.textContent = `${chat.character}: ${chat.file_name}`;
                    tabItem.appendChild(previewImg);
                    tabItem.appendChild(nameRow);
                    previewContainer.appendChild(tabItem);
                });
                if (folderChats.length > 3) {
                    const more = document.createElement('div');
                    more.style.fontSize = '0.9em';
                    more.style.color = '#888';
                    more.style.marginLeft = '4px';
                    more.textContent = `+${folderChats.length - 3} more`;
                    previewContainer.appendChild(more);
                }
                container.appendChild(previewContainer);
            }
            if (folder.children && folder.children.length > 0) {
                renderFolderRadios(folder.children, radioName, container, level + 1);
            }
        });
    }
    // Build popup content
    const content = document.createElement('div');
    content.className = 'pin-popup-content';
    content.innerHTML = `<h3>${t`Pin or folder chat`}</h3>`;
    // --- Chat preview for the chat being pinned ---
    const previewContainer = document.createElement('div');
    previewContainer.className = 'pin-popup-chat-preview';
    previewContainer.style.margin = '8px 0 12px 0';
    // Build the preview using .tabItem-singleline style
    const tabItem = document.createElement('div');
    tabItem.classList.add('tabItem', 'tabItem-singleline');
    tabItem.style.display = 'flex';
    tabItem.style.flexDirection = 'row';
    tabItem.style.alignItems = 'center';
    tabItem.style.gap = '10px';
    tabItem.style.marginBottom = '2px';
    const previewImg = document.createElement('img');
    previewImg.className = 'tabItem-previewImg';
    previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
    previewImg.alt = chat.character || '';
    const nameRow = document.createElement('div');
    nameRow.className = 'tabItem-nameRow';
    nameRow.textContent = `${chat.character}: ${chat.file_name}`;
    tabItem.appendChild(previewImg);
    tabItem.appendChild(nameRow);
    previewContainer.appendChild(tabItem);
    content.appendChild(previewContainer);
    const radioGroup = document.createElement('div');
    radioGroup.className = 'chatplus_radio_group';
    const radioName = 'pin-folder-radio';
    // Option for pinned
    const pinnedLabel = document.createElement('label');
    pinnedLabel.style.display = 'flex';
    pinnedLabel.style.alignItems = 'center';
    const pinnedRadio = document.createElement('input');
    pinnedRadio.type = 'radio';
    pinnedRadio.name = radioName;
    pinnedRadio.value = 'pinned';
    pinnedRadio.checked = true;
    pinnedLabel.appendChild(pinnedRadio);
    pinnedLabel.appendChild(document.createTextNode(' 📌 ' + t`Pinned section`));
    radioGroup.appendChild(pinnedLabel);
    // --- Preview pinned chats ---
    const pinnedChats = getPinnedChats();
    if (pinnedChats.length > 0) {
        const pinnedPreviewContainer = document.createElement('div');
        pinnedPreviewContainer.className = 'pinned-preview-chats';
        pinnedPreviewContainer.style.marginLeft = '32px';
        pinnedPreviewContainer.style.marginBottom = '4px';
        pinnedChats.forEach(chatObj => {
            let char = null;
            if (SillyTavern.getContext().characters && SillyTavern.getContext().characters[chatObj.characterId]) {
                char = SillyTavern.getContext().characters[chatObj.characterId];
            }
            const chat = {
                character: char ? (char.name || chatObj.characterId) : chatObj.characterId,
                avatar: char ? char.avatar : '',
                file_name: chatObj.file_name,
                characterId: chatObj.characterId,
                stat: undefined
            };
            const tabItem = document.createElement('div');
            tabItem.classList.add('tabItem', 'tabItem-singleline');
            tabItem.style.display = 'flex';
            tabItem.style.flexDirection = 'row';
            tabItem.style.alignItems = 'center';
            tabItem.style.gap = '10px';
            tabItem.style.marginBottom = '2px';
            const previewImg = document.createElement('img');
            previewImg.className = 'tabItem-previewImg';
            previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
            previewImg.alt = chat.character || '';
            const nameRow = document.createElement('div');
            nameRow.className = 'tabItem-nameRow';
            nameRow.textContent = `${chat.character}: ${chat.file_name}`;
            tabItem.appendChild(previewImg);
            tabItem.appendChild(nameRow);
            pinnedPreviewContainer.appendChild(tabItem);
        });
        radioGroup.appendChild(pinnedPreviewContainer);
    }
    // Separator between pinned and folders
    const separator = document.createElement('hr');
    separator.style.margin = '8px 0';
    radioGroup.appendChild(separator);
    // Render folder radios as tree, with previews
    const folderTree = buildFolderTreeForPopup(folders);
    renderFolderRadios(folderTree, radioName, radioGroup, 0);
    content.appendChild(radioGroup);
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        cancelButton: t`Cancel`,
        wide: true,
        large: true,
    });
    const popupResult = await popup.show();
    if (popupResult === POPUP_RESULT.CANCELLED || popupResult === 0) return null; // Popup cancelled by the user

    const selectedRadio = content.querySelector('input[type="radio"]:checked');
    const result = selectedRadio && selectedRadio.value ? selectedRadio.value : null;
    return result || null;
}

// =========================
// 4. Chat Data Fetching
// =========================
/**
 * Fetch the list of chat file names for a character by avatar.
 * @param {string} avatar - Avatar URL or identifier.
 * @returns {Promise<string[]>} List of chat file names.
 */
async function getListOfCharacterChats(avatar) {
    try {
        const result = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!result.ok) return [];
        const data = await result.json();
        if (!Array.isArray(data)) {
            console.warn('Skipping character chats: data is not an array', data);
            return [];
        }
        return data.map(x => String(x.file_name).replace('.jsonl', ''));
    } catch (error) {
        console.warn('Failed to get list of character chats, skipping', error);
        return [];
    }
}

/**
 * Get the list of chat files for the current chat context (group or character).
 * @returns {Promise<Array>} List of chat files.
 */
async function getChatFiles() {
    const context = SillyTavern.getContext();
    const chatId = getCurrentChatId();
    if (!chatId) return [];
    if (context.groupId) return await getGroupPastChats(context.groupId);
    if (context.characterId !== undefined) return await getPastCharacterChats(context.characterId);
    return [];
}

/**
 * Open a chat by its ID, switching to the appropriate group or character chat.
 * @param {string} chatId - The chat file name or ID.
 */
async function openChatById(chatId) {
    const context = SillyTavern.getContext();
    if (!chatId) return;
    if (typeof openGroupChat === 'function' && context.groupId) {
        await openGroupChat(context.groupId, chatId);
        return;
    }
    if (typeof openCharacterChat === 'function' && context.characterId !== undefined) {
        await openCharacterChat(chatId);
        return;
    }
}

// =========================
// 5. UI Rendering Functions
// =========================
/**
 * Get or create the container for the Recent Chats tab.
 * @returns {HTMLElement|null} The container element or null if not found.
 */
function getOrCreateRecentChatsTabContainer() {
    if (recentChatsTabContainer && document.body.contains(recentChatsTabContainer)) return recentChatsTabContainer;
    const menu = document.getElementById('right-nav-panel');
    if (!menu) return null;
    const tabContent = menu.querySelector('.chatsplus-tab-content');
    if (!tabContent) return null;
    let recentChatsTab = tabContent.children[1];
    if (!recentChatsTab) return null;
    recentChatsTab.innerHTML = '';
    recentChatsTabContainer = recentChatsTab;
    return recentChatsTabContainer;
}

/**
 * Render all chats in the Recent Chats tab, including loader and main container.
 * Calls populateAllChatsTab to fill the content.
 */
async function renderAllChatsInRecentChatsTab() {
    const container = getOrCreateRecentChatsTabContainer();
    if (!container) return;
    if (container.querySelector('#extensionAllChatsTabContainer')) return;
    // --- Add filter input at the top ---
    const filterRow = document.createElement('div');
    filterRow.style.display = 'flex';
    filterRow.style.justifyContent = 'flex-start';
    filterRow.style.alignItems = 'center';
    filterRow.style.margin = '8px 4px 12px 4px';
    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter chats...';
    filterInput.style.width = '100%';
    filterInput.style.padding = '6px 10px';
    filterInput.style.fontSize = '1em';
    filterInput.style.borderRadius = '6px';
    filterInput.style.border = '1px solid #333';
    filterInput.style.background = '#222';
    filterInput.style.color = '#fff';
    filterInput.style.marginRight = '8px';
    filterRow.appendChild(filterInput);
    container.appendChild(filterRow);
    // --- Loader and main container ---
    const loader = document.createElement('div');
    loader.id = 'extensionAllChatsTabLoader';
    loader.style.display = 'flex';
    loader.style.justifyContent = 'center';
    loader.style.alignItems = 'center';
    loader.style.width = '100%';
    loader.style.height = '100%';
    loader.style.position = 'relative';
    const loaderIcon = document.createElement('i');
    loaderIcon.className = 'fa-2x fa-solid fa-gear fa-spin';
    loader.appendChild(loaderIcon);
    container.appendChild(loader);
    const chatsTabContainer = document.createElement('div');
    chatsTabContainer.id = 'extensionAllChatsTabContainer';
    container.appendChild(chatsTabContainer);
    // --- Load More button ---
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.id = 'extensionAllChatsTabLoadMoreBtn';
    loadMoreBtn.classList.add('load-more-btn');
    loadMoreBtn.classList.add('hidden'); // Initially hidden
    loadMoreBtn.textContent = 'Load More';
    container.appendChild(loadMoreBtn);
    // --- Filtering and pagination logic ---
    let lastFilter = '';
    let lastChatsData = null;
    let offset = 0;
    let totalChats = 0;
    async function doPopulate(filterValue, append = false) {
        lastFilter = filterValue;
        const result = await populateAllChatsTab({
            container: chatsTabContainer,
            loader,
            tab: container,
            filter: filterValue,
            cache: lastChatsData,
            setCache: (data) => { lastChatsData = data; },
            offset,
            append
        });
        totalChats = result && result.totalChats ? result.totalChats : 0;
        if (offset + MAX_RECENT_CHATS < totalChats) {
            loadMoreBtn.classList.remove('hidden');
        } else {
            loadMoreBtn.classList.add('hidden');
        }
    }
    filterInput.addEventListener('input', (e) => {
        offset = 0;
        chatsTabContainer.innerHTML = '';
        doPopulate(e.target.value.trim());
    });
    loadMoreBtn.addEventListener('click', () => {
        offset += MAX_RECENT_CHATS;
        doPopulate(lastFilter, true);
    });
    // Initial population
    await doPopulate('', false);
}

/**
 * Populate the All Chats tab with chat items, grouped and sorted.
 * @param {Object} param0 - Options for population.
 * @param {HTMLElement} param0.container - The container to render into.
 * @param {HTMLElement} param0.loader - Loader element.
 * @param {HTMLElement} param0.tab - Tab element.
 * @param {string} [param0.filter] - Optional filter string.
 * @param {Object} [param0.cache] - Optional cache of chat data.
 * @param {Function} [param0.setCache] - Optional callback to set cache.
 * @param {number} [param0.offset] - Offset for pagination.
 * @param {boolean} [param0.append] - Whether to append to container.
 * @returns {Object} - { totalChats }
 */
async function populateAllChatsTab({ container, loader, tab, filter = '', cache = null, setCache = null, offset = 0, append = false } = {}) {
    container = container || document.getElementById('extensionAllChatsTabContainer');
    loader = loader || document.getElementById('extensionAllChatsTabLoader');
    if (!loader || !container) return { totalChats: 0 };
    loader.classList.remove('displayNone');
    if (!append) container.innerHTML = '';
    let allChats = [];
    let chatStatsMap = {};
    if (cache && cache.allChats && cache.chatStatsMap) {
        allChats = cache.allChats;
        chatStatsMap = cache.chatStatsMap;
    } else {
        const context = SillyTavern.getContext();
        const characters = context.characters || {};
        // 1. Fetch all chat lists for all characters in parallel
        const chatListPromises = Object.entries(characters).map(async ([charId, char]) => {
            try {
                const chats = await getListOfCharacterChats(char.avatar);
                return chats.filter(chatName => typeof chatName === 'string' && chatName).map(chatName => ({
                    character: char.name || charId,
                    avatar: char.avatar,
                    file_name: chatName,
                    characterId: charId
                }));
            } catch (e) {
                return [];
            }
        });
        const chatLists = await Promise.all(chatListPromises);
        allChats = chatLists.flat();
        // 2. Fetch all stats for all characters in parallel
        const uniqueCharacterIds = [...new Set(allChats.map(chat => chat.characterId))];
        const statsPromises = uniqueCharacterIds.map(async (charId) => {
            try {
                const statsList = await getPastCharacterChats(charId);
                return statsList.map(stat => {
                    const fileName = String(stat.file_name).replace('.jsonl', '');
                    return [charId + ':' + fileName, stat];
                });
            } catch (e) {
                return [];
            }
        });
        const statsEntries = (await Promise.all(statsPromises)).flat();
        chatStatsMap = Object.fromEntries(statsEntries);
        if (setCache) setCache({ allChats, chatStatsMap });
    }
    allChats = allChats.map(chat => {
        const stat = chatStatsMap[chat.characterId + ':' + chat.file_name];
        let lastMesRaw = stat && stat.last_mes ? stat.last_mes : null;
        let lastMesDate = null;
        if (lastMesRaw) {
            // Use timestampToMoment (dayjs wrapper) for robust parsing
            const momentObj = timestampToMoment(lastMesRaw);
            if (momentObj && momentObj.isValid()) {
                lastMesDate = momentObj.toDate();
            }
        }
        return { ...chat, stat, last_mes: lastMesDate };
    }).filter(chat => chat.last_mes);
    // Ensure allChats is a flat array and sort strictly by date
    allChats.sort((a, b) => b.last_mes - a.last_mes);
    // --- Filtering ---
    let filterLower = filter ? filter.toLowerCase() : '';
    function chatMatches(chat) {
        if (!filterLower) return true;
        return (
            (chat.character && chat.character.toLowerCase().includes(filterLower)) ||
            (chat.file_name && chat.file_name.toLowerCase().includes(filterLower)) ||
            (chat.stat && chat.stat.mes && chat.stat.mes.toLowerCase().includes(filterLower))
        );
    }
    const filteredChats = allChats.filter(chatMatches);
    const totalChats = filteredChats.length;
    const chatsToShow = filteredChats.slice(offset, offset + MAX_RECENT_CHATS);
    // --- Render pinned and recent chats (filtered, paginated) ---
    // Always render all pinned chats, not just those in the current page
    const pinnedChatsRaw = getPinnedChats();
    const pinnedChats = pinnedChatsRaw.map(pinned => {
        // Try to find stat info from chatStatsMap
        const stat = chatStatsMap[pinned.characterId + ':' + pinned.file_name];
        // Try to get character info from allChats or SillyTavern context
        let chatInfo = allChats.find(c => c.characterId === pinned.characterId && c.file_name === pinned.file_name);
        if (!chatInfo) {
            // Fallback: try to get character info from context
            const context = SillyTavern.getContext();
            const char = context.characters && context.characters[pinned.characterId];
            chatInfo = {
                character: char ? (char.name || pinned.characterId) : pinned.characterId,
                avatar: char ? char.avatar : '',
                file_name: pinned.file_name,
                characterId: pinned.characterId,
                stat: stat,
                last_mes: stat && stat.last_mes ? timestampToMoment(stat.last_mes).toDate() : null
            };
        } else {
            chatInfo = { ...chatInfo, stat };
        }
        return chatInfo;
    }).filter(chat => chat && chat.last_mes);
    // Sort pinned chats by date
    pinnedChats.sort((a, b) => b.last_mes - a.last_mes);
    // Render all pinned chats at the top
    for (const chat of pinnedChats) {
        renderAllChatsTabItem(chat, container, true, null);
    }
    // --- Render recent chats (filtered, skip pinned) ---
    const pinnedSet = new Set(pinnedChats.map(chat => chat.characterId + ':' + chat.file_name));
    let lastDate = null;
    if (append) {
        // Find the last date separator in the container
        const dateSeparators = Array.from(container.querySelectorAll('.allChatsDateSeparator'));
        if (dateSeparators.length > 0) {
            const lastSeparator = dateSeparators[dateSeparators.length - 1];
            lastDate = lastSeparator.getAttribute('data-date') || null;
        }
    }
    for (const chat of chatsToShow) {
        if (pinnedSet.has(chat.characterId + ':' + chat.file_name)) continue;
        const stat = chat.stat;
        const chatMoment = stat && stat.last_mes ? timestampToMoment(stat.last_mes) : null;
        const chatDateStr = chatMoment ? chatMoment.format('YYYY-MM-DD') : '';
        if (chatDateStr !== lastDate) {
            lastDate = chatDateStr;
            const dateSeparator = document.createElement('div');
            dateSeparator.className = 'allChatsDateSeparator';
            dateSeparator.textContent = chatMoment ? chatMoment.format('LL') : '';
            dateSeparator.setAttribute('data-date', chatDateStr); // For tracking
            container.appendChild(dateSeparator);
        }
        renderAllChatsTabItem(chat, container, false, null);
    }
    loader.classList.add('displayNone');
    return { totalChats };
}

/**
 * Build a tree structure from the flat folder list.
 * @param {Array} folders - Flat array of folder objects.
 * @returns {Array} Array of root folder nodes, each with children property.
 */
function buildFolderTree(folders) {
    const idToNode = {};
    folders.forEach(folder => {
        idToNode[folder.id] = { ...folder, children: [] };
    });
    const roots = [];
    folders.forEach(folder => {
        if (folder.parent && idToNode[folder.parent]) {
            idToNode[folder.parent].children.push(idToNode[folder.id]);
        } else {
            roots.push(idToNode[folder.id]);
        }
    });
    return roots;
}

/**
 * Render all chat folders UI inside the given container, with nested subfolders.
 * @param {HTMLElement} container - The container to render folders into.
 * @param {Object} folderedChats - Map of folderId to array of chats.
 * @param {Array} [folderNodes] - Optional, for recursion: array of folder nodes.
 * @param {number} [level] - Optional, for recursion: current nesting level.
 */
function renderAllChatsFoldersUI(container, folderedChats, folderNodes, level = 0) {
    const folders = getFolders().slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!folderNodes) folderNodes = buildFolderTree(folders);
    // Build a map for quick parent lookup
    const folderMap = Object.fromEntries(folders.map(f => [f.id, f]));
    folderNodes.forEach(folder => {
        const folderSection = document.createElement('div');
        folderSection.className = 'collapsible-section folder-collapsible-section';
        folderSection.style.paddingLeft = level === 0 ? '0' : '28px';
        const header = document.createElement('div');
        header.className = 'collapsible-header';
        const chevron = document.createElement('i');
        chevron.className = 'fa-solid chevron fa-chevron-down';
        header.appendChild(chevron);
        const folderIcon = document.createElement('i');
        folderIcon.className = 'fa-solid fa-folder folder-title-icon';
        header.appendChild(folderIcon);
        const folderTitle = document.createElement('span');
        folderTitle.className = 'folder-title';
        folderTitle.textContent = folder.name;
        header.appendChild(folderTitle);
        // --- Add double-click to rename folder ---
        let clickTimeout = null;
        header.addEventListener('click', (e) => {
            // Expand/collapse if clicking chevron, folder icon, or folder name
            if (
                e.target === chevron ||
                e.target === folderIcon ||
                e.target === folderTitle ||
                e.currentTarget === e.target
            ) {
                // Wait to see if this is a double-click
                if (clickTimeout) clearTimeout(clickTimeout);
                clickTimeout = setTimeout(() => {
                    // Only run if not interrupted by double-click
                    folderSection.classList.toggle('collapsed');
                    content.classList.toggle('collapsed');
                    if (folderSection.classList.contains('collapsed')) {
                        chevron.classList.remove('fa-chevron-down');
                        chevron.classList.add('fa-chevron-right');
                    } else {
                        chevron.classList.remove('fa-chevron-right');
                        chevron.classList.add('fa-chevron-down');
                    }
                }, 200); // 250ms: typical double-click threshold
            }
        });
        folderTitle.addEventListener('dblclick', async (e) => {
            if (clickTimeout) clearTimeout(clickTimeout); // Prevent single-click action
            e.stopPropagation();
            // Show popup to rename folder
            const content = document.createElement('div');
            content.innerHTML = `<h3>Rename folder</h3>`;
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = folder.name;
            nameInput.style.width = '100%';
            nameInput.style.marginTop = '8px';
            nameInput.className = 'chatplus_menu_input';
            content.appendChild(nameInput);
            const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
                okButton: t`Rename`,
                cancelButton: t`Cancel`,
                wide: true
            });
            const result = await popup.show();
            if (result !== POPUP_RESULT.CANCELLED && nameInput.value.trim() && nameInput.value.trim() !== folder.name) {
                // Update folder name
                const folders = getFolders();
                const idx = folders.findIndex(f => f.id === folder.id);
                if (idx !== -1) {
                    folders[idx].name = nameInput.value.trim();
                    setFolders(folders);
                    await refreshFoldersTab();
                }
            }
        });
        const removeBtn = document.createElement('button');
        removeBtn.className = 'removeFolderBtn';
        removeBtn.title = 'Remove folder';
        removeBtn.innerHTML = '<i class="fa-solid fa-xmark icon-grey"></i>';
        removeBtn.onclick = async (e) => {
            e.stopPropagation();
            // --- Folder preview for the remove confirmation popup ---
            const folderPreview = document.createElement('div');
            folderPreview.style.display = 'flex';
            folderPreview.style.alignItems = 'center';
            folderPreview.style.gap = '8px';
            folderPreview.style.margin = '8px 0 4px 0';
            folderPreview.style.fontWeight = 'bold';
            folderPreview.style.fontSize = '1em';
            const folderIcon = document.createElement('i');
            folderIcon.className = 'fa-solid fa-folder folder-title-icon';
            folderIcon.style.fontSize = '1.1em';
            folderPreview.appendChild(folderIcon);
            const folderName = document.createElement('span');
            folderName.textContent = folder ? folder.name : folder.id;
            folderPreview.appendChild(folderName);
            // Popup content
            const content = document.createElement('div');
            content.innerHTML = `<h3 style='margin-bottom:8px;'>${t`Remove this folder?`}</h3>`;
            content.appendChild(folderPreview);
            const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                okButton: t`Remove`,
                cancelButton: t`Cancel`
            });
            const result = await popup.show();
            if (result === POPUP_RESULT.AFFIRMATIVE) {
                removeFolder(folder.id);
                await refreshFoldersTab();
            }
        };
        header.appendChild(removeBtn);
        folderSection.appendChild(header);
        const content = document.createElement('div');
        content.className = 'collapsible-content';
        folderSection.appendChild(content);
        let collapsed = false;
        try { collapsed = localStorage.getItem('topInfoBar_folder_collapsed_' + folder.id) === '1'; } catch { }
        if (collapsed) {
            folderSection.classList.add('collapsed');
            content.classList.add('collapsed');
            chevron.classList.remove('fa-chevron-down');
            chevron.classList.add('fa-chevron-right');
        }
        const chats = folderedChats[folder.id] || [];
        if (chats.length > 0) {
            for (const chat of chats) renderAllChatsTabItem(chat, content, false, folder.id);
        }
        container.appendChild(folderSection);
        // --- Render subfolders recursively inside content ---
        if (folder.children && folder.children.length > 0) {
            renderAllChatsFoldersUI(content, folderedChats, folder.children, level + 1);
        }
    });
}

/**
 * Render a single chat item in the Recent Chats tab.
 * @param {Object} chat - Chat object.
 * @param {HTMLElement} container - Container to append the item to.
 * @param {boolean} isPinned - Whether the chat is pinned.
 * @param {string|null} folderId - Folder ID if in a folder, else null.
 */
function renderAllChatsTabItem(chat, container, isPinned, folderId) {
    const stat = chat.stat;
    const tabItem = document.createElement('div');
    tabItem.classList.add('tabItem');
    if (isPinned) tabItem.classList.add('pinned');
    tabItem.classList.add('tabItem-root');
    const previewImg = document.createElement('img');
    previewImg.className = 'tabItem-previewImg';
    previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
    previewImg.alt = chat.character || '';
    const nameRow = document.createElement('div');
    nameRow.className = 'tabItem-nameRow';
    nameRow.textContent = `${chat.character}: ${chat.file_name}`;
    const pinBtn = document.createElement('button');
    pinBtn.className = 'pinBtn tabItem-pinBtn';
    if (folderId && folderId !== 'pinned') {
        pinBtn.title = t`Remove from folder`;
        pinBtn.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
    } else {
        pinBtn.title = isPinned ? t`Unpin chat` : t`Pin or folder chat`;
        pinBtn.innerHTML = isPinned ? '<i class="fa-solid fa-thumbtack"></i>' : '<i class="fa-regular fa-bookmark"></i>';
    }
    pinBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (folderId && folderId !== 'pinned') {
            // --- Show a preview in the remove confirmation popup ---
            // Folder preview
            const folder = getFolders().find(f => f.id === folderId);
            const folderPreview = document.createElement('div');
            folderPreview.style.display = 'flex';
            folderPreview.style.alignItems = 'center';
            folderPreview.style.gap = '8px';
            folderPreview.style.margin = '8px 0 4px 0';
            folderPreview.style.fontWeight = 'bold';
            folderPreview.style.fontSize = '1em';
            const folderIcon = document.createElement('i');
            folderIcon.className = 'fa-solid fa-folder folder-title-icon';
            folderIcon.style.fontSize = '1.1em';
            folderPreview.appendChild(folderIcon);
            const folderName = document.createElement('span');
            folderName.textContent = folder ? folder.name : folderId;
            folderPreview.appendChild(folderName);
            // Chat preview
            const preview = document.createElement('div');
            preview.className = 'tabItem tabItem-singleline';
            preview.style.display = 'flex';
            preview.style.flexDirection = 'row';
            preview.style.alignItems = 'center';
            preview.style.gap = '10px';
            preview.style.margin = '8px 0 2px 0';
            const previewImg = document.createElement('img');
            previewImg.className = 'tabItem-previewImg';
            previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
            previewImg.alt = chat.character || '';
            const nameRow = document.createElement('div');
            nameRow.className = 'tabItem-nameRow';
            nameRow.textContent = `${chat.character}: ${chat.file_name}`;
            preview.appendChild(previewImg);
            preview.appendChild(nameRow);
            // Popup content
            const content = document.createElement('div');
            content.innerHTML = `<h3 style='margin-bottom:8px;'>${t`Remove the chat from the folder?`}</h3>`;
            content.appendChild(folderPreview);
            content.appendChild(preview);
            // Use Popup constructor to allow DOM content
            const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                okButton: t`Remove`,
                cancelButton: t`Cancel`
            });
            const result = await popup.show();
            if (result === POPUP_RESULT.AFFIRMATIVE) {
                removeChatFromFolder(chat, folderId);
                await refreshFoldersTab();
            }
            return;
        }
        if (isPinned) {
            // --- Show a preview in the unpin confirmation popup ---
            const preview = document.createElement('div');
            preview.className = 'tabItem tabItem-singleline';
            preview.style.display = 'flex';
            preview.style.flexDirection = 'row';
            preview.style.alignItems = 'center';
            preview.style.gap = '10px';
            preview.style.margin = '8px 0 2px 0';
            const previewImg = document.createElement('img');
            previewImg.className = 'tabItem-previewImg';
            previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
            previewImg.alt = chat.character || '';
            const nameRow = document.createElement('div');
            nameRow.className = 'tabItem-nameRow';
            nameRow.textContent = `${chat.character}: ${chat.file_name}`;
            preview.appendChild(previewImg);
            preview.appendChild(nameRow);
            // Popup content
            const content = document.createElement('div');
            content.innerHTML = `<h3 style='margin-bottom:8px;'>${t`Unpin this chat?`}</h3>`;
            content.appendChild(preview);
            const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                okButton: t`Unpin`,
                cancelButton: t`Cancel`
            });
            const result = await popup.show();
            if (result === POPUP_RESULT.AFFIRMATIVE) {
                togglePinChat(chat);
                await populateAllChatsTab();
            }
            return;
        }
        const selectedFolderId = await promptSelectFolderOrPinned(chat);
        console.log(`Selected folder ID: ${selectedFolderId}`);
        if (selectedFolderId === 'pinned') {
            togglePinChat(chat);
            await populateAllChatsTab();
        } else if (selectedFolderId) {
            const folderIds = getChatFolderIds(chat);
            if (!folderIds.includes(selectedFolderId)) assignChatToFolder(chat, selectedFolderId);
            await refreshFoldersTab();
        }
    });
    if (isPinned || (folderId && folderId !== 'recent')) {
        tabItem.classList.add('tabItem-singleline');
        tabItem.style.display = 'flex';
        tabItem.style.flexDirection = 'row';
        tabItem.style.alignItems = 'center';
        tabItem.style.gap = '10px';
        nameRow.style.flex = '1 1 auto';
        nameRow.style.overflow = 'hidden';
        nameRow.style.textOverflow = 'ellipsis';
        nameRow.style.whiteSpace = 'nowrap';
        tabItem.appendChild(previewImg);
        tabItem.appendChild(nameRow);
        tabItem.appendChild(pinBtn);
        if (isPinned) {
            const rePinBtn = document.createElement('button');
            rePinBtn.className = 'pinBtn tabItem-pinBtn';
            rePinBtn.title = t`Pin or folder chat`;
            rePinBtn.innerHTML = '<i class="fa-regular fa-bookmark"></i>';
            rePinBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const selectedFolderId = await promptSelectFolderOrPinned(chat);
                if (selectedFolderId === 'pinned') return;
                else if (selectedFolderId) {
                    const folderIds = getChatFolderIds(chat);
                    if (!folderIds.includes(selectedFolderId)) assignChatToFolder(chat, selectedFolderId);
                    await populateAllChatsTab();
                }
            });
            tabItem.appendChild(rePinBtn);
        }
    } else {
        const infoContainer = document.createElement('div');
        infoContainer.className = 'tabItem-infoContainer';
        const nameRow = document.createElement('div');
        nameRow.className = 'tabItem-nameRow';
        nameRow.textContent = `${chat.character}: ${chat.file_name}`;
        const bottomRow = document.createElement('div');
        bottomRow.className = 'tabItem-bottomRow';
        const chatMessage = document.createElement('div');
        chatMessage.classList.add('chatMessage', 'tabItem-message');
        chatMessage.textContent = stat && stat.mes ? stat.mes : '';
        chatMessage.title = stat && stat.mes ? stat.mes : '';
        bottomRow.appendChild(chatMessage);
        bottomRow.appendChild(pinBtn);
        infoContainer.appendChild(nameRow);
        infoContainer.appendChild(bottomRow);
        previewImg.classList.add('tabItem-img');
        tabItem.appendChild(previewImg);
        tabItem.appendChild(infoContainer);
    }
    container.appendChild(tabItem);
    tabItem.addEventListener('click', async (e) => {
        if (e.target.closest('.tabItem-pinBtn')) return;
        const context = SillyTavern.getContext();
        if (String(context.characterId) !== String(chat.characterId)) {
            await selectCharacterById(chat.characterId);
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        await openChatById(chat.file_name);
    });
}

// =========================
// 6. Extension Settings UI
// =========================
/**
 * Render the extension settings panel for Top Info Bar.
 * Adds an entry to the SillyTavern extensions menu.
 */
function renderExtensionSettings() {
    const context = SillyTavern.getContext();
    const settingsKey = MODULE_NAME;
    const settings = context.extensionSettings[settingsKey] ?? {};
    const EXTENSION_NAME = 'ChatsPlus';
    const settingsContainer = document.getElementById(`${settingsKey}-container`) ?? document.getElementById('extensions_settings2');
    if (!settingsContainer) return;
    if (settingsContainer.querySelector(`#${settingsKey}-drawer`)) return;
    // =========================
    // Extension Settings Drawer UI
    // =========================
    const inlineDrawer = document.createElement('div');
    inlineDrawer.id = `${settingsKey}-drawer`;
    inlineDrawer.classList.add('inline-drawer');
    settingsContainer.append(inlineDrawer);
    const inlineDrawerToggle = document.createElement('div');
    inlineDrawerToggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');
    const extensionNameElement = document.createElement('b');
    extensionNameElement.textContent = EXTENSION_NAME;
    const inlineDrawerIcon = document.createElement('div');
    inlineDrawerIcon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
    inlineDrawerToggle.append(extensionNameElement, inlineDrawerIcon);
    const inlineDrawerContent = document.createElement('div');
    inlineDrawerContent.classList.add('inline-drawer-content');
    inlineDrawerContent.innerHTML = `<p>Enable or disable the Top Info Bar extension.</p>`;
    // =========================
    // Enable/Disable Checkbox
    // =========================
    const enabledCheckboxLabel = document.createElement('label');
    enabledCheckboxLabel.classList.add('checkbox_label');
    enabledCheckboxLabel.htmlFor = `${settingsKey}-enabled`;
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.id = `${settingsKey}-enabled`;
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = settings.enabled ?? true;
    enabledCheckbox.addEventListener('change', () => {
        settings.enabled = enabledCheckbox.checked;
        context.saveSettingsDebounced();
    });
    const enabledCheckboxText = document.createElement('span');
    enabledCheckboxText.textContent = t`Enable ChatsPlus (needs reload)`;
    enabledCheckboxLabel.append(enabledCheckbox, enabledCheckboxText);
    inlineDrawerContent.append(enabledCheckboxLabel);
    // =========================
    // Default Tab Selection UI
    // =========================
    const defaultTabSection = document.createElement('div');
    defaultTabSection.style.margin = '16px 0';
    defaultTabSection.innerHTML = `<b>${t`Default Tab on Startup:`}</b>`;
    const tabRow = document.createElement('div');
    tabRow.className = 'chatsplus-tabs-container';
    const tabOptions = [
        { label: t`Characters`, value: 'characters' },
        { label: t`Recent Chats`, value: 'recent' },
        { label: t`Folders`, value: 'folders' }
    ];
    let defaultTab = settings.defaultTab ?? 'characters';
    tabOptions.forEach(opt => {
        const btn = document.createElement('button');
        btn.textContent = opt.label;
        btn.className = 'chatsplus-tab';
        if (defaultTab === opt.value) btn.classList.add('active');
        btn.onclick = () => {
            defaultTab = opt.value;
            settings.defaultTab = defaultTab;
            context.saveSettingsDebounced();
            // Update button styles
            tabRow.querySelectorAll('button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
        tabRow.appendChild(btn);
    });
    defaultTabSection.appendChild(tabRow);
    inlineDrawerContent.appendChild(defaultTabSection);
    // =========================
    // Data Management Buttons (Import, Export, Wipe)
    // =========================
    // --- Export/Import Buttons at Bottom ---
    const exportImportRow = document.createElement('div');
    exportImportRow.style.display = 'flex';
    exportImportRow.style.gap = '10px';
    exportImportRow.style.margin = '24px 0 0 0';

    // Import Button
    const importBtn = document.createElement('button');
    importBtn.textContent = t`Import`;
    importBtn.className = 'settings-action-btn';
    importBtn.style.background = '#2a7';
    importBtn.style.color = '#fff';
    importBtn.style.border = 'none';
    importBtn.onclick = async () => {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.style.display = 'none';
        fileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const imported = JSON.parse(text);
                if (typeof imported !== 'object' || Array.isArray(imported)) throw new Error('Invalid data');
                const content = document.createElement('div');
                content.innerHTML = `<h3 style='margin-bottom:8px;'>${t`Import ChatsPlus data?`}</h3><p>${t`This will overwrite your current ChatsPlus settings, folders, and pinned chats.`}</p>`;
                const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                    okButton: t`Import`,
                    cancelButton: t`Cancel`
                });
                const result = await popup.show();
                if (result === POPUP_RESULT.AFFIRMATIVE) {
                    context.extensionSettings[settingsKey] = imported;
                    await context.saveSettingsDebounced();
                    alert(t`ChatsPlus data imported successfully!\nA reload is necessary to apply changes.`);
                }
            } catch (err) {
                alert(t`Failed to import: ` + err.message);
            }
        };
        document.body.appendChild(fileInput);
        fileInput.click();
        setTimeout(() => document.body.removeChild(fileInput), 5000);
    };
    // Export Button
    const exportBtn = document.createElement('button');
    exportBtn.textContent = t`Export`;
    exportBtn.className = 'settings-action-btn';
    exportBtn.style.background = '#27a';
    exportBtn.style.color = '#fff';
    exportBtn.style.border = 'none';
    exportBtn.onclick = () => {
        const data = JSON.stringify(context.extensionSettings[settingsKey] ?? {}, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ChatsPlus-settings.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    };
    // Append buttons to the row and drawer content
    exportImportRow.appendChild(importBtn);
    exportImportRow.appendChild(exportBtn);
    inlineDrawerContent.appendChild(exportImportRow);
    inlineDrawer.append(inlineDrawerToggle, inlineDrawerContent);
    inlineDrawerToggle.addEventListener('click', function () {
        this.classList.toggle('open');
        inlineDrawerIcon.classList.toggle('down');
        inlineDrawerIcon.classList.toggle('up');
        inlineDrawerContent.classList.toggle('open');
    });
    // --- Danger Zone (Wipe Button) ---
    const dangerZone = document.createElement('div');
    dangerZone.style.display = 'flex';
    dangerZone.style.justifyContent = 'flex-end';
    dangerZone.style.margin = '12px 0 8px 0';
    dangerZone.style.padding = '8px 0 8px 0';
    dangerZone.style.borderTop = '1.5px solid var(--SmartThemeDangerColor, #a33)';
    dangerZone.style.background = 'rgba(200,0,0,0.03)';

    const wipeBtn = document.createElement('button');
    wipeBtn.textContent = t`Wipe`;
    wipeBtn.className = 'settings-action-btn';
    wipeBtn.style.background = 'var(--SmartThemeDangerColor, #7a2222)';
    wipeBtn.style.color = '#fff';
    wipeBtn.style.border = 'none';
    wipeBtn.style.margin = '0 0 0 0';
    wipeBtn.style.fontWeight = 'bold';
    wipeBtn.onclick = async () => {
        const content = document.createElement('div');
        content.innerHTML = `<h3 style='margin-bottom:8px;'>${t`Reset all ChatsPlus data?`}</h3><p>${t`This will remove all folders, pinned chats, and settings for this extension (no chats will be affected, only this extension's inner data). This cannot be undone.`}</p>`;
        const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Wipe`,
            cancelButton: t`Cancel`
        });
        const result = await popup.show();
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            context.extensionSettings[settingsKey] = structuredClone(defaultSettings);
            context.saveSettingsDebounced();
            alert(t`ChatsPlus data wiped successfully!\nA reload is necessary to apply changes.`);
        }
    };
    dangerZone.appendChild(wipeBtn);
    inlineDrawerContent.appendChild(dangerZone);
}

// =========================
// 7. Tab Management UI
// =========================
/**
 * Add the menu as a tab on the "Character Management" menu.
 * Sets up tab switching and folder tab refresh logic.
 */
function addTabToCharManagementMenu() {
    const menu = document.getElementById('right-nav-panel');
    if (!menu) return;
    if (menu.querySelector('#chatsplus-tab-row')) return;
    const charListButtonAndHotSwaps = menu.querySelector('#CharListButtonAndHotSwaps');
    const existingSiblings = [];
    let sibling = charListButtonAndHotSwaps ? charListButtonAndHotSwaps.nextElementSibling : null;
    while (sibling) {
        if (sibling.tagName !== 'HR') existingSiblings.push(sibling);
        sibling = sibling.nextElementSibling;
    }
    if (!charListButtonAndHotSwaps) return;
    const hr = document.createElement('hr');
    const tabRow = document.createElement('div');
    tabRow.id = 'chatsplus-tab-row';
    tabRow.className = 'chatsplus-tabs-container';
    const charactersTabButton = document.createElement('button');
    charactersTabButton.textContent = 'Characters';
    charactersTabButton.id = 'chatsplus-characters-tab-button';
    charactersTabButton.className = 'chatsplus-tab active';
    tabRow.appendChild(charactersTabButton);
    const recentChatsTabButton = document.createElement('button');
    recentChatsTabButton.id = 'chatsplus-recent-chats-tab-button';
    recentChatsTabButton.textContent = 'Recent Chats';
    recentChatsTabButton.className = 'chatsplus-tab';
    tabRow.appendChild(recentChatsTabButton);
    const foldersTabButton = document.createElement('button');
    foldersTabButton.id = 'chatsplus-folders-tab-button';
    foldersTabButton.textContent = 'Folders';
    foldersTabButton.className = 'chatsplus-tab';
    tabRow.appendChild(foldersTabButton);
    charListButtonAndHotSwaps.insertAdjacentElement('afterend', tabRow);
    // charListButtonAndHotSwaps.insertAdjacentElement('afterend', hr);
    const tabsWrapper = document.createElement('div');
    tabsWrapper.id = 'chatsplus-tab-content-wrapper';
    tabsWrapper.className = 'chatsplus-tab-content';
    const charactersTab = document.createElement('div');
    charactersTab.id = 'chatsplus-characters-tab';
    charactersTab.style.display = '';
    tabsWrapper.appendChild(charactersTab);
    const recentChatsTab = document.createElement('div');
    recentChatsTab.id = 'chatsplus-recent-chats-tab';
    recentChatsTab.style.display = 'none';
    tabsWrapper.appendChild(recentChatsTab);
    const foldersTab = document.createElement('div');
    foldersTab.id = 'chatsplus-folders-tab';
    foldersTab.style.display = 'none';
    tabsWrapper.appendChild(foldersTab);
    existingSiblings.forEach(sibling => { charactersTab.appendChild(sibling); });
    activateTab = function (tabIdx) {
        charactersTabButton.classList.remove('active');
        recentChatsTabButton.classList.remove('active');
        foldersTabButton.classList.remove('active');
        charactersTab.style.display = 'none';
        recentChatsTab.style.display = 'none';
        foldersTab.style.display = 'none';
        if (tabIdx === 0) {
            charactersTabButton.classList.add('active');
            charactersTab.style.display = '';
        } else if (tabIdx === 1) {
            recentChatsTabButton.classList.add('active');
            recentChatsTab.style.display = '';
            renderAllChatsInRecentChatsTab();
        } else if (tabIdx === 2) {
            foldersTabButton.classList.add('active');
            foldersTab.style.display = '';
            if (!foldersTab.querySelector('.folders-tab-container')) refreshFoldersTab();
        }
    };
    charactersTabButton.addEventListener('click', () => activateTab(0));
    recentChatsTabButton.addEventListener('click', () => activateTab(1));
    foldersTabButton.addEventListener('click', () => activateTab(2));
    activateTab(2);
    menu.insertBefore(tabsWrapper, tabRow.nextSibling);
}

// =========================
// 7.1. Folders Tab Refresh Function
// =========================
refreshFoldersTab = async function () {
    const foldersTab = document.getElementById('chatsplus-folders-tab');
    if (!foldersTab) return;
    foldersTab.innerHTML = '';
    const foldersTabContainer = document.createElement('div');
    foldersTabContainer.className = 'folders-tab-container';
    const addFolderRow = document.createElement('div');
    addFolderRow.className = 'add-folder-row';
    const addFolderBtn = document.createElement('button');
    addFolderBtn.className = 'add-folder-btn';
    addFolderBtn.title = 'Add Folder';
    addFolderBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
    addFolderBtn.addEventListener('click', async () => {
        // Show a popup with a list of all folders as radio inputs and allow selecting one (or none)
        // Build a tree structure for folders
        function buildFolderTreeForPopup(folders) {
            const idToNode = {};
            folders.forEach(folder => {
                idToNode[folder.id] = { ...folder, children: [] };
            });
            const roots = [];
            folders.forEach(folder => {
                if (folder.parent && idToNode[folder.parent]) {
                    idToNode[folder.parent].children.push(idToNode[folder.id]);
                } else {
                    roots.push(idToNode[folder.id]);
                }
            });
            return roots;
        }
        // Recursively render radio buttons for folders
        function renderFolderRadios(nodes, radioName, container, level = 0) {
            nodes.forEach(folder => {
                const label = document.createElement('label');
                label.style.display = 'flex';
                label.style.alignItems = 'center';
                label.style.marginLeft = (level * 20) + 'px';
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = radioName;
                radio.value = folder.id;
                label.appendChild(radio);
                label.appendChild(document.createTextNode(' 📁 ' + folder.name));
                container.appendChild(label);
                if (folder.children && folder.children.length > 0) {
                    renderFolderRadios(folder.children, radioName, container, level + 1);
                }
            });
        }
        const folders = getFolders().slice().sort((a, b) => a.name.localeCompare(b.name));
        const content = document.createElement('div');
        content.innerHTML = `<h3>${t`Select a parent folder (optional):`}</h3>`;
        const radioGroup = document.createElement('div');
        radioGroup.className = 'chatplus_radio_group';
        const radioName = 'parent-folder-radio';
        // Option for no parent
        const noneLabel = document.createElement('label');
        noneLabel.style.display = 'flex';
        noneLabel.style.alignItems = 'center';
        const noneRadio = document.createElement('input');
        noneRadio.type = 'radio';
        noneRadio.name = radioName;
        noneRadio.value = '';
        noneRadio.checked = true;
        noneLabel.appendChild(noneRadio);
        noneLabel.appendChild(document.createTextNode(' ' + t`No parent`));
        radioGroup.appendChild(noneLabel);
        // Render folder radios as tree
        const folderTree = buildFolderTreeForPopup(folders);
        renderFolderRadios(folderTree, radioName, radioGroup, 0);
        content.appendChild(radioGroup);
        content.innerHTML += `<hr style='margin:10px 0;'>`;
        const nameLabel = document.createElement('label');
        nameLabel.textContent = t`Enter folder name:`;
        nameLabel.className = 'chatplus_menu_label';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'chatplus_menu_input';
        content.appendChild(nameLabel);
        content.appendChild(nameInput);

        const popup = new Popup(
            content,
            POPUP_TYPE.TEXT,
            '',
            {
                okButton: t`Add`,
                cancelButton: t`Cancel`,
                wide: true,
                large: true,
            }
        );
        // Wait for popup result
        const popupResult = await popup.show();
        console.log(`Popup result: ${popupResult}`);
        if (popupResult === POPUP_RESULT.CANCELLED) return null; // User cancelled the popup
        // Read the selected radio after popup closes
        const selectedRadio = content.querySelector('input[type="radio"]:checked');
        const selectedFolderId = selectedRadio && selectedRadio.value ? selectedRadio.value : null;
        const name = nameInput.value;
        console.log('Adding folder:', name, 'with parent ID:', selectedFolderId);
        if (name && name.trim()) {
            addFolder(name.trim(), selectedFolderId);
            await refreshFoldersTab();
        }
    });
    const addFolderLabel = document.createElement('span');
    addFolderLabel.className = 'add-folder-label';
    addFolderLabel.textContent = 'Add Folder';
    addFolderLabel.addEventListener('click', () => addFolderBtn.click());
    addFolderRow.appendChild(addFolderBtn);
    addFolderRow.appendChild(addFolderLabel);
    foldersTabContainer.appendChild(addFolderRow);
    let allChats = [];
    if (SillyTavern.getContext().characters) {
        const characters = SillyTavern.getContext().characters;
        // Parallelize fetching chat lists for all characters
        const chatListPromises = Object.entries(characters).map(async ([charId, char]) => {
            try {
                const chats = await getListOfCharacterChats(char.avatar);
                return chats.filter(chatName => typeof chatName === 'string' && chatName).map(chatName => ({
                    character: char.name || charId,
                    avatar: char.avatar,
                    file_name: chatName,
                    characterId: charId
                }));
            } catch (e) { return []; }
        });
        const chatLists = await Promise.all(chatListPromises);
        allChats = chatLists.flat();
    }
    let chatStatsMap = {};
    // Parallelize fetching stats for all characters
    const uniqueCharacterIds = [...new Set(allChats.map(chat => chat.characterId))];
    const statsPromises = uniqueCharacterIds.map(async (charId) => {
        try {
            const statsList = await getPastCharacterChats(charId);
            return statsList.map(stat => {
                const fileName = String(stat.file_name).replace('.jsonl', '');
                return [charId + ':' + fileName, stat];
            });
        } catch (e) { return []; }
    });
    const statsEntries = (await Promise.all(statsPromises)).flat();
    chatStatsMap = Object.fromEntries(statsEntries);
    allChats = allChats.map(chat => {
        const stat = chatStatsMap[chat.characterId + ':' + chat.file_name];
        let lastMesRaw = stat && stat.last_mes ? stat.last_mes : null;
        let lastMesDate = null;
        if (lastMesRaw) {
            // Use timestampToMoment (dayjs wrapper) for robust parsing
            const momentObj = timestampToMoment(lastMesRaw);
            if (momentObj && momentObj.isValid()) {
                lastMesDate = momentObj.toDate();
            }
        }
        return { ...chat, stat, last_mes: lastMesDate };
    }).filter(chat => chat.last_mes);
    const folderedChats = {};
    const folders = getFolders();
    for (const folder of folders) folderedChats[folder.id] = [];
    for (const chat of allChats) {
        const folderIds = getChatFolderIds(chat);
        for (const folderId of folderIds) {
            if (folderedChats[folderId]) folderedChats[folderId].push(chat);
        }
    }
    renderAllChatsFoldersUI(foldersTabContainer, folderedChats);
    foldersTab.appendChild(foldersTabContainer);
};

// =========================
// 8. Initialization
// =========================

/**
 * Initialize the extension: highlight, settings, and tab menu.
 * Adds event listeners for tab switching.
 */
(function initExtension() {
    const context = SillyTavern.getContext();
    const settingsKey = MODULE_NAME;
    const settings = context.extensionSettings[settingsKey] ?? {};
    renderExtensionSettings();

    // Listen for chatRenamed event
    /*
        // event.detail = { chatId, newName }
        const { chatId, newName } = event.detail;
        // Try to extract characterId from current context (best effort)
        let characterId = null;
        const context = SillyTavern.getContext();
        if (context.characterId !== undefined) {
            characterId = context.characterId;
        } else if (context.groupId !== undefined) {
            characterId = context.groupId; // fallback for group chats
        }
        if (!characterId) return;
        // Update pinnedChats
        let pinned = getPinnedChats();
        let changed = false;
        pinned = pinned.map(chat => {
            if (chat.file_name === chatId && chat.characterId === characterId) {
                changed = true;
                return { ...chat, file_name: newName };
            }
            return chat;
        });
        if (changed) setPinnedChats(pinned);
        // Update chatFolders
        let map = getChatFoldersMap();
        const oldKey = characterId + ':' + chatId;
        const newKey = characterId + ':' + newName;
        if (map[oldKey]) {
            map[newKey] = map[oldKey];
            delete map[oldKey];
            setChatFoldersMap(map);
        }
        // Optionally, show a notification (remove alert for production)
        alert(`Chat renamed from ${chatId} to ${newName}`);
    */

    // Enable/Disable the extension
    if (settings.enabled === false) return;

    // Initialize the extension
    addJQueryHighlight();
    addTabToCharManagementMenu();

    // Activate the default tab on startup
    const defaultTab = settings.defaultTab ?? 'characters';
    if (typeof activateTab === 'function') {
        if (defaultTab === 'characters') {
            setTimeout(() => {
                activateTab(0);
            }, 1000); // Delay to ensure everything is loaded
        } else if (defaultTab === 'recent') {
            setTimeout(() => {
                renderAllChatsInRecentChatsTab();
                activateTab(1);
            }, 1000); // Delay to ensure everything is loaded
        } else if (defaultTab === 'folders') {
            setTimeout(() => {
                refreshFoldersTab();
                activateTab(2);
            }, 1000); // Delay to ensure everything is loaded
        }
    }

    // Focus Characters tab when #rm_button_characters is clicked (the button to go back to the list view of the characters)
    const charBtn = document.getElementById('rm_button_characters');
    if (charBtn) {
        charBtn.addEventListener('click', () => {
            if (typeof activateTab === 'function') activateTab(0);
        });
    }
})();
