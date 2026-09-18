const backBtn = document.getElementById('back-btn');
const currentGameHeader = document.getElementById('current-game-header');
const currentGameName = document.getElementById('current-game-name');
const currentGameEditBtn = document.getElementById('current-game-edit-btn');
const gamesRow = document.getElementById('games-row');
const gamesHome = document.getElementById('games-home');
const totalRamEl = document.getElementById('total-ram');
const addSiteBtn = document.getElementById('add-site-btn');

const sitePopover = document.getElementById('add-site-popover');
const siteNameInput = document.getElementById('site-name-input');

const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');

const accountPopover = document.getElementById('add-account-popover');
const accountNameInput = document.getElementById('account-name-input');
const accountUrlInput = document.getElementById('account-url-input');
const accountProxyInput = document.getElementById('account-proxy-input');
let accountPopoverSiteId = null;
let editingAccountId = null; // se preenchido, o popover de conta está em modo EDITAR
let editingSiteId = null;    // se preenchido, o popover de jogo está em modo EDITAR
let selectedSiteIcon = '';   // ícone escolhido no popover de jogo (nome do arquivo, sem extensão) — '' = nenhum
let selectedSiteColor = 'blue'; // cor escolhida no popover (dourado é exclusivo do ícone do app, não entra como opção aqui)

const GAME_ICONS = ['crown', 'coins', 'key', 'shield', 'swords', 'flame', 'gear', 'potion', 'book', 'growth', 'helmet', 'compass'];
const ICON_COLORS = {
    // v15.42: 21 cores, em ordem de roda de cores (vermelho → laranja →
    // amarelo → verdes → ciano/azuis → roxo/rosa) — assim, na fileira do
    // seletor, tons parecidos ficam vizinhos uns dos outros, tipo o
    // seletor de cor de outfit do Tibia (mesma ideia, sem mudar a
    // interface do seletor em si, só a ordem/quantidade das cores).
    red:     '#e62222',
    orange:  '#e65a22',
    amber:   '#e69222',
    gold:    '#f2b71d', // v0.19.1: cor "de origem" do app — mantida no mesmo tom de sempre
    yellow:  '#cae622',
    lime:    '#92e622',
    leaf:    '#5ae622',
    green:   '#22e622',
    emerald: '#22e65a',
    mint:    '#22e692',
    teal:    '#22e6ca',
    cyan:    '#22cae6',
    sky:     '#2292e6',
    azure:   '#225ae6',
    blue:    '#2222e6',
    indigo:  '#5a22e6',
    violet:  '#9222e6',
    purple:  '#ca22e6',
    magenta: '#e622ca',
    pink:    '#e62292',
    rose:    '#e6225a',
};
const APP_ICON_COLOR = '#d4af17'; // valor de fallback (usado quando nenhuma cor de jogo está ativa)
const VALID_APP_ICON_COLORS = ['red', 'orange', 'amber', 'gold', 'yellow', 'lime', 'leaf', 'green', 'emerald', 'mint', 'teal', 'cyan', 'sky', 'azure', 'blue', 'indigo', 'violet', 'purple', 'magenta', 'pink', 'rose']; // pastas geradas em assets/app-icon-colors/

function iconPath(iconName, color) {
    if (!iconName) return '';
    // 'gold' só existe pra contas antigas salvas antes dessa mudança —
    // não é mais oferecida no seletor (ver comentário do APP_ICON_COLOR).
    return (color && color !== 'gold') ? `assets/game-icons/${color}/${iconName}.png` : `assets/game-icons/${iconName}.png`;
}

let sites = [];
let accounts = [];
let activeAccountId = null;
let lastStats = {};

let viewMode = 'home'; // 'home' | 'detail'
let currentSiteId = null;
let renameInProgress = false; // true durante edição inline (duplo-clique) — pausa o re-render do poll pra não cortar a digitação

// ========== BOLINHA DE STATUS POR MS ==========
function pingClass(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 100) return 'good';
    if (ms < 300) return 'mid';
    return 'bad';
}

