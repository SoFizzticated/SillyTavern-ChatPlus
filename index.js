// =========================
// 1. Imports & Constants
// =========================
import { addJQueryHighlight } from './jquery-highlight.js';
import { getGroupAvatar, getGroupBlock, getGroupPastChats, groups, select_group_chats } from '../../../group-chats.js';
import { getPastCharacterChats, selectCharacterById, renameGroupOrCharacterChat, event_types, setActiveGroup } from '../../../../script.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { timestampToMoment } from '../../../utils.js';
import { deleteAttachment } from '../../../chats.js';
import { extension_settings } from '../../../extensions.js';
import { t } from '../../../i18n.js';

const {
    getCurrentChatId,
    getRequestHeaders,
    openGroupChat,
    openCharacterChat,
    getThumbnailUrl,
    extensionSettings,
    saveSettingsDebounced,
    eventSource
} = SillyTavern.getContext();
const MODULE_NAME = 'chatsPlus';
const defaultSettings = {
    pinnedChats: [],
};
if (!('folders' in defaultSettings)) defaultSettings.folders = [];
if (!('chatFolders' in defaultSettings)) defaultSettings.chatFolders = {};
const MAX_RECENT_CHATS = 100;

// =========================
// 2. Settings & State Management
// =========================
let activateTab = null;
let refreshFoldersTab = null; // will be defined after function definitions
let recentChatsTabContainer = null;
let isRefreshingFoldersTab = false; // Flag to prevent concurrent refreshes

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
            // Chat preview for this folder 
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
                    let isGroup = false;
                    if (SillyTavern.getContext().characters && SillyTavern.getContext().characters[chatObj.characterId]) {
                        char = SillyTavern.getContext().characters[chatObj.characterId];
                    } else {
                        // Check if this is a group chat
                        const group = groups.find(g => g.id === chatObj.characterId);
                        if (group) {
                            isGroup = true;
                            char = { name: group.name || `Group ${group.id}`, avatar: group.avatar || '' };
                        }
                    }
                    const chat = {
                        character: char ? (char.name || chatObj.characterId) : chatObj.characterId,
                        avatar: char ? char.avatar : '',
                        file_name: chatObj.file_name,
                        characterId: chatObj.characterId,
                        stat: undefined,
                        isGroup: isGroup
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

                    // Character/Group image (character = img, group = div)
                    let previewImg;
                    if (isGroup) {
                        previewImg = document.createElement('div');
                        previewImg.className = 'tabItem-previewImg group-preview';

                        const group = groups.find(g => g.id === chatObj.characterId);
                        if (group) {
                            let result = getGroupAvatar(group);
                            if (result && result.length > 0) {
                                const groupElement = result[0];
                                groupElement.style.width = '100%';
                                groupElement.style.height = '100%';
                                groupElement.style.minWidth = 'unset';
                                previewImg.appendChild(groupElement);
                            }
                        }
                    } else {
                        previewImg = document.createElement('img');
                        previewImg.className = 'tabItem-previewImg';
                        previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                        previewImg.alt = chat.character || '';
                    }
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
    // Chat preview for the chat being pinned
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

    // Character/Group image (character = img, group = div)
    // Check if this is a group chat
    const isGroup = chat.isGroup || false;
    let previewImg;
    if (isGroup) {
        previewImg = document.createElement('div');
        previewImg.className = 'tabItem-previewImg group-preview';

        const group = groups.find(g => g.id === chat.characterId);
        if (group) {
            let result = getGroupAvatar(group);
            if (result && result.length > 0) {
                const groupElement = result[0];
                groupElement.style.width = '100%';
                groupElement.style.height = '100%';
                groupElement.style.minWidth = 'unset';
                previewImg.appendChild(groupElement);
            }
        }
    } else {
        previewImg = document.createElement('img');
        previewImg.className = 'tabItem-previewImg';
        previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
        previewImg.alt = chat.character || '';
    }

    const nameRow = document.createElement('div');
    nameRow.className = 'tabItem-nameRow';
    nameRow.textContent = `${chat.character}: ${chat.file_name}`;
    tabItem.appendChild(previewImg);
    tabItem.appendChild(nameRow);
    previewContainer.appendChild(tabItem);
    content.appendChild(previewContainer);

    // Separator between chat preview and pinned chats
    const separatorPreviewToPinned = document.createElement('hr');
    separatorPreviewToPinned.style.margin = '8px 0';
    content.appendChild(separatorPreviewToPinned);

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
    // Preview pinned chats 
    const pinnedChats = getPinnedChats();
    if (pinnedChats.length > 0) {
        const pinnedPreviewContainer = document.createElement('div');
        pinnedPreviewContainer.className = 'pinned-preview-chats';
        pinnedPreviewContainer.style.marginLeft = '32px';
        pinnedPreviewContainer.style.marginBottom = '4px';
        pinnedChats.forEach(chatObj => {
            let char = null;
            let isGroup = false;
            if (SillyTavern.getContext().characters && SillyTavern.getContext().characters[chatObj.characterId]) {
                char = SillyTavern.getContext().characters[chatObj.characterId];
            } else {
                // Check if this might be a group chat by checking if the ID exists in groups
                const group = groups.find(g => g.id === chatObj.characterId);
                if (group) {
                    isGroup = true;
                    char = { name: group.name || `Group ${group.id}`, avatar: group.avatar || '' };
                }
            }

            const chat = {
                character: char ? (char.name || chatObj.characterId) : chatObj.characterId,
                avatar: char ? char.avatar : '',
                file_name: chatObj.file_name,
                characterId: chatObj.characterId,
                stat: undefined,
                isGroup: isGroup
            };
            const tabItem = document.createElement('div');
            tabItem.classList.add('tabItem', 'tabItem-singleline');
            tabItem.style.display = 'flex';
            tabItem.style.flexDirection = 'row';
            tabItem.style.alignItems = 'center';
            tabItem.style.gap = '10px';
            tabItem.style.marginBottom = '2px';

            // Character/Group image (character = img, group = div)
            let previewImg;
            if (isGroup) {
                previewImg = document.createElement('div');
                previewImg.className = 'tabItem-previewImg group-preview';

                const group = groups.find(g => g.id === chatObj.characterId);
                if (group) {
                    let result = getGroupAvatar(group);
                    if (result && result.length > 0) {
                        const groupElement = result[0];
                        groupElement.style.width = '100%';
                        groupElement.style.height = '100%';
                        groupElement.style.minWidth = 'unset';
                        previewImg.appendChild(groupElement);
                    }
                }
            } else {
                previewImg = document.createElement('img');
                previewImg.className = 'tabItem-previewImg';
                previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                previewImg.alt = chat.character || '';
            }

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
    const separatorPinnedToFolders = document.createElement('hr');
    separatorPinnedToFolders.style.margin = '8px 0';
    radioGroup.appendChild(separatorPinnedToFolders);

    // Render folder radios as tree, with previews
    const folderTree = buildFolderTree(folders);
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
 * @param {boolean} isGroup - Whether this is a group chat.
 * @param {string|null} groupId - The group ID if this is a group chat.
 */
async function openChatById(chatId, isGroup = false, groupId = null) {
    const context = SillyTavern.getContext();
    if (!chatId) return;

    if (isGroup && groupId && typeof openGroupChat === 'function') {
        await openGroupChat(groupId, chatId);
    } else if (context.groupId && typeof openGroupChat === 'function') {
        await openGroupChat(context.groupId, chatId);
    } else if (context.characterId !== undefined && typeof openCharacterChat === 'function') {
        await openCharacterChat(chatId);
    }
    // Call the window["chatsPlusRenderSelectedChat"] to update the "Currently Selected Chats"
    window['chatsPlusRenderSelectedChat'](chatId);
    return;
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
    // Add filter input at the top 
    const filterRow = document.createElement('div');
    filterRow.className = 'filter-row';

    // Create input wrapper for positioning the clear button
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'filter-input-wrapper';
    inputWrapper.style.position = 'relative';
    inputWrapper.style.display = 'flex';
    inputWrapper.style.alignItems = 'center';

    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter chats...';
    filterInput.className = 'filter-input';
    filterInput.style.paddingRight = '30px'; // Make room for the clear button

    // Create clear button
    const clearButton = document.createElement('button');
    clearButton.className = 'filter-clear-button';
    clearButton.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    clearButton.title = 'Clear filter';

    inputWrapper.appendChild(filterInput);
    inputWrapper.appendChild(clearButton);
    filterRow.appendChild(inputWrapper);
    container.appendChild(filterRow);
    // Loader and main container 
    const loader = document.createElement('div');
    loader.id = 'extensionAllChatsTabLoader';
    loader.className = 'allChatsTabLoader'; // Initially hidden
    const loaderIcon = document.createElement('i');
    loaderIcon.className = 'fa-2x fa-solid fa-gear fa-spin';
    loader.appendChild(loaderIcon);
    container.appendChild(loader);
    const chatsTabContainer = document.createElement('div');
    chatsTabContainer.id = 'extensionAllChatsTabContainer';
    container.appendChild(chatsTabContainer);
    // Load More button
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.id = 'extensionAllChatsTabLoadMoreBtn';
    loadMoreBtn.classList.add('load-more-btn');
    loadMoreBtn.classList.add('hidden'); // Initially hidden
    loadMoreBtn.textContent = 'Load More';
    container.appendChild(loadMoreBtn);
    // Filtering and pagination logic
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

        // Show/hide clear button based on input content
        if (e.target.value.trim().length > 0) {
            clearButton.style.display = 'block';
        } else {
            clearButton.style.display = 'none';
        }
    });

    // Clear button functionality
    clearButton.addEventListener('click', () => {
        filterInput.value = '';
        clearButton.style.display = 'none';
        offset = 0;
        chatsTabContainer.innerHTML = '';
        doPopulate('');
        filterInput.focus(); // Keep focus on the input after clearing
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
    let groupsMap = {}; // Add groups map for caching
    if (cache && cache.allChats && cache.chatStatsMap) {
        allChats = cache.allChats;
        chatStatsMap = cache.chatStatsMap;
        groupsMap = cache.groupsMap || {}; // Include groups in cache
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
                    characterId: charId,
                    isGroup: false
                }));
            } catch (e) {
                return [];
            }
        });

        // 2. Fetch all group chats in parallel
        let groupChats = [];
        try {
            const groupsResponse = await fetch('/api/groups/all', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            if (groupsResponse.ok) {
                const groups = await groupsResponse.json();

                // Build groups map for later use
                groupsMap = Object.fromEntries(groups.map(group => [group.id, group]));

                const groupChatPromises = groups.map(async (group) => {
                    try {
                        const chats = await getGroupPastChats(group.id);
                        return chats.map(chat => {
                            const fileName = typeof chat === 'string' ? chat.replace('.jsonl', '') : String(chat.file_name || chat).replace('.jsonl', '');
                            return {
                                character: group.name || `Group ${group.id}`,
                                avatar: group.avatar || '', // Groups might have avatars
                                file_name: fileName,
                                characterId: group.id,
                                isGroup: true,
                                groupMembers: group.members || [] // Store group member info
                            };
                        });
                    } catch (e) {
                        return [];
                    }
                });

                const groupChatLists = await Promise.all(groupChatPromises);
                groupChats = groupChatLists.flat();
            }
        } catch (e) {
            console.warn('Failed to load group chats:', e);
        }

        const characterChatLists = await Promise.all(chatListPromises);
        allChats = [...characterChatLists.flat(), ...groupChats];

        // 3. Fetch stats for both character and group chats
        const uniqueCharacterIds = [...new Set(allChats.filter(chat => !chat.isGroup).map(chat => chat.characterId))];
        const uniqueGroupIds = [...new Set(allChats.filter(chat => chat.isGroup).map(chat => chat.characterId))];

        // Character stats
        const characterStatsPromises = uniqueCharacterIds.map(async (charId) => {
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

        // Group stats
        const groupStatsPromises = uniqueGroupIds.map(async (groupId) => {
            try {
                const statsList = await getGroupPastChats(groupId);
                return statsList.map(stat => {
                    const fileName = typeof stat === 'string' ? stat.replace('.jsonl', '') : String(stat.file_name || stat).replace('.jsonl', '');
                    return [groupId + ':' + fileName, stat];
                });
            } catch (e) {
                return [];
            }
        });

        const statsEntries = (await Promise.all([...characterStatsPromises, ...groupStatsPromises])).flat();
        chatStatsMap = Object.fromEntries(statsEntries);
        if (setCache) setCache({ allChats, chatStatsMap, groupsMap }); // Include groups in cache
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
    // Filtering
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
    // Render pinned and recent chats (filtered, paginated) (always render all pinned chats, not just those in the current page)
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

            // Check if this might be a group chat (groups would not be in context.characters)
            if (!char) {
                // This could be a group chat, check groupsMap
                const group = groupsMap[pinned.characterId];
                chatInfo = {
                    character: group ? (group.name || `Group ${group.id}`) : pinned.characterId,
                    avatar: group ? (group.avatar || '') : '',
                    file_name: pinned.file_name,
                    characterId: pinned.characterId,
                    stat: stat,
                    last_mes: stat && stat.last_mes ? timestampToMoment(stat.last_mes).toDate() : null,
                    isGroup: true,
                    groupMembers: group ? (group.members || []) : []
                };
            } else {
                chatInfo = {
                    character: char.name || pinned.characterId,
                    avatar: char.avatar || '',
                    file_name: pinned.file_name,
                    characterId: pinned.characterId,
                    stat: stat,
                    last_mes: stat && stat.last_mes ? timestampToMoment(stat.last_mes).toDate() : null,
                    isGroup: false
                };
            }
        } else {
            chatInfo = { ...chatInfo, stat };
        }
        return chatInfo;
    }).filter(chat => chat && chat.last_mes && chatMatches(chat));
    // Sort pinned chats alphabetically by character, then file_name
    pinnedChats.sort((a, b) => {
        const charA = (a.character || '').toLowerCase();
        const charB = (b.character || '').toLowerCase();
        if (charA < charB) return -1;
        if (charA > charB) return 1;
        const fileA = (a.file_name || '').toLowerCase();
        const fileB = (b.file_name || '').toLowerCase();
        if (fileA < fileB) return -1;
        if (fileA > fileB) return 1;
        return 0;
    });
    // Render all pinned chats at the top
    if (pinnedChats.length > 0) {
        // Add pinned section header
        const pinnedSeparator = document.createElement('div');
        pinnedSeparator.className = 'allChatsDateSeparator pinned-section-header';
        pinnedSeparator.textContent = '📌 ' + t`Pinned Chats`;
        pinnedSeparator.style.fontWeight = 'bold';
        container.appendChild(pinnedSeparator);

        for (const chat of pinnedChats) {
            renderAllChatsTabItem(chat, container, true, null);
        }
    }
    // Render recent chats (filtered)
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
        // Add pencil icon for renaming
        const pencilIcon = document.createElement('i');
        pencilIcon.className = 'fa-solid fa-pencil-alt folder-rename-icon';
        pencilIcon.style.cursor = 'pointer';
        pencilIcon.style.margin = '0 6px 0 6px';
        header.appendChild(pencilIcon);
        const folderTitle = document.createElement('span');
        folderTitle.className = 'folder-title';
        folderTitle.textContent = folder.name;
        header.appendChild(folderTitle);
        header.addEventListener('click', (e) => {
            // Expand/collapse if clicking chevron or header (not pencil)
            if (
                e.target === chevron ||
                e.target === folderTitle ||
                e.currentTarget === e.target
            ) {
                folderSection.classList.toggle('collapsed');
                content.classList.toggle('collapsed');
                if (folderSection.classList.contains('collapsed')) {
                    chevron.classList.remove('fa-chevron-down');
                    chevron.classList.add('fa-chevron-right');
                } else {
                    chevron.classList.remove('fa-chevron-right');
                    chevron.classList.add('fa-chevron-down');
                }
            }
        });
        // Helper function to show the rename folder popup
        async function showRenameFolderPopup(folder) {
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
            // Add Enter key support
            nameInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    popup.okButton.click(); // Trigger the popup's OK button
                }
            });
            const result = await popup.show();
            if ((result === POPUP_RESULT.AFFIRMATIVE) && nameInput.value.trim() && nameInput.value.trim() !== folder.name) {
                // Update folder name
                const folders = getFolders();
                const idx = folders.findIndex(f => f.id === folder.id);
                if (idx !== -1) {
                    folders[idx].name = nameInput.value.trim();
                    setFolders(folders);
                    await refreshFoldersTab();
                }
            }
        }

        // Helper function to show the add chats to folder popup
        async function showAddChatsToFolderPopup(folder) {
            const content = document.createElement('div');
            content.innerHTML = `<h3>Add Chats to "${folder.name}"</h3>`;
            content.style.width = '100%';
            content.style.maxHeight = '70vh';
            content.style.overflow = 'hidden';
            content.style.display = 'flex';
            content.style.flexDirection = 'column';

            // Add filter input
            const filterRow = document.createElement('div');
            filterRow.className = 'filter-row';
            filterRow.style.marginBottom = '10px';

            const inputWrapper = document.createElement('div');
            inputWrapper.className = 'filter-input-wrapper';
            inputWrapper.style.position = 'relative';
            inputWrapper.style.display = 'flex';
            inputWrapper.style.alignItems = 'center';

            const filterInput = document.createElement('input');
            filterInput.type = 'text';
            filterInput.placeholder = 'Filter chats...';
            filterInput.className = 'filter-input chatplus_menu_input';
            filterInput.style.paddingRight = '30px';
            filterInput.style.width = '100%';

            const clearButton = document.createElement('button');
            clearButton.className = 'filter-clear-button';
            clearButton.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            clearButton.title = 'Clear filter';
            clearButton.style.position = 'absolute';
            clearButton.style.right = '5px';
            clearButton.style.background = 'none';
            clearButton.style.border = 'none';
            clearButton.style.cursor = 'pointer';
            clearButton.style.display = 'none';

            inputWrapper.appendChild(filterInput);
            inputWrapper.appendChild(clearButton);
            filterRow.appendChild(inputWrapper);
            content.appendChild(filterRow);

            // Add selection controls
            const selectionControls = document.createElement('div');
            selectionControls.style.display = 'flex';
            selectionControls.style.gap = '10px';
            selectionControls.style.marginBottom = '10px';
            selectionControls.style.alignItems = 'center';

            const selectedCount = document.createElement('span');
            selectedCount.style.marginLeft = 'auto';
            selectedCount.style.fontSize = '0.9em';
            selectedCount.style.color = '#888';
            selectedCount.textContent = '0 selected';

            selectionControls.appendChild(selectedCount);
            content.appendChild(selectionControls);

            // Chat list container
            const chatsContainer = document.createElement('div');
            chatsContainer.style.flex = '1 1 auto';
            chatsContainer.style.overflow = 'auto';
            chatsContainer.style.maxHeight = '50vh';
            chatsContainer.style.border = '1px solid #444';
            chatsContainer.style.borderRadius = '4px';
            chatsContainer.style.padding = '8px';
            content.appendChild(chatsContainer);

            // Loader
            const loader = document.createElement('div');
            loader.className = 'allChatsTabLoader';
            loader.style.textAlign = 'center';
            loader.style.padding = '20px';
            const loaderIcon = document.createElement('i');
            loaderIcon.className = 'fa-2x fa-solid fa-gear fa-spin';
            loader.appendChild(loaderIcon);
            chatsContainer.appendChild(loader);

            // Track selected chats
            const selectedChats = new Set();
            let allChatsData = [];

            // Function to render chat items with checkboxes
            function renderChatItemWithCheckbox(chat, container) {
                const chatItem = document.createElement('div');
                chatItem.className = 'tabItem tabItem-singleline bookmark-chat-item';
                chatItem.style.display = 'flex';
                chatItem.style.alignItems = 'center';
                chatItem.style.gap = '10px';
                chatItem.style.padding = '8px';
                chatItem.style.margin = '2px 0';
                chatItem.style.borderRadius = '4px';
                chatItem.style.cursor = 'pointer';
                chatItem.style.border = '1px solid transparent';

                // Checkbox
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.style.marginRight = '8px';
                const chatKey = `${chat.characterId}:${chat.file_name}`;
                checkbox.checked = selectedChats.has(chatKey);

                // Character/Group image
                let previewImg;
                if (chat.isGroup) {
                    previewImg = document.createElement('div');
                    previewImg.className = 'tabItem-previewImg group-preview';

                    const group = groups.find(g => g.id === chat.characterId);
                    if (group) {
                        let result = getGroupAvatar(group);
                        if (result && result.length > 0) {
                            const groupElement = result[0];
                            groupElement.style.width = '100%';
                            groupElement.style.height = '100%';
                            groupElement.style.minWidth = 'unset';
                            previewImg.appendChild(groupElement);
                        }
                    }
                } else {
                    previewImg = document.createElement('img');
                    previewImg.className = 'tabItem-previewImg';
                    previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                    previewImg.alt = chat.character || '';
                }
                previewImg.style.width = '32px';
                previewImg.style.height = '32px';

                // Chat info
                const chatInfo = document.createElement('div');
                chatInfo.style.flex = '1 1 auto';
                chatInfo.style.overflow = 'hidden';

                const nameRow = document.createElement('div');
                nameRow.className = 'tabItem-nameRow';
                nameRow.textContent = `${chat.character}: ${chat.file_name}`;
                nameRow.style.whiteSpace = 'nowrap';
                nameRow.style.overflow = 'hidden';
                nameRow.style.textOverflow = 'ellipsis';

                const messageRow = document.createElement('div');
                messageRow.className = 'tabItem-message';
                messageRow.style.fontSize = '0.85em';
                messageRow.style.color = '#888';
                messageRow.style.whiteSpace = 'nowrap';
                messageRow.style.overflow = 'hidden';
                messageRow.style.textOverflow = 'ellipsis';
                messageRow.textContent = chat.stat && chat.stat.mes ? chat.stat.mes : 'No messages';

                chatInfo.appendChild(nameRow);
                chatInfo.appendChild(messageRow);

                chatItem.appendChild(checkbox);
                chatItem.appendChild(previewImg);
                chatItem.appendChild(chatInfo);

                // Click handling
                const toggleSelection = () => {
                    if (selectedChats.has(chatKey)) {
                        selectedChats.delete(chatKey);
                        checkbox.checked = false;
                        chatItem.style.backgroundColor = '';
                        chatItem.style.border = '1px solid transparent';
                    } else {
                        selectedChats.add(chatKey);
                        checkbox.checked = true;
                        chatItem.style.backgroundColor = 'rgba(100, 150, 255, 0.2)';
                        chatItem.style.border = '1px solid rgba(100, 150, 255, 0.5)';
                    }
                    updateSelectedCount();
                };

                chatItem.addEventListener('click', toggleSelection);
                checkbox.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleSelection();
                });

                // Initial styling if selected
                if (selectedChats.has(chatKey)) {
                    chatItem.style.backgroundColor = 'rgba(100, 150, 255, 0.2)';
                    chatItem.style.border = '1px solid rgba(100, 150, 255, 0.5)';
                }

                container.appendChild(chatItem);
            }

            // Function to update selected count
            function updateSelectedCount() {
                selectedCount.textContent = `${selectedChats.size} selected`;
            }

            // Function to populate chats
            async function populateChats(filterValue = '') {
                loader.style.display = 'block';

                // Get all chats (similar to populateAllChatsTab)
                if (allChatsData.length === 0) {
                    const context = SillyTavern.getContext();
                    const characters = context.characters || {};

                    // Fetch all chat lists for all characters in parallel
                    const chatListPromises = Object.entries(characters).map(async ([charId, char]) => {
                        try {
                            const chats = await getListOfCharacterChats(char.avatar);
                            return chats.filter(chatName => typeof chatName === 'string' && chatName).map(chatName => ({
                                character: char.name || charId,
                                avatar: char.avatar,
                                file_name: chatName,
                                characterId: charId,
                                isGroup: false
                            }));
                        } catch (e) {
                            return [];
                        }
                    });
                    const chatLists = await Promise.all(chatListPromises);
                    let allChats = chatLists.flat();

                    // Add group chats
                    try {
                        const groupsResponse = await fetch('/api/groups/all', {
                            method: 'POST',
                            headers: getRequestHeaders(),
                        });
                        if (groupsResponse.ok) {
                            const groups = await groupsResponse.json();
                            const groupChatPromises = groups.map(async (group) => {
                                try {
                                    const chats = await getGroupPastChats(group.id);
                                    return chats.map(chat => {
                                        const fileName = typeof chat === 'string' ? chat.replace('.jsonl', '') : String(chat.file_name || chat).replace('.jsonl', '');
                                        return {
                                            character: group.name || `Group ${group.id}`,
                                            avatar: group.avatar || '',
                                            file_name: fileName,
                                            characterId: group.id,
                                            isGroup: true,
                                            groupMembers: group.members || []
                                        };
                                    });
                                } catch (e) {
                                    return [];
                                }
                            });

                            const groupChatLists = await Promise.all(groupChatPromises);
                            allChats = allChats.concat(groupChatLists.flat());
                        }
                    } catch (e) {
                        console.warn('Failed to load group chats in add to folder popup:', e);
                    }

                    // Fetch stats for both character and group chats
                    const uniqueCharacterIds = [...new Set(allChats.filter(chat => !chat.isGroup).map(chat => chat.characterId))];
                    const uniqueGroupIds = [...new Set(allChats.filter(chat => chat.isGroup).map(chat => chat.characterId))];

                    // Character stats
                    const characterStatsPromises = uniqueCharacterIds.map(async (charId) => {
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

                    // Group stats
                    const groupStatsPromises = uniqueGroupIds.map(async (groupId) => {
                        try {
                            const statsList = await getGroupPastChats(groupId);
                            return statsList.map(stat => {
                                const fileName = typeof stat === 'string' ? stat.replace('.jsonl', '') : String(stat.file_name || stat).replace('.jsonl', '');
                                return [groupId + ':' + fileName, stat];
                            });
                        } catch (e) {
                            return [];
                        }
                    });

                    const statsEntries = (await Promise.all([...characterStatsPromises, ...groupStatsPromises])).flat();
                    const chatStatsMap = Object.fromEntries(statsEntries);

                    allChatsData = allChats.map(chat => {
                        const stat = chatStatsMap[chat.characterId + ':' + chat.file_name];
                        let lastMesDate = null;
                        if (stat && stat.last_mes) {
                            const momentObj = timestampToMoment(stat.last_mes);
                            if (momentObj && momentObj.isValid()) {
                                lastMesDate = momentObj.toDate();
                            }
                        }
                        return { ...chat, stat, last_mes: lastMesDate };
                    }).filter(chat => chat.last_mes).sort((a, b) => b.last_mes - a.last_mes);
                }

                // Filter chats
                const filterLower = filterValue.toLowerCase();
                const filteredChats = allChatsData.filter(chat => {
                    if (!filterLower) return true;
                    return (
                        (chat.character && chat.character.toLowerCase().includes(filterLower)) ||
                        (chat.file_name && chat.file_name.toLowerCase().includes(filterLower)) ||
                        (chat.stat && chat.stat.mes && chat.stat.mes.toLowerCase().includes(filterLower))
                    );
                });

                // Clear container (except loader)
                const chatItems = chatsContainer.querySelectorAll('.bookmark-chat-item');
                chatItems.forEach(item => item.remove());

                // Render filtered chats
                filteredChats.forEach(chat => {
                    renderChatItemWithCheckbox(chat, chatsContainer);
                });

                loader.style.display = 'none';
                updateSelectedCount();
            }

            // Filter input handling
            filterInput.addEventListener('input', (e) => {
                const value = e.target.value.trim();
                populateChats(value);
                clearButton.style.display = value.length > 0 ? 'block' : 'none';
            });

            clearButton.addEventListener('click', () => {
                filterInput.value = '';
                clearButton.style.display = 'none';
                populateChats('');
                filterInput.focus();
            });

            // Initial population
            await populateChats();

            const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                okButton: t`Add to Folder`,
                cancelButton: t`Cancel`,
                wide: true,
                large: true
            });

            const result = await popup.show();
            if (result === POPUP_RESULT.AFFIRMATIVE && selectedChats.size > 0) {
                // Add the selected chats to the folder
                let addedCount = 0;
                for (const chatKey of selectedChats) {
                    const [characterId, fileName] = chatKey.split(':', 2);
                    const chat = { characterId, file_name: fileName };

                    // Check if chat is already in the folder
                    const existingFolders = getChatFolderIds(chat);
                    if (!existingFolders.includes(folder.id)) {
                        assignChatToFolder(chat, folder.id);
                        addedCount++;
                    }
                }

                // Show success message
                const confirmContent = document.createElement('div');
                confirmContent.innerHTML = `<h3>Success!</h3><p>Added ${addedCount} chats to "${folder.name}".</p>`;
                if (addedCount !== selectedChats.size) {
                    const skipped = selectedChats.size - addedCount;
                    confirmContent.innerHTML += `<p><small>${skipped} chats were already in the folder.</small></p>`;
                }
                const confirmPopup = new Popup(confirmContent, POPUP_TYPE.TEXT, '', {
                    okButton: t`OK`
                });
                await confirmPopup.show();

                // Refresh the folders tab to show the updated folder contents
                await refreshFoldersTab();
            }
        }

        // Pencil icon click triggers rename popup
        pencilIcon.addEventListener('click', async (e) => {
            e.stopPropagation();
            await showRenameFolderPopup(folder);
        });

        // Bookmark icon for folder bookmarking
        const bookmarkBtn = document.createElement('button');
        bookmarkBtn.className = 'bookmarkFolderBtn pinBtn tabItem-pinBtn';
        bookmarkBtn.title = 'Add multiple chats to folder';
        bookmarkBtn.innerHTML = '<i class="fa-regular fa-bookmark"></i>';
        bookmarkBtn.onclick = async (e) => {
            e.stopPropagation();
            await showAddChatsToFolderPopup(folder);
        };
        header.appendChild(bookmarkBtn);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'removeFolderBtn';
        removeBtn.title = 'Remove folder';
        removeBtn.innerHTML = '<i class="fa-solid fa-xmark icon-grey"></i>';
        removeBtn.onclick = async (e) => {
            e.stopPropagation();
            // Folder preview for the remove confirmation popup
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
        // Render subfolders recursively inside content
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

    // Character/Group image (character = img, group = div)
    // Check if this is a group chat
    const isGroup = chat.isGroup || false;
    let previewImg;
    if (isGroup) {
        previewImg = document.createElement('div');
        previewImg.className = 'tabItem-previewImg group-preview';

        // Find the actual group object using the chat's characterId (which is the group ID for group chats)
        const group = groups.find(g => g.id === chat.characterId);
        if (group) {
            // getGroupBlock returns a jQuery object, so we need to get the actual DOM element
            let result = getGroupAvatar(group);
            if (result && result.length > 0) {
                // Extract the actual DOM element from the jQuery object
                const groupElement = result[0];
                // Set required styles for consistent sizing
                groupElement.style.width = '100%';
                groupElement.style.height = '100%';
                groupElement.style.minWidth = 'unset';
                previewImg.appendChild(groupElement);
            }
        }
    } else {
        previewImg = document.createElement('img');
        previewImg.className = 'tabItem-previewImg';
        previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
        previewImg.alt = chat.character || '';
        previewImg.style.width = '32px';
        previewImg.style.height = '32px';
    }

    // Pencil icon for renaming chat
    const pencilIcon = document.createElement('i');
    pencilIcon.className = 'fa-solid fa-pencil-alt chat-rename-icon';
    pencilIcon.style.cursor = 'pointer';
    pencilIcon.style.margin = '0 6px 0 6px';
    pencilIcon.title = t`Rename chat`;
    pencilIcon.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Show rename popup for chat
        const content = document.createElement('div');
        content.innerHTML = `<h3>${t`Rename chat`}</h3>`;
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = chat.file_name;
        nameInput.style.width = '100%';
        nameInput.style.marginTop = '8px';
        nameInput.className = 'chatplus_menu_input';
        content.appendChild(nameInput);
        const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
            okButton: t`Rename`,
            cancelButton: t`Cancel`,
            wide: true
        });
        nameInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                popup.okButton.click();
            }
        });
        const result = await popup.show();
        if ((result === POPUP_RESULT.AFFIRMATIVE) && nameInput.value.trim() && nameInput.value.trim() !== chat.file_name) {
            const context = SillyTavern.getContext();
            const loader = document.getElementById('extensionAllChatsTabLoader') || null;
            await renameGroupOrCharacterChat({
                characterId: chat.characterId,
                groupId: context.groupId,
                oldFileName: chat.file_name,
                newFileName: nameInput.value.trim(),
                loader
            });
            handleChatRename(chat, nameInput.value.trim());
            // Refresh UI after renaming
            if (typeof populateAllChatsTab === 'function') await populateAllChatsTab();
            if (typeof refreshFoldersTab === 'function') await refreshFoldersTab();
        }
    });

    const nameRow = document.createElement('div');
    nameRow.className = 'tabItem-nameRow';
    nameRow.textContent = `${chat.character}: ${chat.file_name}`;
    const pinBtn = document.createElement('button');
    pinBtn.className = 'pinBtn tabItem-pinBtn';
    if (folderId && folderId !== 'pinned') {
        pinBtn.title = t`Remove from folder`;
        pinBtn.innerHTML = `
            <span class="icon-slash-overlay">
                <i class="fa-solid fa-thumbtack"></i>
            </span>
        `;
    } else {
        pinBtn.title = isPinned ? t`Unpin chat` : t`Pin or folder chat`;
        pinBtn.innerHTML = isPinned
            ? `
                <span class="icon-slash-overlay">
                    <i class="fa-solid fa-thumbtack"></i>
                </span>
            `
            : '<i class="fa-regular fa-bookmark"></i>';
    }
    pinBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (folderId && folderId !== 'pinned') {
            // Show a preview in the remove confirmation popup 
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

            // Character/Group image (character = img, group = div)
            const isGroup = chat.isGroup || false;
            let previewImg;
            if (isGroup) {
                previewImg = document.createElement('div');
                previewImg.className = 'tabItem-previewImg group-preview';

                const group = groups.find(g => g.id === chat.characterId);
                if (group) {
                    let result = getGroupAvatar(group);
                    if (result && result.length > 0) {
                        const groupElement = result[0];
                        groupElement.style.width = '100%';
                        groupElement.style.height = '100%';
                        groupElement.style.minWidth = 'unset';
                        previewImg.appendChild(groupElement);
                    }
                }
            } else {
                previewImg = document.createElement('img');
                previewImg.className = 'tabItem-previewImg';
                previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                previewImg.alt = chat.character || '';
            }

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
            // Show a preview in the unpin confirmation popup
            const preview = document.createElement('div');
            preview.className = 'tabItem tabItem-singleline';
            preview.style.display = 'flex';
            preview.style.flexDirection = 'row';
            preview.style.alignItems = 'center';
            preview.style.gap = '10px';
            preview.style.margin = '8px 0 2px 0';

            // Character/Group image (character = img, group = div)
            const isGroup = chat.isGroup || false;
            let previewImg;
            if (isGroup) {
                previewImg = document.createElement('div');
                previewImg.className = 'tabItem-previewImg group-preview';

                const group = groups.find(g => g.id === chat.characterId);
                if (group) {
                    let result = getGroupAvatar(group);
                    if (result && result.length > 0) {
                        const groupElement = result[0];
                        groupElement.style.width = '100%';
                        groupElement.style.height = '100%';
                        groupElement.style.minWidth = 'unset';
                        previewImg.appendChild(groupElement);
                    }
                }
            } else {
                previewImg = document.createElement('img');
                previewImg.className = 'tabItem-previewImg';
                previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                previewImg.alt = chat.character || '';
            }

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
                await refreshFoldersTab();
            }
            return;
        }
        const selectedFolderId = await promptSelectFolderOrPinned(chat);
        if (selectedFolderId === 'pinned') {
            togglePinChat(chat);
            await populateAllChatsTab();
            await refreshFoldersTab();
        } else if (selectedFolderId) {
            const folderIds = getChatFolderIds(chat);
            if (!folderIds.includes(selectedFolderId)) {
                assignChatToFolder(chat, selectedFolderId);
                await refreshFoldersTab();
            }
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
                    if (!folderIds.includes(selectedFolderId)) {
                        assignChatToFolder(chat, selectedFolderId);
                        await refreshFoldersTab();
                    }
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
        nameRow.textContent = chat.isGroup
            ? `👥 ${chat.character}: ${chat.file_name}`
            : `${chat.character}: ${chat.file_name}`;
        const bottomRow = document.createElement('div');
        bottomRow.className = 'tabItem-bottomRow';
        // Pencil icon, first message, pin button (in this order)
        bottomRow.appendChild(pencilIcon);
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
        if (e.target.closest('.chat-rename-icon')) return;
        const context = SillyTavern.getContext();

        if (chat.isGroup) {
            // Handle group chat opening
            // First set the active group, then open the group chat
            const group = groups.find(g => g.id === chat.characterId);
            setActiveGroup(group);
            select_group_chats(group.id, true);
            await openChatById(chat.file_name, true, group.id);
        } else {
            // Existing character chat logic
            if (String(context.characterId) !== String(chat.characterId)) {
                await selectCharacterById(chat.characterId);
                await new Promise(resolve => setTimeout(resolve, 150));
            }
            await openChatById(chat.file_name);
        }
    });
}