// ========== CARREGAR E DECIDIR TELA INICIAL ==========
async function refreshData() {
    const data = await window.manager.getData();
    sites = data.sites;
    accounts = data.accounts;
    activeAccountId = data.activeAccountId;

    const activeAcc = accounts.find(a => a.id === activeAccountId);
    if (activeAcc) {
        viewMode = 'detail';
        currentSiteId = activeAcc.siteId;
        // Força a reconexão da view mesmo que ela tenha ficado "solta" de
        // uma sessão anterior — sem isso, o jogo podia carregar por dentro
        // mas a tela ficar preta, porque a conexão visual não era refeita.
        await window.manager.showActiveView();
    } else {
        viewMode = 'home';
    }
    render();
}

// ========== NAVEGAÇÃO ENTRE AS DUAS TELAS ==========
async function showHome() {
    await closeAllPopovers(); // v15.16: qualquer navegação fecha popover de criar/editar aberto, evita ele "grudar" na tela
    viewMode = 'home';
    currentSiteId = null;
    // v15.16: o processo principal "esquece" a conta ativa (hideActiveView
    // com forget=true), mas essa variável aqui do lado da tela continuava
    // com o valor antigo — então, ao voltar pro mesmo jogo depois,
    // showGameDetail() achava (errado) que a conta já estava ativa e só
    // pedia pra "mostrar de novo" (showActiveView), que virava um no-op
    // porque o processo principal não tinha mais nada guardado. Resultado:
    // painel do jogo abre, mas fica preto, sem view nenhuma dentro.
    activeAccountId = null;
    await window.manager.hideActiveView(true);
    render();
}

async function showGameDetail(siteId) {
    await closeAllPopovers(); // v15.16: qualquer navegação fecha popover de criar/editar aberto, evita ele "grudar" na tela
    viewMode = 'detail';
    currentSiteId = siteId;

    const siteAccounts = accounts.filter(a => a.siteId === siteId);
    if (siteAccounts.length > 0) {
        const targetId = siteAccounts.some(a => a.id === activeAccountId) ? activeAccountId : siteAccounts[0].id;
        if (targetId !== activeAccountId) {
            activeAccountId = await window.manager.switchAccount(targetId);
        } else {
            await window.manager.showActiveView();
        }
    } else {
        await window.manager.hideActiveView();
    }
    render();
}

backBtn.addEventListener('click', showHome);
currentGameEditBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditSitePopover(currentSiteId);
});

// ========== RENDERIZAR ==========
function render() {
    if (viewMode === 'home') {
        renderHome();
    } else {
        renderDetail();
    }
    // v0.18: painel HTML único (#game-panel) — a view preenche só o viewport
    // interno; a borda envolve título + jogo como uma página (Idle Labs).
    document.getElementById('game-panel').classList.toggle('hidden', viewMode !== 'detail');
    const total = Object.values(lastStats).reduce((sum, s) => sum + (s.ramMB || 0), 0);
    totalRamEl.textContent = accounts.length > 0 ? `${total} MB total` : '— MB total';
}

function renderHome() {
    backBtn.classList.add('hidden');
    currentGameHeader.classList.add('hidden');
    document.getElementById('game-panel').classList.add('hidden');
    gamesHome.classList.remove('hidden');
    gamesHome.innerHTML = '';
    // v0.19.7: não reseta mais pro dourado padrão ao voltar pra home — a
    // cor geral fica na da última aba visitada até você entrar numa
    // conta de cor diferente.

    // v0.15.1: em vez de uma aba pra cada jogo (ficava poluído), só um
    // indicador fixo "Menu" — os cards logo abaixo já são a navegação.
    gamesRow.innerHTML = '<div id="home-menu-label">Menu</div>';

    if (sites.length === 0) {
        gamesHome.innerHTML = `<div id="games-home-empty">Nenhum jogo ainda.<br>Clica em "+ Jogo" ali em cima pra começar.</div>`;
        return;
    }

    const grid = document.createElement('div');
    grid.id = 'games-home-grid';

    sites.forEach(site => {
        const siteAccounts = accounts.filter(a => a.siteId === site.id);
        const ram = siteAccounts.reduce((sum, a) => sum + (lastStats[a.id]?.ramMB || 0), 0);

        const card = document.createElement('div');
        const allDisabled = siteAccounts.length > 0 && siteAccounts.every(a => a.manuallyDisabled);
        card.className = 'game-card' + (allDisabled ? ' game-card--disabled' : '');
        card.draggable = true;
        card.dataset.siteId = site.id;
        card.title = 'Ctrl+clique pra desativar/reativar TODAS as contas desse jogo de uma vez (economiza RAM)';
        card.innerHTML = `
            <div class="game-card-actions">
                <button class="game-edit-btn" data-site-id="${site.id}" title="Editar jogo">✎</button>
                <button class="game-remove-btn" data-site-id="${site.id}" title="Remover jogo">×</button>
            </div>
            <div class="game-card-top">
                ${site.icon ? `<span class="game-card-icon-wrap icon-orbit-frame" style="--icon-glow-color:${ICON_COLORS[site.iconColor] || ICON_COLORS.blue}"><img src="${iconPath(site.icon, site.iconColor)}" alt=""></span>` : ''}
                <span class="game-card-name">${site.name}</span>
            </div>
            <div class="game-card-meta">
                <span>${siteAccounts.length} conta${siteAccounts.length !== 1 ? 's' : ''}</span>
                <span><strong>${ram}</strong> MB</span>
            </div>
        `;
        grid.appendChild(card);
    });

    gamesHome.appendChild(grid);
}

function buildAccountTab(acc) {
    const stat = lastStats[acc.id] || {};
    const tab = document.createElement('div');
    tab.className = 'account-tab' + (acc.id === activeAccountId ? ' active' : '') + (acc.manuallyDisabled ? ' account-tab--disabled' : '');
    tab.dataset.id = acc.id;
    tab.draggable = true;
    tab.title = 'Arraste pra reordenar · duplo-clique pra renomear · Ctrl+clique pra desativar essa página (economiza RAM até você religar)';
    tab.innerHTML = `
        <span class="account-tab-top">
            <span class="account-name">${acc.name}</span>
            <button class="account-reload-btn" data-id="${acc.id}" title="Recarregar essa conta (reconecta o proxy também, se tiver um configurado)">⟳</button>
            <button class="account-edit-btn" data-id="${acc.id}" title="Editar conta">✎</button>
            <button class="account-remove-btn" data-id="${acc.id}" title="Remover conta">×</button>
        </span>
    `;
    tab.addEventListener('click', (e) => {
        if (e.target.closest('.account-remove-btn') || e.target.closest('.account-edit-btn') || e.target.closest('.account-reload-btn')) return;
        if (e.ctrlKey) {
            e.preventDefault();
            toggleAccountManualDisable(acc.id);
            return;
        }
        switchAccount(acc.id);
    });
    tab.querySelector('.account-name').addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRenameAccount(acc.id, tab.querySelector('.account-name'));
    });
    return tab;
}

async function toggleAccountManualDisable(id) {
    const result = await window.manager.toggleAccountManualDisable(id);
    sites = result.sites;
    accounts = result.accounts;
    activeAccountId = result.activeAccountId;
    render();
}

async function toggleSiteManualDisable(siteId) {
    const result = await window.manager.toggleSiteManualDisable(siteId);
    sites = result.sites;
    accounts = result.accounts;
    activeAccountId = result.activeAccountId;
    render();
}