// =========================
// 6. Extension Settings UI
// =========================
/**
 * Render the extension settings panel for ChatsPlus.
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
    inlineDrawerContent.innerHTML = `<p>Enable or disable the ChatsPlus extension.</p>`;
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
    // Backup Management Section
    // =========================
    const backupSection = document.createElement('div');
    backupSection.style.margin = '16px 0';
    backupSection.innerHTML = `<div><b>${t`Backup Management:`}</b></div>`;

    // Header for Import/Export section
    const importExportHeader = document.createElement('span');
    importExportHeader.textContent = t`Import/Export current extension data:`;
    backupSection.appendChild(importExportHeader);

    // Export/Import Buttons row at Bottom
    const exportImportRow = document.createElement('div');
    exportImportRow.style.display = 'flex';
    exportImportRow.style.gap = '10px';
    exportImportRow.style.margin = '8px 0';

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
    backupSection.appendChild(exportImportRow);

    inlineDrawerContent.appendChild(backupSection);

    // =========================
    // Manual Reload Section
    // =========================
    const reloadSection = document.createElement('div');
    reloadSection.style.margin = '16px 0';
    reloadSection.innerHTML = `<div><b>${t`Manual Reload:`}</b></div>`;

    const reloadDescription = document.createElement('p');
    reloadDescription.textContent = t`If the Recent Chats or Folders tabs become unresponsive, use this button to reload them.`;
    reloadDescription.style.fontSize = '0.9em';
    reloadDescription.style.color = '#888';
    reloadDescription.style.margin = '4px 0 8px 0';
    reloadSection.appendChild(reloadDescription);

    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = t`Reload Tabs`;
    reloadBtn.className = 'settings-action-btn';
    reloadBtn.style.background = '#f39c12';
    reloadBtn.style.color = '#fff';
    reloadBtn.style.border = 'none';
    reloadBtn.style.padding = '8px 16px';
    reloadBtn.style.borderRadius = '4px';
    reloadBtn.style.cursor = 'pointer';
    reloadBtn.onclick = async () => {
        // Show loading state
        const originalText = reloadBtn.textContent;
        reloadBtn.textContent = t`Reloading...`;
        reloadBtn.disabled = true;

        try {
            // Clear the Recent Chats tab container to force a full reload
            const recentChatsContainer = getOrCreateRecentChatsTabContainer();
            if (recentChatsContainer) {
                recentChatsContainer.innerHTML = '';
                recentChatsTabContainer = null; // Reset the cached container
            }

            // Force refresh the Folders tab
            if (typeof refreshFoldersTab === 'function') {
                await refreshFoldersTab();
            }

            // If Recent Chats tab is currently active, reload it
            const recentChatsTab = document.getElementById('chatsplus-recent-chats-tab');
            const recentChatsButton = document.getElementById('chatsplus-recent-chats-tab-button');
            if (recentChatsTab && recentChatsTab.style.display !== 'none') {
                await renderAllChatsInRecentChatsTab();
            }

            // Show success feedback
            reloadBtn.textContent = t`Reloaded!`;
            reloadBtn.style.background = '#27ae60';
            setTimeout(() => {
                reloadBtn.textContent = originalText;
                reloadBtn.style.background = '#f39c12';
                reloadBtn.disabled = false;
            }, 2000);

        } catch (error) {
            console.error('Failed to reload tabs:', error);
            reloadBtn.textContent = t`Error - Try Again`;
            reloadBtn.style.background = '#e74c3c';
            setTimeout(() => {
                reloadBtn.textContent = originalText;
                reloadBtn.style.background = '#f39c12';
                reloadBtn.disabled = false;
            }, 3000);
        }
    };
    reloadSection.appendChild(reloadBtn);

    inlineDrawerContent.appendChild(reloadSection);
    inlineDrawer.append(inlineDrawerToggle, inlineDrawerContent);
    inlineDrawerToggle.addEventListener('click', function () {
        this.classList.toggle('open');
        inlineDrawerIcon.classList.toggle('down');
        inlineDrawerIcon.classList.toggle('up');
        inlineDrawerContent.classList.toggle('open');
    });
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

    // "Currently selected chat" element above the tab row
    const selectedChatWrapper = document.createElement('div');
    selectedChatWrapper.id = 'chatsplus-selected-chat-wrapper';
    selectedChatWrapper.style.margin = '8px 0 8px 0';
    // Add a header/title
    const selectedChatHeader = document.createElement('div');
    selectedChatHeader.id = 'chatsplus-selected-chat-header';
    selectedChatHeader.textContent = t ? t`Currently Selected Chat` : 'Currently Selected Chat';
    selectedChatHeader.style.fontWeight = 'bold';
    selectedChatHeader.style.fontSize = '1.08em';
    selectedChatHeader.style.marginBottom = '2px';
    selectedChatHeader.style.marginLeft = '2px';
    selectedChatWrapper.appendChild(selectedChatHeader);
    const selectedChatContainer = document.createElement('div');
    selectedChatContainer.id = 'chatsplus-selected-chat-container';
    selectedChatWrapper.appendChild(selectedChatContainer);
    tabRow.insertAdjacentElement('beforebegin', selectedChatWrapper);

    // Helper to render the currently selected chat
    function renderSelectedChat() {
        selectedChatContainer.innerHTML = '';
        const context = SillyTavern.getContext();
        let chatId = getCurrentChatId && getCurrentChatId();
        let charId = context.characterId;
        let groupId = context.groupId;
        let chat = null;

        // Check if we're in a group chat
        if (groupId && groups) {
            const group = groups.find(g => g.id === groupId);
            if (group) {
                chat = {
                    character: group.name || `Group ${groupId}`,
                    avatar: group.avatar || '',
                    file_name: chatId,
                    characterId: groupId,
                    isGroup: true
                };
            }
        } else if (context.characters && charId && context.characters[charId]) {
            const char = context.characters[charId];
            chat = {
                character: char.name || charId,
                avatar: char.avatar,
                file_name: chatId,
                characterId: charId,
                isGroup: false
            };
        }
        if (!chat || !chat.file_name) {
            selectedChatWrapper.style.display = 'none';
            return;
        }
        selectedChatWrapper.style.display = '';
        // Use the same rendering as .tabItem .tabItem-root
        const tabItem = document.createElement('div');
        tabItem.classList.add('tabItem', 'tabItem-root', 'tabItem-singleline');
        tabItem.style.display = 'flex';
        tabItem.style.flexDirection = 'row';
        tabItem.style.alignItems = 'center';
        tabItem.style.gap = '10px';
        tabItem.style.marginBottom = '2px';

        // Character/Group image (character = img, group = div)
        let previewImg;
        if (chat.isGroup) {
            previewImg = document.createElement('div');
            previewImg.className = 'tabItem-previewImg group-preview';

            const group = groups.find(g => g.id === chat.characterId);
            if (group) {
                let result = getGroupAvatar(group);
                if (result && result.length > 0) {
                    const groupElement = result[0];
                    groupElement.style.width = '100%';
                    groupElement.style.height = '100%';
                    groupElement.style.minWidth = 'unset';
                    previewImg.appendChild(groupElement);
                }
            }
        } else {
            previewImg = document.createElement('img');
            previewImg.className = 'tabItem-previewImg';
            previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
            previewImg.alt = chat.character || '';
        }
        const nameRow = document.createElement('div');
        nameRow.className = 'tabItem-nameRow';
        nameRow.textContent = `${chat.character}: ${chat.file_name}`;
        // Pencil icon for renaming chat 
        const pencilIcon = document.createElement('i');
        pencilIcon.className = 'fa-solid fa-pencil-alt chat-rename-icon';
        pencilIcon.style.cursor = 'pointer';
        pencilIcon.style.margin = '0 6px 0 6px';
        pencilIcon.title = t ? t`Rename chat` : 'Rename chat';
        pencilIcon.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Show rename popup for chat
            const content = document.createElement('div');
            content.innerHTML = `<h3>${t ? t`Rename chat` : 'Rename chat'}</h3>`;
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = chat.file_name;
            nameInput.style.width = '100%';
            nameInput.style.marginTop = '8px';
            nameInput.className = 'chatplus_menu_input';
            content.appendChild(nameInput);
            const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
                okButton: t ? t`Rename` : 'Rename',
                cancelButton: t ? t`Cancel` : 'Cancel',
                wide: true
            });
            nameInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    popup.okButton.click();
                }
            });
            const result = await popup.show();
            if ((result === POPUP_RESULT.AFFIRMATIVE) && nameInput.value.trim() && nameInput.value.trim() !== chat.file_name) {
                const context = SillyTavern.getContext();
                const loader = document.getElementById('extensionAllChatsTabLoader') || null;
                await renameGroupOrCharacterChat({
                    characterId: chat.characterId,
                    groupId: context.groupId,
                    oldFileName: chat.file_name,
                    newFileName: nameInput.value.trim(),
                    loader
                });
                handleChatRename(chat, nameInput.value.trim());
                // Refresh UI after renaming
                if (typeof populateAllChatsTab === 'function') await populateAllChatsTab();
                if (typeof refreshFoldersTab === 'function') await refreshFoldersTab();
            }
        });

        // Pin button for pinning the "Currently Selected Chat" chat
        const pinBtn = document.createElement('button');
        pinBtn.className = 'pinBtn tabItem-pinBtn';
        pinBtn.title = (t ? t`Pin or folder chat` : 'Pin or folder chat');
        pinBtn.innerHTML = '<i class="fa-regular fa-bookmark"></i>';
        pinBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Show pin/folder selection popup
            const selectedFolderId = await promptSelectFolderOrPinned(chat);
            if (selectedFolderId === 'pinned') {
                togglePinChat(chat);
                // Refresh UI after pinning
                if (typeof populateAllChatsTab === 'function') await populateAllChatsTab();
                if (typeof refreshFoldersTab === 'function') await refreshFoldersTab();
                renderSelectedChat(); // Refresh the selected chat display
            } else if (selectedFolderId) {
                const folderIds = getChatFolderIds(chat);
                if (!folderIds.includes(selectedFolderId)) {
                    assignChatToFolder(chat, selectedFolderId);
                    // Refresh UI after assigning to folder
                    if (typeof populateAllChatsTab === 'function') await populateAllChatsTab();
                    if (typeof refreshFoldersTab === 'function') await refreshFoldersTab();
                }
            }
        });

        tabItem.appendChild(previewImg);
        tabItem.appendChild(nameRow);
        tabItem.appendChild(pencilIcon);
        tabItem.appendChild(pinBtn);
        selectedChatContainer.appendChild(tabItem);
    }
    // Make renderSelectedChat globally accessible for use in other functions
    window['chatsPlusRenderSelectedChat'] = renderSelectedChat;
    // Initial render
    renderSelectedChat();


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
            const existingContainer = foldersTab.querySelector('.folders-tab-container');
            if (!existingContainer) {
                refreshFoldersTab(); // Note: not awaited to avoid blocking UI
            }
        }
    };
    charactersTabButton.addEventListener('click', () => activateTab(0));
    recentChatsTabButton.addEventListener('click', () => activateTab(1));
    foldersTabButton.addEventListener('click', () => activateTab(2));
    activateTab(2);
    menu.insertBefore(tabsWrapper, tabRow.nextSibling);
}

// =========================
// 7.1. Folders Tab Helper Functions
// =========================

/**
 * Build folderedChats map from chatFolders data and all available chats.
 * This function properly transforms the raw chatFolders data into the format
 * expected by renderAllChatsFoldersUI.
 * @param {Array} allChats - Array of all chat objects.
 * @returns {Object} Map of folderId to array of chats.
 */