function renderDetail() {
    const site = sites.find(s => s.id === currentSiteId);
    if (!site) { showHome(); return; } // segurança: se o jogo sumiu, volta pra home

    gamesHome.classList.add('hidden');
    backBtn.classList.remove('hidden');
    currentGameHeader.classList.remove('hidden');
    currentGameName.textContent = site.name;
    const iconWrap = document.getElementById('current-game-icon-wrap');
    const iconImg = document.getElementById('current-game-icon');
    const glowColor = ICON_COLORS[site.iconColor] || ICON_COLORS.blue;
    if (site.icon) {
        iconImg.src = iconPath(site.icon, site.iconColor);
        iconWrap.classList.add('has-icon');
        iconWrap.style.setProperty('--icon-glow-color', glowColor);
    } else {
        iconWrap.classList.remove('has-icon');
    }
    document.getElementById('game-panel').style.setProperty('--icon-glow-color', glowColor);
    document.getElementById('top-bar-row2').style.setProperty('--icon-glow-color', glowColor);
    // v0.19.6: o ícone/texto do app não tem mais cor exclusiva — segue o
    // jogo ativo, igual tudo o mais. Seta no body pra qualquer elemento
    // (inclusive a marca, que fica numa barra separada) herdar a cor.
    document.body.style.setProperty('--icon-glow-color', glowColor);
    const appIconColorKey = VALID_APP_ICON_COLORS.includes(site.iconColor) ? site.iconColor : 'gold';
    document.getElementById('app-brand-icon-img').src = `assets/app-icon-colors/${appIconColorKey}.png`;

    gamesRow.innerHTML = '';
    const siteAccounts = accounts.filter(a => a.siteId === site.id);
    siteAccounts.forEach(acc => gamesRow.appendChild(buildAccountTab(acc)));

    const addAccBtn = document.createElement('button');
    addAccBtn.className = 'game-add-account-btn';
    addAccBtn.title = `Adicionar conta em ${site.name}`;
    addAccBtn.textContent = '+';
    addAccBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAddAccountPopover(site.id);
    });
    gamesRow.appendChild(addAccBtn);

    renderAccountStrip(site);
}

function renderAccountStrip(site) {
    const panel = document.getElementById('game-panel');
    const strip = document.getElementById('account-strip');
    const acc = accounts.find(a => a.id === activeAccountId);
    if (!acc) { return; }

    const icon = acc.icon || site.icon;
    const glow = ICON_COLORS[site.iconColor] || ICON_COLORS.blue; // v0.19.2: cor sempre a do jogo — não tem mais override por conta, era isso que descasava aba/painel
    panel.style.setProperty('--icon-glow-color', glow);
    strip.style.setProperty('--icon-glow-color', glow);
    const iconWrap = document.getElementById('account-strip-icon-wrap');
    const iconImg = document.getElementById('account-strip-icon');
    if (icon) {
        iconImg.src = iconPath(icon, site.iconColor);
        iconWrap.style.display = '';
    } else {
        iconWrap.style.display = 'none';
    }

    const nameEl = document.getElementById('account-strip-name');
    if (nameEl.contentEditable !== 'true') nameEl.textContent = acc.name; // não pisa em cima de uma edição em andamento

    const stat = lastStats[acc.id] || {};
    document.getElementById('account-strip-dot').className = 'status-dot ' + pingClass(stat.pingMs);
    document.getElementById('account-strip-ms').textContent = stat.pingMs != null ? stat.pingMs + 'ms' : '—';
    document.getElementById('account-strip-ram').textContent = stat.ramMB != null ? stat.ramMB + 'MB' : '—';
}

async function switchAccount(id) {
    if (id === activeAccountId) return;
    await closeAllPopovers(); // v15.16: qualquer navegação fecha popover de criar/editar aberto, evita ele "grudar" na tela
    activeAccountId = await window.manager.switchAccount(id);
    render();
}

// ========== CLIQUES NA HOME (cards de jogo) ==========
gamesHome.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.game-edit-btn');
    if (editBtn) {
        e.stopPropagation();
        openEditSitePopover(editBtn.dataset.siteId);
        return;
    }
    const removeBtn = e.target.closest('.game-remove-btn');
    if (removeBtn) {
        e.stopPropagation();
        removeSite(removeBtn.dataset.siteId);
        return;
    }
    const card = e.target.closest('.game-card');
    if (card) {
        if (e.ctrlKey) {
            e.preventDefault();
            toggleSiteManualDisable(card.dataset.siteId);
            return;
        }
        showGameDetail(card.dataset.siteId);
    }
});

// ========== CLIQUES NA TELA DE DETALHE (abas) ==========
gamesRow.addEventListener('click', (e) => {
    const removeAccBtn = e.target.closest('.account-remove-btn');
    if (removeAccBtn) {
        e.stopPropagation();
        removeAccount(removeAccBtn.dataset.id);
        return;
    }
    const editAccBtn = e.target.closest('.account-edit-btn');
    if (editAccBtn) {
        e.stopPropagation();
        openEditAccountPopover(editAccBtn.dataset.id);
        return;
    }
    const reloadAccBtn = e.target.closest('.account-reload-btn');
    if (reloadAccBtn) {
        e.stopPropagation();
        window.manager.reloadAccount(reloadAccBtn.dataset.id);
        return;
    }
});

async function removeAccount(id) {
    const acc = accounts.find(a => a.id === id);
    if (!confirm(`Remover a conta "${acc?.name}"? A sessão de login dela será perdida.`)) return;

    const result = await window.manager.removeAccount(id);
    sites = result.sites;
    accounts = result.accounts;
    activeAccountId = result.activeAccountId;

    if (viewMode === 'detail' && !accounts.some(a => a.siteId === currentSiteId)) {
        await showHome();
    } else {
        render();
    }
}

async function removeSite(id) {
    const site = sites.find(s => s.id === id);
    const count = accounts.filter(a => a.siteId === id).length;
    const msg = count > 0
        ? `Remover "${site?.name}" e as ${count} conta(s) dele? As sessões de login serão perdidas.`
        : `Remover "${site?.name}"?`;
    if (!confirm(msg)) return;

    const result = await window.manager.removeSite(id);
    sites = result.sites;
    accounts = result.accounts;
    activeAccountId = result.activeAccountId;
    render();
}

// ========== RENOMEAR (duplo-clique -> campo editável) ==========
function startRenameAccount(id, spanEl) {
    startInlineRename(spanEl, async (newName) => {
        const result = await window.manager.renameAccount(id, newName);
        sites = result.sites;
        accounts = result.accounts;
        render();
    });
}

function startInlineRename(spanEl, onConfirm) {
    const originalText = spanEl.textContent;
    spanEl.contentEditable = 'true';
    spanEl.focus();
    document.execCommand('selectAll', false, null);
    renameInProgress = true; // pausa o re-render automático do poll enquanto edita

    let done = false;
    const finish = async (save) => {
        if (done) return;
        done = true;
        renameInProgress = false;
        spanEl.contentEditable = 'false';
        const newName = spanEl.textContent.trim();
        if (save && newName && newName !== originalText) {
            await onConfirm(newName);
        } else {
            spanEl.textContent = originalText;
        }
    };

    spanEl.addEventListener('blur', () => finish(true), { once: true });
    spanEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); spanEl.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); spanEl.blur(); }
    });
}

// ========== ARRASTAR PRA REORDENAR — CONTAS (tela de detalhe) ==========
let dragAccountEl = null;

gamesRow.addEventListener('dragstart', (e) => {
    const tab = e.target.closest('.account-tab');
    if (tab) {
        dragAccountEl = tab;
        tab.classList.add('dragging');
    } else {
        e.preventDefault();
    }
});

gamesRow.addEventListener('dragend', () => {
    if (dragAccountEl) dragAccountEl.classList.remove('dragging');
    dragAccountEl = null;
});

gamesRow.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragAccountEl) return;
    const target = e.target.closest('.account-tab');
    if (!target || target === dragAccountEl) return;
    const rect = target.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    gamesRow.insertBefore(dragAccountEl, before ? target : target.nextSibling);
});

gamesRow.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!dragAccountEl) return;
    const orderedIds = [...gamesRow.querySelectorAll('.account-tab')].map(t => t.dataset.id);
    const result = await window.manager.reorderAccounts(currentSiteId, orderedIds);
    sites = result.sites;
    accounts = result.accounts;
    render();
});

// ========== ARRASTAR PRA REORDENAR — JOGOS (tela home) ==========
let dragSiteEl = null;

gamesHome.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.game-card');
    if (card) {
        dragSiteEl = card;
        card.classList.add('dragging');
    } else {
        e.preventDefault();
    }
});

gamesHome.addEventListener('dragend', () => {
    if (dragSiteEl) dragSiteEl.classList.remove('dragging');
    dragSiteEl = null;
});

gamesHome.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSiteEl) return;
    const target = e.target.closest('.game-card');
    if (!target || target === dragSiteEl) return;
    const rect = target.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    target.parentElement.insertBefore(dragSiteEl, before ? target : target.nextSibling);
});