function buildFolderedChatsMap(allChats) {
    const folderedChats = {};
    const chatFoldersMap = getChatFoldersMap();

    // Initialize empty arrays for all folders
    const folders = getFolders();
    folders.forEach(folder => {
        folderedChats[folder.id] = [];
    });

    // Process each chat and assign to folders
    allChats.forEach(chat => {
        const chatKey = chat.characterId + ':' + chat.file_name;
        const folderIds = chatFoldersMap[chatKey] || [];

        folderIds.forEach(folderId => {
            if (folderedChats[folderId]) {
                folderedChats[folderId].push(chat);
            }
        });
    });

    return folderedChats;
}

// =========================
// 7.2. Folders Tab Refresh Function
refreshFoldersTab = async function () {
    if (isRefreshingFoldersTab) {
        return;
    }
    isRefreshingFoldersTab = true;

    try {
        const foldersTab = document.getElementById('chatsplus-folders-tab');
        if (!foldersTab) {
            return;
        }

        // Check for existing containers before clearing
        const existingContainers = foldersTab.querySelectorAll('.folders-tab-container');

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
            const folderTree = buildFolderTree(folders);
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
            // Trigger the popup's OK button on Enter key
            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    popup.okButton.click();
                }
            });        // Wait for popup result
            const popupResult = await popup.show();
            if (popupResult === POPUP_RESULT.CANCELLED) return null; // User cancelled the popup
            // Read the selected radio after popup closes
            const selectedRadio = content.querySelector('input[type="radio"]:checked');
            const selectedFolderId = selectedRadio && selectedRadio.value ? selectedRadio.value : null;
            const name = nameInput.value;
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
                        characterId: charId,
                        isGroup: false
                    }));
                } catch (e) {
                    return [];
                }
            });
            const chatLists = await Promise.all(chatListPromises);
            allChats = allChats.concat(chatLists.flat());
        }

        // Add group chats
        try {
            const groupsResponse = await fetch('/api/groups/all', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            if (groupsResponse.ok) {
                const groups = await groupsResponse.json();
                const groupChatPromises = groups.map(async (group) => {
                    try {
                        const chats = await getGroupPastChats(group.id);
                        return chats.map(chat => {
                            const fileName = typeof chat === 'string' ? chat.replace('.jsonl', '') : String(chat.file_name || chat).replace('.jsonl', '');
                            return {
                                character: group.name || `Group ${group.id}`,
                                avatar: group.avatar || '',
                                file_name: fileName,
                                characterId: group.id,
                                isGroup: true,
                                groupMembers: group.members || []
                            };
                        });
                    } catch (e) {
                        return [];
                    }
                });

                const groupChatLists = await Promise.all(groupChatPromises);
                allChats = allChats.concat(groupChatLists.flat());
            }
        } catch (e) {
            console.warn('Failed to load group chats in folders tab:', e);
        }

        let chatStatsMap = {};
        // Parallelize fetching stats for all characters and groups
        const uniqueCharacterIds = [...new Set(allChats.filter(chat => !chat.isGroup).map(chat => chat.characterId))];
        const uniqueGroupIds = [...new Set(allChats.filter(chat => chat.isGroup).map(chat => chat.characterId))];

        const characterStatsPromises = uniqueCharacterIds.map(async (charId) => {
            try {
                const statsList = await getPastCharacterChats(charId);
                return statsList.map(stat => {
                    const fileName = String(stat.file_name).replace('.jsonl', '');
                    return [charId + ':' + fileName, stat];
                });
            } catch (e) { return []; }
        });

        const groupStatsPromises = uniqueGroupIds.map(async (groupId) => {
            try {
                const statsList = await getGroupPastChats(groupId);
                return statsList.map(stat => {
                    const fileName = typeof stat === 'string' ? stat.replace('.jsonl', '') : String(stat.file_name || stat).replace('.jsonl', '');
                    return [groupId + ':' + fileName, stat];
                });
            } catch (e) { return []; }
        });

        const statsEntries = (await Promise.all([...characterStatsPromises, ...groupStatsPromises])).flat();
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
        });

        // Build the folderedChats map using the new helper function
        const folderedChats = buildFolderedChatsMap(allChats);
        renderAllChatsFoldersUI(foldersTabContainer, folderedChats);
        foldersTab.appendChild(foldersTabContainer);
    } finally {
        isRefreshingFoldersTab = false;
    }
};


// =========================
// 8. Initialization
// =========================

/**
 * Remove all backup files and clean up the obsolete backup system.
 * This function deletes all backup files from the server and clears localStorage.
 * This is a standalone function with all dependencies inlined.
 */
async function removeAllBackupFiles() {
    try {
        // Inlined constants and dependencies
        const BACKUP_STORAGE_KEY = 'chatsPlusBackupVersions';

        // Inlined getBackupVersions function
        let versions = [];
        try {
            versions = JSON.parse(localStorage.getItem(BACKUP_STORAGE_KEY) || '[]');
        } catch (error) {
            console.warn('Failed to parse backup versions from localStorage:', error);
            versions = [];
        }

        if (versions.length !== 0) {
            console.log(`ChatsPlus: Found ${versions.length} backup files to remove`);

            // Delete all backup files from server
            for (const backup of versions) {
                try {
                    const attachment = {
                        url: backup.url,
                        name: backup.fileName,
                        size: 0,
                        created: backup.created
                    };
                    await deleteAttachment(attachment, backup.source || 'global', () => { }, false);
                    console.log(`ChatsPlus: Deleted backup file: ${backup.fileName}`);
                } catch (error) {
                    console.warn(`ChatsPlus: Failed to delete backup file ${backup.fileName}:`, error);
                }
            }
        }

        // Clear all backup data from localStorage
        try {
            localStorage.removeItem(BACKUP_STORAGE_KEY);
        } catch (error) {
            console.warn('ChatsPlus: Failed to clear backup data from localStorage:', error);
        }
    } catch (error) {
        console.error('ChatsPlus: Failed to remove backup files:', error);
    }
}