gamesHome.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!dragSiteEl) return;
    const orderedSiteIds = [...gamesHome.querySelectorAll('.game-card')].map(c => c.dataset.siteId);
    sites = await window.manager.reorderSites(orderedSiteIds);
    render();
});

// ========== POPOVER: NOVO JOGO / EDITAR JOGO ==========
addSiteBtn.addEventListener('click', async () => {
    const willOpen = sitePopover.classList.contains('hidden');
    await closeAllPopovers();
    if (willOpen) {
        editingSiteId = null;
        document.getElementById('site-popover-title').textContent = 'Novo jogo';
        document.getElementById('site-confirm-btn').textContent = 'Criar';
        selectedSiteIcon = '';
        selectedSiteColor = 'blue';
        renderIconPicker();
        renderColorPicker();
        sitePopover.classList.remove('hidden');
        await window.manager.hideActiveView();
        siteNameInput.focus();
    }
});

async function openEditSitePopover(siteId) {
    const site = sites.find(s => s.id === siteId);
    if (!site) return;
    const willOpen = sitePopover.classList.contains('hidden');
    await closeAllPopovers();
    if (willOpen) {
        editingSiteId = siteId;
        document.getElementById('site-popover-title').textContent = 'Editar jogo';
        document.getElementById('site-confirm-btn').textContent = 'Salvar';
        siteNameInput.value = site.name;
        selectedSiteIcon = site.icon || '';
        selectedSiteColor = site.iconColor || 'blue';
        renderIconPicker();
        renderColorPicker();
        sitePopover.classList.remove('hidden');
        await window.manager.hideActiveView();
        siteNameInput.focus();
    }
}

document.getElementById('site-cancel-btn').addEventListener('click', closeAllPopovers);
document.getElementById('site-confirm-btn').addEventListener('click', submitSiteForm);
siteNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSiteForm(); });

// ========== SELETOR DE ÍCONE E COR DO JOGO ==========
function renderIconPicker() {
    const picker = document.getElementById('site-icon-picker');
    picker.innerHTML = '';

    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = 'icon-choice none-choice' + (selectedSiteIcon === '' ? ' selected' : '');
    noneBtn.textContent = '—';
    noneBtn.title = 'Sem ícone';
    noneBtn.addEventListener('click', () => { selectedSiteIcon = ''; renderIconPicker(); });
    picker.appendChild(noneBtn);

    GAME_ICONS.forEach(name => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-choice' + (selectedSiteIcon === name ? ' selected' : '');
        btn.title = name;
        btn.innerHTML = `<img src="${iconPath(name, selectedSiteColor)}" alt="${name}">`;
        btn.addEventListener('click', () => { selectedSiteIcon = name; renderIconPicker(); });
        picker.appendChild(btn);
    });
}

function renderColorPicker() {
    const picker = document.getElementById('site-color-picker');
    picker.innerHTML = '';
    Object.entries(ICON_COLORS).forEach(([name, hex]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'color-choice' + (selectedSiteColor === name ? ' selected' : '');
        btn.title = name;
        btn.style.background = hex;
        btn.addEventListener('click', () => {
            selectedSiteColor = name;
            renderColorPicker();
            renderIconPicker(); // os ícones no seletor também mudam de cor
        });
        picker.appendChild(btn);
    });
}

async function submitSiteForm() {
    const name = siteNameInput.value.trim();
    if (!name) {
        siteNameInput.focus();
        return;
    }

    if (editingSiteId) {
        sites = await window.manager.updateSite(editingSiteId, name, selectedSiteIcon, selectedSiteColor);
        closeAllPopovers();
        render();
    } else {
        sites = await window.manager.addSite({ name, icon: selectedSiteIcon, iconColor: selectedSiteColor });
        const newSite = sites[sites.length - 1];
        closeAllPopovers();
        await showGameDetail(newSite.id);
    }
}

// ========== POPOVER: NOVA CONTA / EDITAR CONTA ==========
let selectedAccountIcon = '';