/**
 * Initialize the extension: highlight, settings, and tab menu.
 * Adds event listeners for tab switching.
 */
(function initExtension() {
    const context = SillyTavern.getContext();
    const settingsKey = MODULE_NAME;
    const settings = context.extensionSettings[settingsKey] ?? {};
    renderExtensionSettings();

    // Enable/Disable the extension
    if (settings.enabled === false) return;

    // Initialize the extension
    addJQueryHighlight();
    addTabToCharManagementMenu();

    // Remove obsolete backup system
    removeAllBackupFiles();

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

    // Listen for character management events that can shift character IDs
    if (eventSource && event_types) {
        if (event_types.CHARACTER_RENAMED) {
            eventSource.on(event_types.CHARACTER_RENAMED, handleCharacterRename);
        }

        if (event_types.CHARACTER_DELETED) {
            eventSource.on(event_types.CHARACTER_DELETED, handleCharacterDelete);
        }

        if (event_types.CHARACTER_DUPLICATED) {
            eventSource.on(event_types.CHARACTER_DUPLICATED, handleCharacterDuplicated);
        }

        // Settings events that rebuild character data
        if (event_types.SETTINGS_LOADED_AFTER) {
            eventSource.on(event_types.SETTINGS_LOADED_AFTER, handleSettingsReloaded);
        }

        // Character page events that might reload character data
        if (event_types.CHARACTER_PAGE_LOADED) {
            eventSource.on(event_types.CHARACTER_PAGE_LOADED, handleCharacterPageLoaded);
        }
    }
})();