function renderAccountIconPicker() {
    const picker = document.getElementById('account-icon-picker');
    picker.innerHTML = '';
    const site = sites.find(s => s.id === (accountPopoverSiteId || accounts.find(a => a.id === editingAccountId)?.siteId));
    const previewColor = site?.iconColor || 'blue'; // só pra pré-visualizar o ícone com a cor certa — a cor em si vem sempre do jogo

    const inheritBtn = document.createElement('button');
    inheritBtn.type = 'button';
    inheritBtn.className = 'icon-choice none-choice' + (selectedAccountIcon === '' ? ' selected' : '');
    inheritBtn.textContent = '—';
    inheritBtn.title = 'Usar o ícone do jogo';
    inheritBtn.addEventListener('click', () => { selectedAccountIcon = ''; renderAccountIconPicker(); });
    picker.appendChild(inheritBtn);

    GAME_ICONS.forEach(name => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-choice' + (selectedAccountIcon === name ? ' selected' : '');
        btn.title = name;
        btn.innerHTML = `<img src="${iconPath(name, previewColor)}" alt="${name}">`;
        btn.addEventListener('click', () => { selectedAccountIcon = name; renderAccountIconPicker(); });
        picker.appendChild(btn);
    });
}

async function openAddAccountPopover(siteId) {
    accountPopoverSiteId = siteId;
    const willOpen = accountPopover.classList.contains('hidden');
    await closeAllPopovers();
    if (willOpen) {
        editingAccountId = null;
        document.getElementById('account-popover-title').textContent = 'Nova conta';
        document.getElementById('account-confirm-btn').textContent = 'Adicionar';
        document.getElementById('account-icon-section').classList.add('hidden'); // só faz sentido depois de criada
        accountPopover.classList.remove('hidden');
        await window.manager.hideActiveView();
        accountNameInput.focus();
    }
}

async function openEditAccountPopover(accountId) {
    const acc = accounts.find(a => a.id === accountId);
    if (!acc) return;
    const willOpen = accountPopover.classList.contains('hidden');
    await closeAllPopovers();
    if (willOpen) {
        editingAccountId = accountId;
        document.getElementById('account-popover-title').textContent = 'Editar conta';
        document.getElementById('account-confirm-btn').textContent = 'Salvar';
        accountNameInput.value = acc.name;
        accountUrlInput.value = acc.url;
        accountProxyInput.value = acc.proxy || '';
        selectedAccountIcon = acc.icon || '';
        document.getElementById('account-icon-section').classList.remove('hidden');
        renderAccountIconPicker();
        accountPopover.classList.remove('hidden');
        await window.manager.hideActiveView();
        accountNameInput.focus();
    }
}

document.getElementById('account-cancel-btn').addEventListener('click', closeAllPopovers);
document.getElementById('account-confirm-btn').addEventListener('click', submitAccountForm);
accountUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAccountForm(); });
accountNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAccountForm(); });

async function submitAccountForm() {
    const name = accountNameInput.value.trim();
    const url = accountUrlInput.value.trim();
    const proxy = accountProxyInput.value.trim();
    if (!name) { accountNameInput.focus(); return; }
    if (!editingAccountId && !url) { accountUrlInput.focus(); return; } // obrigatória só ao criar

    let result;
    if (editingAccountId) {
        result = await window.manager.updateAccount(editingAccountId, name, url, proxy, selectedAccountIcon, undefined);
    } else {
        result = await window.manager.addAccount({ siteId: accountPopoverSiteId, name, url, proxy });
    }
    sites = result.sites;
    accounts = result.accounts;
    activeAccountId = result.activeAccountId;
    closeAllPopovers();
    render();
}

// ========== FECHAR POPOVERS ==========
async function closeAllPopovers() {
    const wasOpen = !sitePopover.classList.contains('hidden') || !accountPopover.classList.contains('hidden');
    sitePopover.classList.add('hidden');
    accountPopover.classList.add('hidden');
    siteNameInput.value = '';
    accountNameInput.value = ''; accountUrlInput.value = ''; accountProxyInput.value = '';
    editingSiteId = null;
    editingAccountId = null;
    // v0.15.0: o bug real era aqui — isso reexibia a ÚLTIMA conta vista
    // (activeAccountId do processo principal nunca é limpo ao voltar pra
    // home), cobrindo a tela inicial inteira com a view nativa do jogo por
    // cima, sem nenhum botão do app visível. Só faz sentido reexibir a
    // view se a gente realmente devia estar numa tela de jogo agora.
    if (wasOpen && viewMode === 'detail') await window.manager.showActiveView();
}