/**
 * Update all internal references to a chat when its file_name is changed.
 * @param {Object} chat - The chat object being renamed.
 * @param {string} newName - The new file_name for the chat.
 */
function handleChatRename(chat, newName) {
    // Try to extract characterId from chat object
    let characterId = chat.characterId;
    if (!characterId) {
        const context = SillyTavern.getContext();
        if (context.characterId !== undefined) {
            characterId = context.characterId;
        } else if (context.groupId !== undefined) {
            characterId = context.groupId; // fallback for group chats
        }
    }
    if (!characterId) return;
    // Update pinnedChats
    let pinned = getPinnedChats();
    let changed = false;
    pinned = pinned.map(p => {
        if (p.file_name === chat.file_name && p.characterId === characterId) {
            changed = true;
            return { ...p, file_name: newName };
        }
        return p;
    });
    if (changed) setPinnedChats(pinned);
    // Update chatFolders
    let map = getChatFoldersMap();
    const oldKey = characterId + ':' + chat.file_name;
    const newKey = characterId + ':' + newName;
    if (map[oldKey]) {
        map[newKey] = map[oldKey];
        delete map[oldKey];
        setChatFoldersMap(map);
    }
}

/**
 * Process the character rename update after SillyTavern has rebuilt character data.
 * This function remaps ALL character references based on current avatar mappings.
 * @param {Object} renameData - Contains oldAvatar, newAvatar, and timestamp.
 */
async function processCharacterRenameUpdate(renameData) {
    const { oldAvatar, newAvatar } = renameData;

    const context = SillyTavern.getContext();
    const characters = context.characters;

    if (!characters) {
        return;
    }

    // Build a map of avatars to their current character IDs
    const avatarToCharacterId = {};
    for (const [charId, char] of Object.entries(characters)) {
        if (char.avatar) {
            avatarToCharacterId[char.avatar] = charId;
        }
    }

    // Build a comprehensive mapping of chat files to their correct character IDs
    // by actually checking which character has which chat files
    const chatFileToCharacterId = {};

    try {
        // Get all chat files for all characters to build accurate mapping
        for (const [charId, char] of Object.entries(characters)) {
            if (char.avatar) {
                try {
                    const chats = await getListOfCharacterChats(char.avatar);
                    if (Array.isArray(chats)) {
                        for (const chatName of chats) {
                            if (typeof chatName === 'string' && chatName) {
                                chatFileToCharacterId[chatName] = charId;
                            }
                        }
                    }
                } catch (e) {
                    // Continue with other characters if one fails
                }
            }
        }
    } catch (e) {
        // Continue with what we have
    }

    let updatesMade = false;

    // Update pinned chats - remap all character IDs based on actual chat ownership
    let pinned = getPinnedChats();
    let pinnedChanged = false;

    pinned = pinned.map(p => {
        // Try to find the correct character ID for this chat file
        const correctCharacterId = chatFileToCharacterId[p.file_name];

        if (correctCharacterId && correctCharacterId !== p.characterId) {
            pinnedChanged = true;
            updatesMade = true;
            return { ...p, characterId: correctCharacterId };
        } else if (!correctCharacterId) {
            // Chat file not found in any character, check if character ID is still valid
            const currentChar = characters[p.characterId];
            if (!currentChar) {
                // Keep the entry but it might be orphaned
            }
        }

        return p;
    });

    if (pinnedChanged) {
        setPinnedChats(pinned);
    }

    // Update chat folders - remap all character IDs based on actual chat ownership
    let map = getChatFoldersMap();
    let foldersChanged = false;
    const newMap = {};

    for (const [key, folderIds] of Object.entries(map)) {
        const [charId, fileName] = key.split(':', 2);

        // Try to find the correct character ID for this chat file
        const correctCharacterId = chatFileToCharacterId[fileName];

        if (correctCharacterId) {
            // We found the correct character for this chat file
            const correctKey = correctCharacterId + ':' + fileName;

            if (correctKey !== key) {
                foldersChanged = true;
                updatesMade = true;
            }

            newMap[correctKey] = folderIds;
        } else {
            // Chat file not found in any character, check if current character ID is still valid
            const currentChar = characters[charId];
            if (currentChar) {
                // Character still exists, keep the mapping
                newMap[key] = folderIds;
            } else {
                // Skip this entry as it's orphaned
            }
        }
    }

    if (foldersChanged) {
        setChatFoldersMap(newMap);
    }

    if (updatesMade) {
        // Refresh UI
        if (typeof refreshFoldersTab === 'function') {
            setTimeout(() => {
                refreshFoldersTab();
            }, 100);
        }

        if (typeof populateAllChatsTab === 'function') {
            setTimeout(() => {
                populateAllChatsTab();
            }, 100);
        }
    }
}