// v0.12.1: removido o "fecha ao clicar fora" — atrapalhava quando o
// usuário precisava clicar em outro lugar da tela (tipo pra copiar uma URL)
// sem querer perder o que já tinha preenchido. Agora só fecha pelo
// Cancelar, Confirmar/Criar/Salvar, ou Esc.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const isOpen = !sitePopover.classList.contains('hidden') || !accountPopover.classList.contains('hidden');
    if (isOpen) closeAllPopovers();
});

// ========== POLL DE STATS (RAM + PING) ==========
async function pollStats() {
    lastStats = await window.manager.getStats();
    // Não re-renderiza durante uma renomeação em andamento — o render
    // reconstrói a aba do zero (perderia o campo editável e cortaria a
    // digitação no meio). Os números só ficam visualmente parados por um
    // instante; assim que a edição terminar, o próximo render já pega o
    // lastStats mais recente.
    // v15.36: mesma lógica pra um arrastar em andamento — reconstruir do
    // zero enquanto a pessoa está arrastando uma aba/card criava um
    // elemento novo (na posição de dados original) ENQUANTO o elemento
    // antigo, ainda referenciado pelo drag, continuava sendo movido pela
    // tela — as duas coexistindo, mesma conta, parecendo um clone.
    if (renameInProgress || dragAccountEl || dragSiteEl) return;
    render();
}

// ========== ATALHOS DE TECLADO ==========
document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return;
    if (viewMode !== 'detail') return;

    const tag = document.activeElement.tagName;
    const isEditing = tag === 'INPUT' || document.activeElement.isContentEditable;
    if (isEditing) return;

    const siteAccounts = accounts.filter(a => a.siteId === currentSiteId);

    if (e.key === 'Tab') {
        e.preventDefault();
        if (siteAccounts.length < 2) return;
        const idx = siteAccounts.findIndex(a => a.id === activeAccountId);
        const delta = e.shiftKey ? -1 : 1;
        const nextIdx = (idx + delta + siteAccounts.length) % siteAccounts.length;
        switchAccount(siteAccounts[nextIdx].id);
        return;
    }

    const num = parseInt(e.key, 10);
    if (num >= 1 && num <= 9 && siteAccounts[num - 1]) {
        e.preventDefault();
        switchAccount(siteAccounts[num - 1].id);
    }
});

// ========== EXPORTAR / IMPORTAR ==========
exportBtn.addEventListener('click', async () => {
    await window.manager.exportData();
});

importBtn.addEventListener('click', async () => {
    if (!confirm('Importar vai ADICIONAR os jogos/contas do arquivo à sua lista atual (não apaga o que já existe). Continuar?')) return;
    const result = await window.manager.importData();
    if (result.ok) {
        sites = result.sites;
        accounts = result.accounts;
        activeAccountId = result.activeAccountId;
        render();
    } else if (result.error) {
        alert(result.error);
    }
});

// ========== AÇÕES DA FAIXA DA CONTA ATIVA ==========
document.getElementById('account-strip-reload-btn').addEventListener('click', () => {
    if (activeAccountId) window.manager.reloadAccount(activeAccountId);
});
document.getElementById('account-strip-edit-btn').addEventListener('click', () => {
    if (activeAccountId) openEditAccountPopover(activeAccountId);
});
document.getElementById('account-strip-icon-wrap').addEventListener('click', () => {
    if (activeAccountId) openEditAccountPopover(activeAccountId); // ícone também abre a edição, é onde se troca
});
document.getElementById('account-strip-close-btn').addEventListener('click', () => {
    if (activeAccountId) removeAccount(activeAccountId);
});
document.getElementById('account-strip-name').addEventListener('dblclick', (e) => {
    if (activeAccountId) startRenameAccount(activeAccountId, e.target);
});

// ========== TELA CHEIA ==========
document.getElementById('fullscreen-btn').addEventListener('click', () => window.manager.toggleFullscreen());
document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); window.manager.toggleFullscreen(); }
});

refreshData();
pollStats();
setInterval(pollStats, 4000);