/**
 * Update all internal references when a character is renamed.
 * Since character IDs get reassigned during rename, we need to use avatar paths
 * as the stable identifier and defer the update to when character data is refreshed.
 * @param {string} oldAvatar - The old character avatar/identifier.
 * @param {string} newAvatar - The new character avatar/identifier.
 */
function handleCharacterRename(oldAvatar, newAvatar) {
    if (!oldAvatar || !newAvatar) {
        return;
    }

    // Store the rename mapping for delayed processing
    const renameData = { oldAvatar, newAvatar, timestamp: Date.now() };

    // Defer the actual update to allow SillyTavern to rebuild character data
    setTimeout(async () => {
        await processCharacterRenameUpdate(renameData);
    }, 500); // Give SillyTavern time to rebuild character data
}


/**
 * Handle character deletion - remove orphaned references.
 * @param {string} characterId - The ID of the deleted character.
 */
function handleCharacterDelete(characterId) {
    if (!characterId) return;

    setTimeout(async () => {
        let updatesMade = false;

        // Remove from pinned chats
        let pinned = getPinnedChats();
        const originalPinnedLength = pinned.length;
        pinned = pinned.filter(p => p.characterId !== characterId);
        if (pinned.length !== originalPinnedLength) {
            setPinnedChats(pinned);
            updatesMade = true;
        }

        // Remove from chat folders
        let map = getChatFoldersMap();
        const newMap = {};
        for (const [key, folderIds] of Object.entries(map)) {
            const [charId] = key.split(':', 1);
            if (charId !== characterId) {
                newMap[key] = folderIds;
            } else {
                updatesMade = true;
            }
        }
        setChatFoldersMap(newMap);

        if (updatesMade) {
            // Refresh UI
            if (typeof refreshFoldersTab === 'function') {
                setTimeout(() => refreshFoldersTab(), 100);
            }
            if (typeof populateAllChatsTab === 'function') {
                setTimeout(() => populateAllChatsTab(), 100);
            }
        }
    }, 100);
}

/**
 * Handle character duplication - character IDs may shift.
 */
function handleCharacterDuplicated() {
    // Defer the remapping to allow SillyTavern to rebuild character data
    setTimeout(async () => {
        await processCharacterRenameUpdate({
            oldAvatar: '',
            newAvatar: '',
            timestamp: Date.now()
        });
    }, 500);
}

/**
 * Handle settings reload - character IDs may be reassigned.
 */
function handleSettingsReloaded() {
    // Defer the remapping to allow SillyTavern to rebuild character data
    setTimeout(async () => {
        await processCharacterRenameUpdate({
            oldAvatar: '',
            newAvatar: '',
            timestamp: Date.now()
        });
    }, 1000); // Longer delay for settings reload
}

/**
 * Handle character page loaded - might indicate character data changes.
 */
function handleCharacterPageLoaded() {
    // Defer the remapping with a short delay
    setTimeout(async () => {
        await processCharacterRenameUpdate({
            oldAvatar: '',
            newAvatar: '',
            timestamp: Date.now()
        });
    }, 200);
}