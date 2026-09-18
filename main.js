const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { autoUpdater } = require('electron-updater');

// v0.31.24: trava de instância única — sem isso, dava pra abrir o WoL Hub
// mais de uma vez ao mesmo tempo sem querer (ex: clicar 2x rápido no
// atalho, ou abrir de novo esquecendo que já tava aberto minimizado). O
// pior efeito disso apareceu no auto-update: o instalador tenta fechar
// "o WoL Hub" pra sobrescrever o .exe, mas se tiver mais de uma cópia
// rodando, ele não consegue fechar todas e trava em "Não é possível
// fechar o WoL Hub". Agora a segunda tentativa de abrir só foca a janela
// que já existe, em vez de abrir outra por cima.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

const DATA_FILE = path.join(app.getPath('userData'), 'data.json');

// v0.20.3: os logs "[Manager]" rodavam só em console.error() — isso é
// invisível de verdade quando o app tá rodando como .exe instalado (sem
// terminal nenhum grudado nele), então qualquer bug que só aparecesse
// "às vezes" era impossível de diagnosticar depois do fato. Agora todo
// log importante também grava num arquivo de texto de verdade — dá pra
// abrir esse arquivo bem depois de o bug ter acontecido, sem precisar
// pegar no flagra ao vivo.
const LOG_FILE = path.join(app.getPath('userData'), 'wolhub.log');
const LOG_DIR = path.join(app.getPath('userData'), 'logs'); // um arquivo por conta, além do geral
const MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024; // 2MB — depois disso, reseta o arquivo pra não crescer pra sempre

function logToFile(message) {
    try {
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE_BYTES) {
            fs.writeFileSync(LOG_FILE, ''); // reseta quando fica grande demais
        }
        const timestamp = new Date().toLocaleString('pt-BR');
        fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
    } catch (e) {
        // se falhar ao gravar o log, não pode derrubar o app por causa disso
    }
}

function managerLog(message) {
    console.error(`[Manager] ${message}`); // continua no console também, útil em npm start
    logToFile(message);
}

function sanitizeForFilename(name) {
    return String(name).replace(/[^a-zA-Z0-9_\-À-ÿ ]/g, '_').trim().slice(0, 60) || 'conta';
}

// v0.20.10: log com o log geral (misturado, todas as contas juntas — bom
// pra ver a ordem cronológica de tudo) ficava difícil de acompanhar UMA
// conta específica no meio de várias. Agora toda mensagem de conta grava
// TAMBÉM num arquivo só dela, em logs/<nome da conta>.log — dá pra abrir
// só esse arquivo e ver a timeline limpa, sem as outras contas no meio.
function accountLog(accountName, message) {
    managerLog(`"${accountName}" ${message}`); // mantém indo pro log geral também
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const file = path.join(LOG_DIR, `${sanitizeForFilename(accountName)}.log`);
        if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_SIZE_BYTES) fs.writeFileSync(file, '');
        const timestamp = new Date().toLocaleString('pt-BR');
        fs.appendFileSync(file, `[${timestamp}] ${message}\n`);
    } catch (e) {
        // se falhar ao gravar o log, não pode derrubar o app por causa disso
    }
}

// v0.19: chrome superior (2 barras) + um painel HTML único (#game-panel)
// que contém titlebar + viewport. A WebContentsView preenche só o viewport
// interno (abaixo da titlebar, dentro da borda do painel) — igual Idle Labs.
const GAP = 6;
const ROW1_HEIGHT = 44;
const ROW2_HEIGHT = 40;
const STRIP_HEIGHT = 28; // v0.19.4: aumentado de 22 pra 28 — o conteúdo (ícones + ms/RAM) estava vazando pra fora da barra e cortando o topo do jogo
const PANEL_BORDER = 1; // deve bater com border do #game-panel no CSS
const INNER_GAP = 4; // respiro entre a view do jogo e a borda do painel, pros 3 lados que não têm a faixa da conta em cima — sem isso a view cobre a animação da borda
const TOP_BAR_HEIGHT = GAP + ROW1_HEIGHT + GAP + ROW2_HEIGHT;
// topo do viewport = início do painel + borda + titlebar
const GAME_TOP_OFFSET = GAP + ROW1_HEIGHT + GAP + ROW2_HEIGHT + GAP + PANEL_BORDER + STRIP_HEIGHT;
const DEFAULT_URL = 'https://huntera.com.br/';
const PING_INTERVAL_MS = 8000;

let mainWindow = null;
const views = new Map(); // accountId -> WebContentsView (todas existem, só a ativa fica anexada)

// v15.66: PRATELEIRA DE PROXIES REMOVIDA — usava proxies grátis
// (ProxyScrape), instáveis demais na prática. Desde que os proxies
// dedicados (Proxy Brasil) foram comprados, ninguém mais liga essa
// opção — tirada de vez pra não ficar testando/atualizando uma lista
// de proxies à toa em segundo plano.
function getAccountProxy(acc) {
    if (!acc) return '';
    return acc.proxy || '';
}

let sites = [];     // [{ id, name, url }]
let accounts = [];  // [{ id, siteId, name, url }]
let activeAccountId = null;
const pingByAccount = new Map(); // accountId -> ms (ou null se falhou)

// Único lugar que calcula onde a view do jogo fica — usado tanto na
// criação quanto no resize, pra nunca os dois ficarem dessincronizados
// (foi exatamente isso que causou o bug de tela preta da vez passada).
function computeGameViewBounds() {
    const [winW, winH] = mainWindow.getContentSize();
    // v0.19.5: a view SEMPRE desenha por cima do HTML (limitação do
    // Electron) — então onde ela encostava direto na borda do painel
    // (esquerda/direita/baixo), ela cobria a animação da borda por trás,
    // cortando ela no meio do giro. Em cima já funcionava, porque a
    // faixa da conta cria esse espaço naturalmente. Agora um respiro
    // igual nos outros 3 lados, pra animação aparecer inteira.
    const x = GAP + PANEL_BORDER + INNER_GAP;
    const y = GAME_TOP_OFFSET;
    const width = Math.max(0, winW - GAP * 2 - PANEL_BORDER * 2 - INNER_GAP * 2);
    const height = Math.max(0, winH - GAME_TOP_OFFSET - GAP - PANEL_BORDER - INNER_GAP);
    return { x, y, width, height };
}

// ========== PERSISTÊNCIA ==========
function loadData() {
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);
        sites = data.sites || [];
        accounts = data.accounts || [];
        // v15.36: autocorreção — se um save antigo (de antes da correção do
        // bug de "clonar" ao arrastar) já tiver ficado com alguma conta
        // duplicada (mesmo id duas vezes), remove a repetição aqui mesmo,
        // silenciosamente, na próxima vez que o app abrir.
        const seenIds = new Set();
        const deduped = [];
        for (const acc of accounts) {
            if (seenIds.has(acc.id)) continue;
            seenIds.add(acc.id);
            deduped.push(acc);
        }
        if (deduped.length !== accounts.length) {
            managerLog(`Autocorreção: removidas ${accounts.length - deduped.length} conta(s) duplicada(s) de um save antigo.`);
            accounts = deduped;
            saveData();
        }
    } catch (e) {
        sites = [];
        accounts = [];
    }
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ sites, accounts }, null, 2));
}

// ========== INJEÇÃO DE SCRIPTS POR JOGO ==========
// Cada jogo suportado tem seu próprio arquivo em inject/, escolhido pelo
// hostname da URL da conta. Jogos fora desse mapa não recebem injeção
// nenhuma — funcionam normal, só sem os automatismos.
const INJECT_SCRIPTS_BY_HOST = {
    'huntera.com.br': 'huntera-economy.js',
    'baiakidle.com': 'baiak-lowbot.js',
};

function getInjectScriptForUrl(url) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        const file = INJECT_SCRIPTS_BY_HOST[hostname];
        if (!file) return null;
        return fs.readFileSync(path.join(__dirname, 'inject', file), 'utf-8');
    } catch (e) {
        return null;
    }
}

// v0.31.34: mesma checagem de "é uma página de jogo de verdade?" que
// getInjectScriptForUrl já fazia, só que sem reler o arquivo do script
// inteiro do disco toda vez — usado pelo polling de Cloudflare, que roda
// a cada poucos segundos pra CADA conta, e só precisa saber sim/não.
function isGameUrl(url) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        return !!INJECT_SCRIPTS_BY_HOST[hostname];
    } catch (e) {
        return false;
    }
}

// ========== MEDIÇÃO DE PING/MS ==========
// Faz uma requisição HEAD simples pra origem da URL da conta e mede o
// tempo de round-trip. Não é o ping "de jogo" exato, mas dá uma medida
// real e comparável de latência até o servidor.
function measurePing(url) {
    return new Promise((resolve) => {
        let origin;
        try {
            origin = new URL(url).origin;
        } catch (e) {
            resolve(null);
            return;
        }
        const lib = origin.startsWith('https') ? https : http;
        const start = Date.now();
        const req = lib.request(origin, { method: 'HEAD', timeout: 5000 }, (res) => {
            resolve(Date.now() - start);
            res.resume();
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// v0.14.0: antes rodava uma conta de cada vez (await em loop), esperando
// até 5s por conta — com 8 contas e várias engasgadas ao mesmo tempo (bem
// o cenário relatado), um ciclo podia passar muito dos 8s do intervalo e
// os ciclos começavam a empilhar um por cima do outro. Agora todas rodam
// em paralelo, e uma trava (isRunning) impede um ciclo novo de começar
// antes do anterior terminar de verdade.
let pingCycleRunning = false;
async function pingAllAccounts() {
    if (pingCycleRunning) return;
    pingCycleRunning = true;
    try {
        await Promise.all(accounts.map(async (acc) => {
            const ms = await measurePing(acc.url || DEFAULT_URL);
            pingByAccount.set(acc.id, ms);
        }));
    } finally {
        pingCycleRunning = false;
    }
}

setInterval(pingAllAccounts, PING_INTERVAL_MS);

// ========== RECUPERAÇÃO AUTOMÁTICA DE CONTA ==========
// v0.14.0: até aqui, se uma conta crashasse (processo morto por falta de
// RAM, o "network service" do Chromium reiniciando sozinho, etc) ou
// falhasse ao carregar (proxy caindo no meio do caminho), NADA tentava
// recuperar — a conta ficava morta até reiniciar o app inteiro na mão.
// Isso é o motivo real de "fica muito tempo em segundo plano e para de
// funcionar, às vezes desconecta". Cada view agora tem um estado de
// retry próprio, com backoff crescente e um teto pra não martelar um
// proxy realmente morto pra sempre.
const recoveryState = new Map(); // accountId -> { attempts, timer }

function scheduleAccountRecovery(account, reason) {
    const view = views.get(account.id);
    if (!view || view.webContents.isDestroyed()) return;

    let state = recoveryState.get(account.id);
    if (!state) {
        state = { attempts: 0, timer: null };
        recoveryState.set(account.id, state);
    }
    if (state.timer) return; // já tem uma tentativa agendada, não empilha

    state.attempts++;
    if (state.attempts > 10) {
        accountLog(account.name, `desistindo depois de várias tentativas (${reason}) — precisa recarregar manualmente.`);
        return;
    }

    const delayMs = Math.min(3000 * state.attempts, 30000); // 3s, 6s, 9s... até 30s
    accountLog(account.name, `recuperando de "${reason}" — tentativa ${state.attempts} em ${delayMs / 1000}s`);
    state.timer = setTimeout(async () => {
        state.timer = null;
        const v = views.get(account.id);
        if (!v || v.webContents.isDestroyed()) return;
        // Reaplica o proxy antes de tentar de novo — se o motivo foi um
        // túnel de proxy morto, o Chromium às vezes fica preso tentando
        // reaproveitar a conexão ruim; reconfigurar o proxy ajuda a
        // descartar isso antes do reload.
        const proxyToUse = getAccountProxy(account);
        if (proxyToUse) {
            try { await applyProxyToAccount(v, proxyToUse); } catch (e) { /* ignora, tenta o reload mesmo assim */ }
        }
        try {
            v.webContents.reload();
        } catch (e) {
            // view pode ter sido destruída nesse meio-tempo (conta removida) — sem problema
        }
    }, delayMs);
}

function clearAccountRecovery(accountId) {
    const state = recoveryState.get(accountId);
    if (state) {
        state.attempts = 0;
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    }
}

// v0.20.7: usado pelos listeners de falha (did-fail-load e
// render-process-gone) — se a conta estava no meio de um reconnect do
// Modo Hibernar (esperando confirmação), deixa O CICLO tratar a falha, em
// vez do sistema genérico de recuperação disparar junto sem coordenação
// nenhuma (os dois ficavam tentando reconectar ao mesmo tempo, cada um
// sem saber do outro). Retorna true se já tratou (não precisa mais nada).
function handleFailureDuringHibernateReconnect(accountId) {
    const hState = hibernateCycleState.get(accountId);
    if (!hState || !hState.awaitingConfirmation) return false;

    if (hState.confirmTimeoutTimer) { clearTimeout(hState.confirmTimeoutTimer); hState.confirmTimeoutTimer = null; }
    hState.awaitingConfirmation = false;
    const acc = accounts.find(a => a.id === accountId);
    if (acc && hState.confirmAttempts % 10 === 0) {
        accountLog(acc.name, `ainda não conseguiu reconectar depois de ${hState.confirmAttempts} tentativas (Modo Hibernar) — continuando a tentar.`);
    }
    reconnectForHibernate(accountId); // tenta de novo, sem desistir
    return true;
}

// ========== GERENCIAMENTO DAS VIEWS ==========
async function createAccountView(account) {
    const view = new WebContentsView({
        // v0.13.0: sem isso o Electron usa fundo BRANCO por padrão até a
        // página pintar algo — é essa cor branca que aparece quando o
        // carregamento falha ou demora (proxy caindo, etc).
        backgroundColor: '#0f0f14',
        webPreferences: {
            partition: `persist:account-${account.id}`,
            contextIsolation: true,
            sandbox: true,
            spellcheck: false, // dicionário de corretor carregado à toa em cada conta, sem uso real no jogo
            // v15.71/v15.77: REVERTIDO — desligar o throttling de segundo
            // plano parecia resolver o Modo Hibernar não "ativar" sozinho,
            // mas o preço disso é alto demais: sem throttling, a
            // RENDERIZAÇÃO DO PRÓPRIO JOGO (canvas, animações, HUD) também
            // continua rodando em velocidade total em toda conta que está
            // em segundo plano — não dá pra desligar o throttling só pros
            // nossos vigias e manter ligado só pro jogo, é tudo ou nada
            // pra página inteira. Isso ia contra o propósito central do
            // app (gastar menos RAM/CPU que várias abas de navegador
            // normal abertas). A causa raiz de verdade do "não ativa" já
            // foi corrigida do outro lado (v15.72, hasConfirmedGameIdentifier
            // ficava travado em false) — o throttling, na pior das
            // hipóteses, só atrasa o gatilho de inatividade enquanto está
            // em segundo plano (ele ainda dispara, só mais devagar), o que
            // é um preço bem menor que manter o jogo inteiro "acordado".
            preload: path.join(__dirname, 'account-preload.js'),
        },
    });

    // Define o tamanho ANTES de carregar a URL, pra página já nascer
    // sabendo o tamanho real da tela (evita cálculos errados de layout).
    view.setBounds(computeGameViewBounds());

    // v0.31.33: REVERTIDO DE VERDADE — a v0.31.28 trocava o User-Agent
    // pra "Chrome comum" e reescrevia os headers de Client Hints pra
    // combinar, achando que isso ajudava a passar no Cloudflare. Um teste
    // isolado provou o contrário: esse disfarce troca só os HEADERS HTTP,
    // mas não muda o que o JavaScript da página vê por
    // navigator.userAgentData — ela continua revelando a identidade real
    // do Electron por esse caminho. Essa inconsistência (headers dizendo
    // "Chrome" enquanto o JS vê outra coisa) era EXATAMENTE o sinal que
    // travava o Cloudflare. Usando o Electron do jeito que é (sem
    // disfarce nenhum), o desafio passa normal. Deixa comentado aqui só
    // pra não repetir esse mesmo erro de novo no futuro.

    // Proxy por conta — configurado ANTES de carregar a URL, na session
    // própria dessa partition (não afeta as outras contas). Aceita
    // "http://user:pass@host:porta" ou "socks5://host:porta".
    const startupProxy = getAccountProxy(account);
    if (startupProxy) {
        await applyProxyToAccount(view, startupProxy);
    }

    views.set(account.id, view);

    // v0.19.8: o Chromium parece não processar de verdade o carregamento
    // de uma WebContentsView que nunca foi anexada a uma janela — mesmo
    // chamando loadURL(), ela fica "pendurada" sem progredir até ser
    // anexada pela primeira vez (foi isso que causava "só carrega quando
    // eu clico na conta"). Anexa fora da área visível só pra forçar esse
    // carregamento inicial de verdade, e desanexa em seguida se não for
    // a conta ativa — assim mantém a economia de RAM de sempre depois
    // que o carregamento inicial já rolou.
    // v0.20.4: era 1x1 pixel — jogos com layout responsivo (como esse)
    // calculam a posição das janelas internas (Party, Loot, Inventário)
    // baseado no tamanho da tela NO MOMENTO em que carregam, e parecem
    // gravar isso errado quando esse tamanho é 1x1, causando aquela
    // bagunça visual (janelas sobrepostas) só resolvida com reload. Agora
    // usa o tamanho REAL da tela — só a posição fica fora da área
    // visível, não o tamanho.
    const initialBounds = computeGameViewBounds();
    view.setBounds({ ...initialBounds, x: -10000 - initialBounds.width, y: -10000 });
    mainWindow.contentView.addChildView(view);
    // v15.53: BUG DE VERDADE — isso carregava a URL do jogo de verdade
    // pra TODA conta ao abrir o app, sem nunca checar se ela estava
    // desativada manualmente (Ctrl+clique). O flag salvo continuava
    // true e a tela mostrava o card/aba apagado, mas por trás a conta
    // voltava a rodar o jogo normal, gastando RAM e conseguindo alarmar
    // — exatamente o que foi visto. Agora respeita o estado salvo desde
    // o primeiro carregamento.
    const startupUrl = account.manuallyDisabled
        ? `file://${path.join(__dirname, 'inject', 'manually-disabled.html')}`
        : (account.url || DEFAULT_URL);
    view.webContents.loadURL(startupUrl);
    view.webContents.once('did-finish-load', () => {
        if (activeAccountId !== account.id && views.has(account.id)) {
            mainWindow.contentView.removeChildView(view);
            // v15.18: Modo Hibernar parou de disparar por "tempo em segundo
            // plano" — agora é o próprio script injetado que detecta
            // inatividade humana de verdade (clique/mouse/tecla) e avisa
            // quando precisa hibernar (ver account:hibernate-inactivity-
            // trigger). Não agenda mais nada aqui.
        }
    });

    const script = getInjectScriptForUrl(account.url || DEFAULT_URL);
    if (script) {
        // v0.20.9: bug corrigido — isso disparava em QUALQUER navegação
        // dessa conta, inclusive pra about:blank (passo novo do reset de
        // proxy) e pra hibernate-parking.html. Injetar o bot inteiro numa
        // página vazia, sem elemento nenhum do jogo, fazia o script
        // travar com erro ("falha ao injetar script"), atrapalhando o
        // ciclo à toa. Agora só injeta se a URL atual for realmente do
        // jogo — confere de novo a cada dom-ready, não só uma vez na
        // criação da conta.
        view.webContents.on('dom-ready', () => {
            const currentUrl = view.webContents.getURL();
            if (!getInjectScriptForUrl(currentUrl)) return; // about:blank, página de espera, etc — não injeta nada aqui
            view.webContents.executeJavaScript(script).catch(err => {
                managerLog(`Falha ao injetar script na conta "${account.name}": ${err.message}`);
            });
        });
    }

    // Carregou com sucesso — zera o contador de tentativas de recuperação.
    view.webContents.on('did-finish-load', () => clearAccountRecovery(account.id));

    // Falha ao carregar (proxy caiu, timeout, DNS, etc) — só reage a falha
    // do frame PRINCIPAL (ignora sub-recursos) e ignora ERR_ABORTED (-3,
    // navegação cancelada de propósito, ex: loadURL novo chamado antes do
    // anterior terminar — não é falha real).
    view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        accountLog(account.name, `falhou ao carregar: ${errorDescription} (${errorCode})`);
        if (handleFailureDuringHibernateReconnect(account.id)) return;
        scheduleAccountRecovery(account, `carregamento falhou (${errorDescription})`);
    });

    // O processo dessa conta morreu de verdade (crash, killed por falta de
    // RAM, ou o network-service do Chromium derrubando ela junto). Antes
    // disso não tinha NENHUM tratamento — a conta ficava com tela parada
    // pra sempre até reiniciar o app inteiro na mão.
    view.webContents.on('render-process-gone', (event, details) => {
        accountLog(account.name, `processo encerrado: ${details.reason}`);
        if (handleFailureDuringHibernateReconnect(account.id)) return;
        scheduleAccountRecovery(account, `processo encerrado (${details.reason})`);
    });

    // Não força nada aqui (matar um processo só "lento" pode interromper
    // algo legítimo) — só deixa registrado pra dar visibilidade se isso
    // vier a ser a causa de algum travamento no futuro.
    view.webContents.on('unresponsive', () => {
        accountLog(account.name, `está sem responder.`);
    });
    view.webContents.on('responsive', () => {
        accountLog(account.name, `voltou a responder.`);
    });

    return view;
}

// v0.31.38: pedido/achado do usuário — abrir várias contas de uma vez
// (na inicialização do app, ou importando um backup) disparava TODAS ao
// mesmo tempo, sem nenhum espaçamento. Com muitas contas (relatado com
// 28), isso é um estouro de conexões simultâneas — mesmo em proxies com
// endereços "diferentes", se várias saem pelo mesmo servidor físico por
// trás (comum em provedores de proxy), o volume de conexões batendo
// junto pode disparar bloqueio/rate-limit coletivo do lado do servidor
// do jogo, derrubando contas que sozinhas conectariam numa boa (bateu
// com o relato: desligar algumas deixou as outras logarem). A primeira
// conta continua abrindo na hora (é a que vira a aba ativa); as
// seguintes são espalhadas em ~400-700ms cada uma.
function createAccountViewsStaggered(accountList) {
    accountList.forEach((acc, index) => {
        if (index === 0) {
            createAccountView(acc);
            return;
        }
        const delay = index * (400 + Math.floor(Math.random() * 300));
        setTimeout(() => createAccountView(acc), delay);
    });
}

function removeAccountView(id) {
    const view = views.get(id);
    if (!view) return;
    clearAccountRecovery(id);
    recoveryState.delete(id);
    clearHibernateTimers(id);
    hibernateCycleState.delete(id);
    if (activeAccountId === id) {
        mainWindow.contentView.removeChildView(view);
        hideCurtain(); // v15.57: mesma correção — se essa conta estava com a cortina em cima, ela precisa sumir junto
        activeAccountId = null;
        mainWindow.webContents.focus(); // reforça o foco após remover a view ativa
    }
    if (!view.webContents.isDestroyed()) {
        view.webContents.close?.();
    }
    views.delete(id);
    pingByAccount.delete(id);
    cloudflareChallengeState.delete(id);
}

// ========== CORTINA (esconde o processo real do Modo Hibernar) ==========
// v15.55: view ÚNICA e global (não uma por conta) — fica sempre com a
// MESMA página de espera, e é encaixada por cima da conta real sempre
// que a aba ativa tiver o Modo Hibernar ligado. A conta por trás continua
// reconectando/descarregando do jeito de sempre (economia de RAM
// intacta) — só que a pessoa nunca vê a troca, porque a cortina nunca
// muda de página, só os números que ela mostra.
let curtainView = null;
let curtainCoveringAccountId = null;
let curtainReady = false; // v15.63: true só depois do 'did-finish-load' de verdade — nunca mais um chute de tempo fixo

function ensureCurtainView() {
    if (curtainView) return curtainView;
    curtainView = new WebContentsView({
        backgroundColor: '#0f0f14',
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            spellcheck: false,
            backgroundThrottling: false, // v15.71: mesma correção — o contador dela também precisa continuar rodando certinho
            preload: path.join(__dirname, 'curtain-preload.js'),
        },
    });
    curtainView.webContents.loadFile(path.join(__dirname, 'inject', 'hibernate-parking.html'), { query: { curtain: '1' } });
    // v15.63: BUG DE VERDADE — antes disso, mandava o primeiro update com
    // um reforço de 400ms fixo, que era só um chute; numa máquina com
    // muita coisa carregando de uma vez (16+ contas ao abrir o app), a
    // página podia demorar mais que isso pra terminar de carregar, e a
    // mensagem se perdia de vez (só o refresh de 2s seguinte chegava,
    // e se a pessoa não ficasse olhando por 2s, parecia bugado). Agora
    // espera o evento de verdade antes de mandar qualquer coisa.
    curtainView.webContents.once('did-finish-load', () => {
        curtainReady = true;
        if (curtainCoveringAccountId) sendCurtainUpdate(curtainCoveringAccountId);
    });
    return curtainView;
}

function getCurtainDataForAccount(id) {
    const state = hibernateCycleState.get(id);
    return {
        targetTs: (state && state.hibernateTargetTs) || Date.now(),
        sessionSnapshot: (state && state.sessionSnapshot) || null,
    };
}

function sendCurtainUpdate(id) {
    if (!curtainView || curtainView.webContents.isDestroyed()) return;
    if (curtainCoveringAccountId !== id) return; // já trocou de conta antes disso rodar — não manda dado desatualizado
    curtainView.webContents.send('curtain:update', getCurtainDataForAccount(id));
}

function refreshCurtainIfShown() {
    if (!curtainReady || !curtainCoveringAccountId) return;
    sendCurtainUpdate(curtainCoveringAccountId);
}
setInterval(refreshCurtainIfShown, 2000);

function showCurtainOverAccount(id) {
    const view = ensureCurtainView();
    curtainCoveringAccountId = id;
    view.setBounds(computeGameViewBounds());
    mainWindow.contentView.addChildView(view); // adicionada por ÚLTIMO = fica por cima da conta na pilha visual
    // v15.63: só manda na hora se a página já confirmou que carregou
    // (curtainReady) — senão, o listener do did-finish-load lá em cima
    // já vai mandar assim que ela terminar de carregar de verdade.
    if (curtainReady) sendCurtainUpdate(id);
}

function hideCurtain() {
    if (!curtainView) return;
    curtainCoveringAccountId = null;
    try { mainWindow.contentView.removeChildView(curtainView); } catch (e) { /* já não estava anexada, sem problema */ }
}

ipcMain.on('curtain:wake-now', () => {
    if (!curtainCoveringAccountId) return;
    const id = curtainCoveringAccountId;
    const view = views.get(id);
    const acc = accounts.find(a => a.id === id);
    if (!acc || !view) return;
    // v15.65: só pra dar visibilidade no log — se o ciclo automático já
    // tinha começado uma tentativa de reconexão bem na hora que a barra
    // foi arrastada (raro, mas possível), reconnectForHibernate() abaixo
    // vai simplesmente ignorar esse chamado (ela mesma já se protege
    // contra sobrepor tentativas) e deixar a tentativa automática em
    // andamento terminar sozinha — sem isso no log, parecia que arrastar
    // a barra não tinha feito nada, sem nenhum rastro do motivo.
    const stateNow = hibernateCycleState.get(id);
    if (stateNow && stateNow.reconnectInFlight) {
        accountLog(acc.name, 'arrastou a barra na cortina, mas já tinha uma reconexão automática em andamento — deixando ela terminar sozinha');
    }
    clearHibernateTimers(id);
    reconnectForHibernate(id);
});

ipcMain.on('curtain:disable-hibernate-cycle', () => {
    if (!curtainCoveringAccountId) return;
    const id = curtainCoveringAccountId;
    const acc = accounts.find(a => a.id === id);
    const view = views.get(id);
    if (!acc || !view) return;
    acc.hibernateCycleEnabled = false;
    saveData();
    accountLog(acc.name, 'Modo Hibernar desligado pela cortina da página de espera');
    clearHibernateTimers(id);
    const state = getHibernateState(id);
    state.unloaded = false;
    hideCurtain(); // já não tem mais Modo Hibernar nessa conta — some a cortina na hora, revela a conta de verdade por baixo
    const url = (acc.url || DEFAULT_URL) + '#wolhub-disable-hibernate';
    view.webContents.loadURL(url).catch(() => {});
});

// ========== TROCA DE CONTA ATIVA ==========
function switchToAccount(id) {
    if (!views.has(id)) return;
    if (activeAccountId === id) return;

    if (activeAccountId && views.has(activeAccountId)) {
        const oldView = views.get(activeAccountId);
        mainWindow.contentView.removeChildView(oldView);
        // v15.18: não agenda grace nenhum por troca de aba — o script
        // injetado decide sozinho por inatividade humana de verdade.
        // v15.78 tentou uma "carência" geral de 15s aqui, mas o usuário
        // relatou que isso travava bastante o app — revertido em v0.31.19.
        // O throttling só é mexido dentro do fluxo do Modo Hibernar mesmo
        // (ver reconnectForHibernate e os handlers de confirmação).
    }
    hideCurtain(); // sempre começa escondida — só reaparece embaixo se a conta nova também tiver Modo Hibernar

    const view = views.get(id);
    mainWindow.contentView.addChildView(view);
    activeAccountId = id; // precisa vir ANTES do resize — resizeActiveView() lê essa variável
    view.setBounds(computeGameViewBounds()); // corrige a posição/tamanho na hora, direto na view certa
    wakeFromHibernateCycle(id); // só cancela o ciclo pendente — NÃO reconecta sozinho (só a barra na página de espera faz isso)
    updateTaskbarIconForActiveAccount();

    // v15.60: BUG DE VERDADE — isso mostrava a cortina só por causa do
    // Modo Hibernar estar MARCADO, mesmo que a conta ainda estivesse
    // rodando normal (não tinha descarregado de verdade ainda, esperando
    // os 20s de inatividade). Resultado: a cortina "mentia" que já tinha
    // hibernado, quando na real o jogo continuava on por trás. Agora só
    // mostra se a conta REALMENTE já descarregou (state.unloaded).
    // v15.78: BUG DE VERDADE — só olhava state.unloaded, mas depois que
    // reconnectForHibernate começa a tentar (arrastando a barra, ou o
    // ciclo automático disparando enquanto essa aba estava em segundo
    // plano), unloaded já vira false ANTES de confirmar de verdade — se
    // você saísse da aba durante esse meio-tempo e voltasse, a cortina
    // não reaparecia, revelando a tela de "reconectando" por baixo (só
    // acontecia ficando na aba o tempo todo, nunca saindo dela, porque aí
    // a cortina nunca tinha motivo pra ser escondida e remostrada do
    // zero). Agora também reaparece se ainda estiver no meio da
    // confirmação — só fica escondida de vez quando confirma de verdade.
    const acc = accounts.find(a => a.id === id);
    const stateForCurtain = hibernateCycleState.get(id);
    const stillMidReconnect = stateForCurtain && (stateForCurtain.awaitingConfirmation || stateForCurtain.reconnectInFlight);
    if (acc && acc.hibernateCycleEnabled && stateForCurtain && (stateForCurtain.unloaded || stillMidReconnect)) {
        showCurtainOverAccount(id);
    }
}

// v0.19.6: o ícone da barra de tarefas muda de cor em tempo real,
// acompanhando a cor do jogo da conta ativa — sem precisar reiniciar o
// app. Usa os .ico pré-gerados em build/icon-colors/.
const VALID_ICON_COLORS = ['red', 'orange', 'amber', 'gold', 'yellow', 'lime', 'leaf', 'green', 'emerald', 'mint', 'teal', 'cyan', 'sky', 'azure', 'blue', 'indigo', 'violet', 'purple', 'magenta', 'pink', 'rose'];
function updateTaskbarIconForActiveAccount() {
    if (!mainWindow) return;
    const acc = accounts.find(a => a.id === activeAccountId);
    const site = acc ? sites.find(s => s.id === acc.siteId) : null;
    const color = (site && VALID_ICON_COLORS.includes(site.iconColor)) ? site.iconColor : 'gold';
    const iconPath = path.join(__dirname, 'build', 'icon-colors', `${color}.ico`);
    try {
        mainWindow.setIcon(iconPath);
    } catch (e) {
        // se o arquivo não existir por algum motivo, mantém o ícone atual — nunca quebra por isso
    }
}

// v0.20.1: hibernateAccountView/wakeAccountView (o congelamento leve via
// __huntEcoHibernate/__huntEcoWake) foram removidos — o "Modo Hibernação"
// que eles serviam saiu do script injetado, virou inútil depois do Modo
// Hibernar de verdade (que descarrega a conta inteira). As chamadas nos
// outros lugares deste arquivo também foram removidas junto.


function resizeActiveView() {
    if (!mainWindow || !activeAccountId) return;
    const view = views.get(activeAccountId);
    if (!view) return;
    view.setBounds(computeGameViewBounds());
    if (curtainView && curtainCoveringAccountId) {
        curtainView.setBounds(computeGameViewBounds());
    }
}

// ========== AUTO-UPDATE ==========
// v0.31.23: pedido do usuário — antes de abrir a janela principal de
// verdade, mostra uma janelinha pequena de carregamento verificando se
// tem versão nova (via GitHub Releases). Se tiver, baixa e instala
// sozinho (reinicia já atualizado); se não tiver (ou der qualquer erro,
// tipo sem internet), fecha a janelinha e abre o app normal — nunca
// trava esperando, sempre tem um jeito de seguir em frente.
function createSplashWindow() {
    const splash = new BrowserWindow({
        width: 320,
        height: 190,
        frame: false,
        resizable: false,
        movable: true,
        show: false,
        backgroundColor: '#0f0f14',
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'splash-preload.js'),
            contextIsolation: true,
        },
    });
    // v0.31.25: manda a versão atual (package.json, via app.getVersion())
    // como query string — a splash não tem acesso direto ao módulo "app"
    // (roda isolada, sem Node no contexto da página), só assim ela sabe
    // exibir qual versão é essa.
    splash.loadFile('splash.html', { query: { v: app.getVersion() } });
    splash.once('ready-to-show', () => splash.show());
    return splash;
}

function startWithUpdateCheck() {
    const splash = createSplashWindow();
    let finished = false;

    // v0.31.25: BUG DE VERDADE (relatado pelo usuário) — antes disso, a
    // janela principal (createMainWindow) já nascia visível por padrão e
    // aparecia "por cima" da splash quase no mesmo instante que ela
    // fechava, dando uma sensação de sobreposição/mal feito. Agora a
    // janela principal só é criada (e só aparece, show:false + só mostra
    // no ready-to-show) DEPOIS que a splash já fechou de vez, com uma
    // pequena pausa proposital no meio — fica splash suja, some, tela
    // preta rápida, app aparece já pronto. Mais parecido com app "de
    // verdade" do que um pulando em cima do outro.
    const proceed = () => {
        if (finished) return;
        finished = true;
        clearTimeout(checkTimeoutTimer);
        clearTimeout(stallTimer);
        startupTransitioning = true; // v0.31.27: avisa o window-all-closed pra não fechar o app nesse intervalo
        if (!splash.isDestroyed()) splash.close();
        setTimeout(() => {
            startupTransitioning = false;
            createMainWindow();
        }, 2500);
    };

    // v0.31.23: rede lenta/instável, GitHub fora do ar, sem internet — não
    // importa o motivo, depois de 12s desiste de esperar e abre o app
    // normal mesmo (o usuário não devia nunca ficar travado numa
    // janelinha de "verificando" pra sempre).
    // v0.31.26: BUG DE VERDADE (relatado pelo usuário) — esse prazo de 12s
    // valia pra checagem E pro download inteiro juntos. O instalador tem
    // uns 110MB — numa internet que não seja rápida, os 12s estouravam no
    // MEIO do download, abrindo a versão antiga mesmo (com o download
    // ainda rolando escondido, podendo fechar o app sozinho depois do
    // nada quando terminasse). Agora esse timer só vale pra fase de
    // CHECAGEM (antes de saber se tem atualização); assim que confirma
    // que tem uma versão nova pra baixar, ele é cancelado de vez — o
    // download passa a ter sua própria trava (mais embaixo), que só
    // desiste se ficar tempo demais SEM PROGRESSO NENHUM, não por um
    // limite fixo de tempo total.
    let checkTimeoutTimer = setTimeout(() => {
        managerLog('Updater: demorou demais pra checar, seguindo sem atualizar dessa vez.');
        proceed();
    }, 12000);

    // v0.31.26: só entra em ação depois que o download já começou de
    // verdade — reinicia a cada pedaço baixado (download-progress). Só
    // desiste se ficar 60s SEM NENHUM progresso novo (conexão travou de
    // verdade), nunca só por causa do tamanho do arquivo/download lento
    // (mas ainda rolando).
    let stallTimer = null;
    function resetStallTimer() {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            managerLog('Updater: download travado (sem progresso por 60s), seguindo sem atualizar dessa vez.');
            proceed();
        }, 60000);
    }

    autoUpdater.on('update-not-available', () => proceed());
    autoUpdater.on('error', (err) => {
        managerLog(`Updater: erro ao checar/baixar atualização — ${err.message}`);
        proceed();
    });
    autoUpdater.on('update-available', (info) => {
        clearTimeout(checkTimeoutTimer); // já sabe que tem atualização — não desiste mais só por tempo de checagem
        resetStallTimer();
        if (!splash.isDestroyed()) splash.webContents.send('splash:status', `Baixando atualização v${info.version}...`);
    });
    autoUpdater.on('download-progress', (progress) => {
        resetStallTimer();
        if (!splash.isDestroyed()) splash.webContents.send('splash:progress', Math.round(progress.percent));
    });
    autoUpdater.on('update-downloaded', () => {
        clearTimeout(checkTimeoutTimer);
        clearTimeout(stallTimer);
        if (!splash.isDestroyed()) splash.webContents.send('splash:status', 'Instalando atualização...');
        autoUpdater.quitAndInstall(); // fecha e reabre sozinho já atualizado
    });

    autoUpdater.checkForUpdates().catch((e) => {
        managerLog(`Updater: falha ao iniciar checagem — ${e.message}`);
        proceed();
    });
}

// ========== JANELA PRINCIPAL ==========
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        backgroundColor: '#0f0f14',
        show: false, // v0.31.25: só aparece pronta (ready-to-show), sem flash branco/nascer pela metade
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        },
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadFile('index.html');
    mainWindow.on('resize', resizeActiveView);
    mainWindow.on('enter-full-screen', resizeActiveView);
    mainWindow.on('leave-full-screen', resizeActiveView);

    createAccountViewsStaggered(accounts);
    if (accounts.length > 0) {
        switchToAccount(accounts[0].id);
    }

    pingAllAccounts(); // primeira medição já de cara, não espera o intervalo
}

app.whenReady().then(() => {
    // O app já tem a própria barra (WoL Hub, abas, etc) — o menu nativo do
    // Electron (File/Edit/View/Window) não tem nenhuma função ligada a
    // ele, só aparecia sozinho por padrão e destoava do resto da interface.
    Menu.setApplicationMenu(null);
    loadData();
    // v0.31.23: checagem de atualização só faz sentido no .exe instalado
    // de verdade (app.isPackaged) — rodando via `npm start`/`electron .`
    // durante os testes, não tem build nenhum publicado pra checar contra,
    // então pula direto pro app normal.
    if (app.isPackaged) {
        startWithUpdateCheck();
    } else {
        createMainWindow();
    }
});

// v0.31.27: BUG DE VERDADE (relatado pelo usuário) — a pausa proposital de
// 2,5s entre a splash fechar e a janela principal abrir (v0.31.25) criava
// um intervalo real com ZERO janelas abertas. Esse handler existe desde
// sempre pra fechar o app quando o usuário fecha a última janela dele —
// só que ele não sabe diferenciar "usuário fechou tudo de propósito" de
// "estamos no meio da troca splash → janela principal, é só um instante".
// Sem essa distinção, o app se encerrava sozinho bem no meio daquela
// pausa, antes da janela principal ter a chance de nascer — por isso
// "a splash fecha e o app não abre". A flag abaixo avisa esse handler pra
// ignorar esse intervalo específico.
let startupTransitioning = false;

app.on('window-all-closed', () => {
    if (startupTransitioning) return; // só um instante sem janela nenhuma, não é o usuário fechando tudo
    if (process.platform !== 'darwin') app.quit();
});

// ========== PROXY POR CONTA ==========
// Aceita "http://usuario:senha@host:porta" ou "socks5://host:porta" (sem
// login). Guardamos as credenciais associadas ao id do webContents pra
// responder o desafio de autenticação do proxy quando ele pedir.
const proxyCredentials = new Map(); // webContents.id -> { username, password }

async function applyProxyToAccount(view, proxyString) {
    try {
        const parsed = new URL(proxyString);
        const protocol = parsed.protocol.replace(':', ''); // http, https, socks5
        const proxyRules = `${protocol}://${parsed.hostname}:${parsed.port}`;
        await view.webContents.session.setProxy({ proxyRules });

        if (parsed.username) {
            proxyCredentials.set(view.webContents.id, {
                username: decodeURIComponent(parsed.username),
                password: decodeURIComponent(parsed.password || ''),
            });
        }
    } catch (e) {
        managerLog(`Proxy inválido, ignorando: ${proxyString} — ${e.message}`);
    }
}

// v0.19.7: reconectar uma conta agora sempre trata o proxy também, num
// clique só — se a conta tem proxy configurado, faz a sequência que
// resolve "tela branca" (solta o proxy, recarrega pro IP normal, recoloca
// o mesmo proxy, recarrega de novo). Se não tem proxy, só recarrega
// normal, sem erro nenhum. Isso substitui o botão separado de "reiniciar
// proxy" que existia antes — ficou redundante.
// v0.19.9: mesmo princípio do que resolveu "só carrega quando clico" —
// só que disparado quando o script injetado avisa que acabou de aceitar
// uma hunt (o jogo só inicia a caçada de verdade se a página estiver
// "viva"/anexada bem nesse instante). Mantém anexada fora da tela por
// alguns segundos e desanexa de novo se não for a conta ativa.
function keepViewAliveBriefly(view, ms) {
    if (!view || view.webContents.isDestroyed()) return;
    const accountId = [...views.entries()].find(([, v]) => v === view)?.[0];
    const alreadyVisible = accountId === activeAccountId;
    if (!alreadyVisible) {
        const bounds = computeGameViewBounds();
        view.setBounds({ ...bounds, x: -10000 - bounds.width, y: -10000 });
        mainWindow.contentView.addChildView(view);
    }
    setTimeout(() => {
        if (view.webContents.isDestroyed()) return;
        if (accountId !== activeAccountId) {
            mainWindow.contentView.removeChildView(view);
        }
    }, ms);
}

// v0.20.10: aviso do momento EXATO em que uma conta caiu — antes o log só
// mostrava as ações do bot DEPOIS da queda, nunca o instante real dela,
// dificultando achar a causa. Usa um prefixo bem visível (⚠️) pra pular
// aos olhos ao dar uma olhada rápida no arquivo.

ipcMain.on('account:notify-disconnected', (event) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id] = found;
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    accountLog(acc.name, `⚠️ DESCONECTOU (caiu pra tela de login/personagem agora)`);
});

ipcMain.on('account:keep-alive-briefly', (event) => {
    const view = [...views.values()].find(v => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (view) keepViewAliveBriefly(view, 30000); // 30s — tempo de entrar na hunt e iniciar de verdade
});

// ========== MODO HIBERNAR (descarrega a conta de verdade) ==========
// v0.20.0: diferente da hibernação leve (só congela o desenho) — aqui a
// conta é DESCARREGADA da memória de verdade (navega pra about:blank,
// que libera quase tudo: JS, WebGL, DOM) e reconecta sozinha de tempos em
// tempos, só o suficiente pra não perder o progresso offline do Huntera
// e deixar o Auto-Despachar Loot vender (ele já roda sozinho ao carregar
// a página, não precisa de código extra pra isso). Só o processo
// principal consegue fazer esse descarregamento de verdade — por isso
// mora aqui, não no script injetado.
const hibernateCycleState = new Map(); // accountId -> { graceTimer, cycleTimer, unloaded }
const HIBERNATE_RECONNECT_WINDOW_MS = 25000; // fica carregada por ~25s a cada reconexão, tempo de vender loot etc

function getHibernateState(id) {
    let s = hibernateCycleState.get(id);
    if (!s) {
        s = { graceTimer: null, cycleTimer: null, unloaded: false, confirmTimeoutTimer: null, awaitingConfirmation: false, confirmAttempts: 0 };
        hibernateCycleState.set(id, s);
    }
    return s;
}

function clearTimer(state, key) {
    if (state[key]) { clearTimeout(state[key]); state[key] = null; }
}

function clearHibernateTimers(id) {
    const s = hibernateCycleState.get(id);
    if (!s) return;
    clearTimer(s, 'graceTimer');
    clearTimer(s, 'cycleTimer');
    clearTimer(s, 'confirmTimeoutTimer');
    s.awaitingConfirmation = false;
}

// Chamado quando a conta sai da aba ativa — espera N segundos
// (configurável no painel, 0–120) antes de descarregar de verdade.
// 0 = descarrega na hora; padrão 10s (tempo de só trocar de aba sem querer).
function scheduleHibernateGrace(id, reason = 'saiu da aba') {
    const acc = accounts.find(a => a.id === id);
    if (!acc || !acc.hibernateCycleEnabled) return;
    const state = getHibernateState(id);
    // v15.11: a checagem antiga só olhava graceTimer/cycleTimer — mas
    // nenhum dos dois fica "ocupado" durante o meio de uma reconexão em
    // andamento (reconnectForHibernate zera o cycleTimer logo no início e
    // só recria ele depois de confirmar ou desistir). Isso deixava uma
    // brecha: se o usuário clicasse pra fora dessa aba bem durante uma
    // tentativa de reconexão (ex: clicou pra conferir a conta travada e
    // voltou pra outra), esse agendamento passava batido e descarregava a
    // conta no meio do processo — cancelando a reconexão sem nunca
    // confirmar. Agora também recusa agendar enquanto uma reconexão está
    // de fato em andamento ou esperando confirmação.
    // v15.13: log em todo lugar que pode levar a um descarregamento — sem
    // isso, um "descarregada" sem "reconectando" antes era impossível de
    // saber de onde veio (ciclo automático? troca de aba? toggle ligado
    // de novo?). Agora cada caminho se identifica.
    if (state.graceTimer || state.cycleTimer || state.awaitingConfirmation || state.reconnectInFlight) {
        accountLog(acc.name, `grace ignorado (${reason}) — já tem algo agendado ou uma reconexão em andamento`);
        return;
    }
    let graceSec = parseInt(acc.hibernateGraceSeconds, 10);
    if (isNaN(graceSec)) graceSec = 10;
    graceSec = Math.max(0, Math.min(120, graceSec));
    const graceMs = graceSec * 1000;
    accountLog(acc.name, `grace agendado (${reason}) — descarrega em ${graceSec}s se continuar fora da aba`);
    state.graceTimer = setTimeout(() => {
        state.graceTimer = null;
        if (activeAccountId === id) return; // voltou a ficar ativa nesse meio-tempo
        unloadForHibernate(id, `grace: ${reason}`);
    }, graceMs);
}

// v0.20.5: mesmo princípio do que resolveu "só carrega quando eu clico"
// no início — o Chromium parece não processar de verdade a navegação de
// uma WebContentsView que está desanexada da janela. O ciclo do Modo
// Hibernar reconectava/descarregava numa view desanexada o tempo todo,
// sem esse cuidado — provavelmente a causa real de "às vezes trava".
// Essa função sempre anexa fora da área visível (tamanho real, só a
// posição fora) antes de navegar, e desanexa de novo depois que o
// carregamento realmente termina — a não ser que a conta tenha virado a
// ativa nesse meio-tempo, aí fica anexada normal.
function loadUrlReliably(id, view, url) {
    if (!view || view.webContents.isDestroyed()) return;
    const alreadyActive = id === activeAccountId;
    if (!alreadyActive) {
        const bounds = computeGameViewBounds();
        view.setBounds({ ...bounds, x: -10000 - bounds.width, y: -10000 });
        mainWindow.contentView.addChildView(view); // se já tava anexada (ex: página de espera), é inofensivo — só reordena
    }
    view.webContents.loadURL(url).catch((e) => {
        managerLog(`loadUrlReliably falhou (${url.slice(0, 60)}...): ${e.message}`);
    });
    view.webContents.once('did-finish-load', () => {
        if (view.webContents.isDestroyed()) return;
        if (id !== activeAccountId) {
            mainWindow.contentView.removeChildView(view);
        }
    });
}

// v15.29: desativar/reativar manual — Ctrl+clique na aba (ou no card do
// jogo, pra todas de uma vez). Diferente do Modo Hibernar: não tem ciclo
// nenhum de reconexão automática, fica desativada até alguém religar na
// mão. Cancela qualquer timer de recovery/hibernar pendente pra não
// competir com esse estado.
function setAccountManualDisabled(id, disabled) {
    const acc = accounts.find(a => a.id === id);
    const view = views.get(id);
    if (!acc || !view || view.webContents.isDestroyed()) return;
    if (!!acc.manuallyDisabled === !!disabled) return; // já está nesse estado, não faz nada

    acc.manuallyDisabled = !!disabled;
    saveData();
    clearAccountRecovery(id);
    clearHibernateTimers(id);

    if (acc.manuallyDisabled) {
        const disabledUrl = `file://${path.join(__dirname, 'inject', 'manually-disabled.html')}`;
        loadUrlReliably(id, view, disabledUrl);
        accountLog(acc.name, 'desativada manualmente (Ctrl+clique) — economia de RAM');
    } else {
        loadUrlReliably(id, view, acc.url || DEFAULT_URL);
        accountLog(acc.name, 'reativada manualmente (Ctrl+clique)');
    }
}

function unloadForHibernate(id, reason = 'ciclo automático', forceEvenIfActive = false) {
    const acc = accounts.find(a => a.id === id);
    const view = views.get(id);
    if (!acc || !acc.hibernateCycleEnabled || !view || view.webContents.isDestroyed()) return;
    // v15.18: a inatividade humana agora hiberna mesmo a aba que está sendo
    // vista (é o ponto todo do recurso) — forceEvenIfActive pula essa
    // trava só nesse caso específico; os outros caminhos continuam nunca
    // descarregando a aba ativa.
    if (activeAccountId === id && !forceEvenIfActive) return; // nunca descarrega a que está sendo vista
    // v15.65: segunda camada de proteção — o script injetado já foi
    // corrigido pra nunca mais mandar o gatilho de inatividade enquanto
    // está confirmando uma reconexão (podia abortar a confirmação no
    // meio, sem nunca soltar o sinal que tira a cortina). Mas se por
    // qualquer motivo esse sinal chegar aqui mesmo assim durante uma
    // reconexão que o PRÓPRIO processo principal sabe que está em
    // andamento, recusa e deixa ela terminar sozinha — nunca interrompe
    // um reconnect que já está sendo confirmado.
    const stateGuard = hibernateCycleState.get(id);
    if (stateGuard && (stateGuard.awaitingConfirmation || stateGuard.reconnectInFlight)) {
        accountLog(acc.name, `descarregamento (${reason}) ignorado — já tem uma reconexão em andamento sendo confirmada`);
        return;
    }

    const state = getHibernateState(id);
    // v0.31.40: pedido do usuário — em vez de derivar a variação do tempo
    // configurado por conta (v0.31.39), agora sorteia direto num intervalo
    // FIXO de 10 a 14 minutos, sempre, não importa o que está configurado
    // no campo de minutos da conta. O valor sorteado só aparece no log
    // (a tela de espera continua mostrando só o contador regressivo, a
    // pedido do usuário).
    const MIN_MINUTES_FIXED = 10;
    const MAX_MINUTES_FIXED = 14;
    const drawnMinutes = MIN_MINUTES_FIXED + Math.random() * (MAX_MINUTES_FIXED - MIN_MINUTES_FIXED);
    const minutesMs = drawnMinutes * 60 * 1000;
    const targetTs = Date.now() + minutesMs;
    const drawnMinutesRounded = Math.round(drawnMinutes * 10) / 10; // 1 casa decimal, só pro log
    state.hibernateTargetTs = targetTs; // v15.55: guardado à parte pra cortina conseguir ler sem depender da URL da conta
    const parkingUrl = `file://${path.join(__dirname, 'inject', 'hibernate-parking.html')}?target=${targetTs}`;
    loadUrlReliably(id, view, parkingUrl);
    state.unloaded = true;
    accountLog(acc.name, `descarregada (Modo Hibernar, motivo: ${reason}) — reconecta em ${drawnMinutesRounded}min (sorteado fixo entre ${MIN_MINUTES_FIXED} e ${MAX_MINUTES_FIXED}min, pra espalhar as contas)`);

    // v15.60: se essa conta é a que está sendo vista agora (caso da
    // inatividade, que hiberna mesmo a aba ativa), ergue a cortina JÁ,
    // no exato instante que descarrega de verdade — assim nunca chega a
    // aparecer a troca pra tela de espera acontecendo na sua frente.
    if (id === activeAccountId) {
        showCurtainOverAccount(id);
    }

    // v15.10: trocado de "state.cycleTimer = setTimeout(...)" direto pra
    // clearTimer antes — se por algum motivo já existisse um cycleTimer
    // pendente aqui (ex: um ciclo antigo que não foi cancelado direito em
    // outro ponto), a atribuição direta SUBSTITUÍA a referência sem nunca
    // cancelar o timer antigo de verdade — ele continuava rodando
    // escondido e disparava sozinho depois, fora de hora, brigando com o
    // ciclo novo (foi exatamente esse o bug caçado: log mostrando
    // "descarregada" só 13s depois de "reconectando", quando deveria ser
    // só depois de confirmar sucesso e esperar HIBERNATE_RECONNECT_WINDOW_MS).
    clearTimer(state, 'cycleTimer');
    state.cycleTimer = setTimeout(() => reconnectForHibernate(id), minutesMs);
}

async function reconnectForHibernate(id) {
    const acc = accounts.find(a => a.id === id);
    const view = views.get(id);
    const state = getHibernateState(id);
    clearTimer(state, 'cycleTimer'); // ver comentário em unloadForHibernate — nunca só "= null"
    if (!acc || !acc.hibernateCycleEnabled || !view || view.webContents.isDestroyed()) {
        // v15.77: rede de segurança — se essa desistência acontece bem no
        // meio de uma tentativa que já tinha desligado o throttling (ex:
        // Modo Hibernar foi desligado enquanto essa retry ia acontecer, ou
        // a conta foi removida), sem isso a conta ficaria com o
        // throttling desligado pra sempre por engano, já que nenhuma
        // confirmação nunca vai chegar pra religar.
        if (state.awaitingConfirmation && view && !view.webContents.isDestroyed()) {
            view.webContents.setBackgroundThrottling(true);
        }
        state.awaitingConfirmation = false;
        return;
    }
    if (state.reconnectInFlight) return; // já tem uma tentativa rodando pra essa conta, não sobrepõe

    state.confirmAttempts = (state.confirmAttempts || 0) + 1;
    accountLog(acc.name, `reconectando (Modo Hibernar) — tentativa ${state.confirmAttempts}`);

    // v0.20.11: bug de corrida corrigido — antes isso só era marcado
    // DEPOIS do passo de resetar o proxy inteiro (about:blank + espera +
    // recolocar). Se desse erro NESSE meio-tempo (foi exatamente o que
    // apareceu no log — about:blank interrompendo o carregamento real no
    // meio), esse erro não passava pela coordenação com o Modo Hibernar e
    // caía no sistema genérico antigo, que tentava de novo por conta
    // própria — as duas tentativas se atropelando ao mesmo tempo. Agora
    // isso é marcado ANTES de qualquer passo assíncrono, cobrindo a
    // sequência inteira.
    state.reconnectInFlight = true;
    state.awaitingConfirmation = true;
    // v15.77: pedido do usuário — liga velocidade total de timers SÓ
    // durante essa janela de reconexão/confirmação (a tela de
    // carregamento/login é leve, sem o jogo rodando de verdade ainda),
    // em vez de deixar ligado o tempo todo pra conta inteira (isso
    // "acordava" a renderização pesada do jogo também, indo contra o
    // propósito de gastar menos RAM/CPU). Desliga de novo assim que
    // confirma de volta ao jogo (ver os dois handlers de confirmação).
    view.webContents.setBackgroundThrottling(false);

    // v0.20.9: era só um reapply simples (chamar de novo com o mesmo
    // proxy) — trocado pelo reset completo que já provamos que funciona
    // (o mesmo do botão ⟳ da aba): solta o proxy de vez, navega pra uma
    // página vazia (força o Chromium descartar qualquer túnel morto),
    // espera assentar, e só depois recoloca o proxy e carrega a URL real.
    const cycleProxy = getAccountProxy(acc);
    if (cycleProxy) {
        try {
            await view.webContents.session.setProxy({ proxyRules: '' });
            await view.webContents.loadURL('about:blank').catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
            await applyProxyToAccount(view, cycleProxy);
        } catch (e) {
            accountLog(acc.name, `falha ao reiniciar proxy no ciclo do Modo Hibernar: ${e.message}`);
        }
    }
    state.reconnectInFlight = false;
    if (view.webContents.isDestroyed()) return; // pode ter sido removida durante a espera do reset de proxy
    loadUrlReliably(id, view, acc.url || DEFAULT_URL);
    state.unloaded = false;

    // v0.20.3: antes disso, o ciclo assumia que reconectou com sucesso na
    // hora e já ia direto pra "fica carregada, depois descarrega de novo"
    // — se o carregamento falhasse silenciosamente (proxy, rede), a conta
    // ficava desconectada e o app nunca percebia. Agora espera uma
    // confirmação de verdade do script (que só chega quando ele detecta
    // elemento do jogo de verdade na tela, não login/personagem) antes de
    // continuar o ciclo. Se não confirmar em 45s, tenta de novo (até 5x).
    // v0.20.6: era 70s (com o script conferindo por até 60s) — reduzido
    // pra 45s (script confere por até 40s) porque na prática a maioria
    // confirma dentro de uns 40s, e esperar 70s pra desistir/retry
    // demorava demais.
    // v0.20.8: tirado o limite de tentativas — como o usuário confirmou
    // que o proxy nunca fica fora mais de uns 5 minutos, desistir depois
    // de um tempo curto só criava trabalho manual à toa. Agora tenta pra
    // sempre (só na hora do reconnect, não fica "carregada" o tempo todo
    // esperando — isso preservaria a economia de RAM). Loga a cada 10
    // tentativas pra não spammar o arquivo, mas continuar dando visibilidade.
    // (awaitingConfirmation já foi marcado no início da função)
    clearTimer(state, 'confirmTimeoutTimer'); // mesma cautela — nunca sobrescrever um timer pendente sem cancelar
    state.confirmTimeoutTimer = setTimeout(() => {
        if (!state.awaitingConfirmation) return; // já confirmou nesse meio-tempo
        state.awaitingConfirmation = false;
        if (state.confirmAttempts % 10 === 0) {
            accountLog(acc.name, `ainda não confirmou voltar ao jogo depois de ${state.confirmAttempts} tentativas (Modo Hibernar) — continuando a tentar.`);
        }
        reconnectForHibernate(id); // tenta de novo, sem desistir
    }, 45000);
}

// Chamado pelo script injetado quando confirma (ou não) ter voltado ao
// jogo de verdade depois de um reload do Modo Hibernar.
ipcMain.on('account:hibernate-confirmed-in-game', (event, success) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id, view] = found; // v0.31.22: BUG DE VERDADE — faltava capturar "view" aqui, e a linha
    // de baixo (restaura o throttling normal após confirmar) usava a variável sem
    // ela existir nesse escopo. Estourava "ReferenceError: view is not defined" toda vez que
    // uma conta confirmava volta ao jogo com sucesso (por isso só aparecia "com um tempinho de uso").
    const acc = accounts.find(a => a.id === id);
    const state = hibernateCycleState.get(id);
    if (!acc || !state || !state.awaitingConfirmation) return; // não tava esperando confirmação nenhuma — ignora

    state.awaitingConfirmation = false;
    if (state.confirmTimeoutTimer) { clearTimeout(state.confirmTimeoutTimer); state.confirmTimeoutTimer = null; }

    if (!success) {
        if (state.confirmAttempts % 10 === 0) {
            accountLog(acc.name, `ainda não conseguiu confirmar depois de ${state.confirmAttempts} tentativas (Modo Hibernar) — continuando a tentar.`);
        }
        reconnectForHibernate(id); // tenta de novo, sem desistir
        return;
    }

    state.confirmAttempts = 0;
    accountLog(acc.name, `confirmado de volta ao jogo (Modo Hibernar) — vendendo loot e ficando carregada mais um pouco`);
    // v15.77: confirmado de verdade — volta o throttling normal de
    // segundo plano (a partir daqui é gameplay pesado de novo, não mais
    // tela de carregamento/login).
    if (!view.webContents.isDestroyed()) view.webContents.setBackgroundThrottling(true);
    // v15.62: BUG DE VERDADE (pontos 4/5 relatados) — a cortina só descia
    // ao trocar de aba, nunca quando confirmava que reconectou de
    // verdade e voltou a caçar normal. Ficava presa por cima da tela
    // mesmo depois do processo "secreto" já ter terminado. Agora desce
    // assim que confirma — se estiver preso na cidade, o alarme (que
    // roda ~4s depois) aparece na tela normal, sem cortina escondendo.
    if (curtainCoveringAccountId === id) hideCurtain();

    // agora sim, confirmado de verdade: fica carregada um tempinho (o
    // Auto-Despachar Loot já vende sozinho ao carregar) — depois
    // descarrega de novo, a não ser que você tenha entrado nela.
    clearTimer(state, 'cycleTimer'); // mesma cautela de sempre — nunca sobrescrever sem cancelar
    state.cycleTimer = setTimeout(() => {
        state.cycleTimer = null;
        if (activeAccountId === id) return;
        unloadForHibernate(id, 'ciclo automático pós-confirmação');
    }, HIBERNATE_RECONNECT_WINDOW_MS);
});

// v0.20.1: clicar na aba NÃO reconecta mais sozinho — só mostra o que já
// está carregado ali (a página de espera, com a contagem, ou o jogo de
// verdade). Só arrastando a barra na página de espera é que reconecta
// de propósito — isso garante um reload de verdade (sem estado velho
// "meio travado" de antes de descarregar).
ipcMain.on('account:hibernate-wake-now', (event) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id, view] = found;
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    // v15.13: log adicionado — antes isso não deixava nenhum rastro no
    // log, então um "descarregada" que vinha logo depois disso (quando o
    // usuário saía da aba de novo) parecia ter surgido do nada, sem
    // nenhum "reconectando" antes (porque esse caminho não passa pelo
    // ciclo automático de reconexão).
    accountLog(acc.name, `acordada manualmente (arrastou a barra na página de espera)`);
    // v0.20.2: bug corrigido — antes isso reagendava um descarregamento em
    // só 25s, mesmo que você tivesse acabado de arrastar a barra pra ver
    // a conta de propósito (voltava pra tela de espera sozinha quase na
    // hora, parecendo que "não saía"). Agora só cancela os timers — o
    // próximo descarregamento só é agendado quando você realmente trocar
    // de aba (sair de vista), do jeito normal.
    clearHibernateTimers(id);
    const state = getHibernateState(id);
    view.webContents.loadURL(acc.url || DEFAULT_URL).catch(() => {});
    state.unloaded = false;
});

// v0.20.2: desativar direto pela página de espera — precisa avisar o
// script real (quando ele carregar de novo) que a opção foi desligada
// por fora, senão ele leria o próprio localStorage (que ainda diz "1") e
// mandaria main.js religar sozinho. Marca isso via #hash na URL — o
// script confere isso uma vez no carregamento e sincroniza o localStorage
// dele com o que foi decidido aqui.
ipcMain.on('account:hibernate-disable-cycle', (event) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id, view] = found;
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    acc.hibernateCycleEnabled = false;
    saveData();
    accountLog(acc.name, `Modo Hibernar desligado pela página de espera`);
    clearHibernateTimers(id);
    const state = getHibernateState(id);
    state.unloaded = false;
    if (curtainCoveringAccountId === id) hideCurtain(); // defensivo — na prática não deveria estar coberta se esse clique chegou aqui
    const url = (acc.url || DEFAULT_URL) + '#wolhub-disable-hibernate';
    view.webContents.loadURL(url).catch(() => {});
});

// v15.40: retrato da última sessão — guardado no processo principal (não
// só no localStorage do jogo) porque a tela de espera do Modo Hibernar é
// outra origem (file://), sem acesso a esse localStorage. Fica no mesmo
// state em memória de sempre (reseta só quando o app fecha de vez).
ipcMain.on('account:report-session-snapshot', (event, snapshot) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id] = found;
    const state = getHibernateState(id);
    state.sessionSnapshot = snapshot;
});

ipcMain.handle('account:get-session-snapshot', (event) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return null;
    const [id] = found;
    // v15.67: passou a devolver o objeto completo (igual a cortina já
    // recebe), pra página de espera também mostrar o "tempo de sessão"
    // quando é a própria conta acessando sua página (fora da cortina).
    return getCurtainDataForAccount(id);
});

// v15.17: separado do handler acima de propósito — esse aqui é chamado
// de DENTRO do jogo já carregado (quando "Alarmar fora da hunt" detecta
// que reconectou na cidade), então NUNCA pode recarregar a página — isso
// mataria o alarme que acabou de começar a tocar antes de alguém ouvir.
// Só para o ciclo automático mesmo, sem tocar na view.
ipcMain.on('account:hibernate-pause-for-alarm', (event) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id] = found;
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    acc.hibernateCycleEnabled = false;
    saveData();
    accountLog(acc.name, `Modo Hibernar pausado automaticamente — "Alarmar fora da hunt" detectou que a conta está na cidade, não caçando`);
    clearHibernateTimers(id);
    // v15.59: BUG DE VERDADE — isso desligava o Modo Hibernar mas nunca
    // tirava a cortina, que continuava tampando a tela. O alarme
    // disparava de verdade por trás (som incluído), só que a caixinha
    // "Entendido" e o painel Keys atualizado ficavam escondidos atrás
    // dela — parecia que nada tinha acontecido.
    if (curtainCoveringAccountId === id) hideCurtain();
});

// v15.18: Modo Hibernar trocou de "tempo em segundo plano" pra "tempo sem
// ação humana na página" (clique, mouse, tecla — nunca ações do próprio
// bot). Quem decide os 20s é o script injetado (ele que escuta os
// eventos); aqui só executa o descarregamento de verdade quando avisado —
// inclusive se a conta for a que está sendo vista no momento (forceEvenIfActive).
ipcMain.on('account:hibernate-inactivity-trigger', (event) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id] = found;
    unloadForHibernate(id, 'sem clique/mouse/tecla por 20s', true);
});

// v15.44: removido de vez o filtro de "1ª confirmação da sessão fica
// muda" — chegou a dar um bug real (v15.34) e o usuário suspeitava que
// ainda estava causando confusão. Só a estabilidade de 4s decide agora.

// v15.28: notificação nativa do Windows (não é a página, é o SISTEMA) —
// aparece mesmo se o usuário estiver com outro jogo/app em foco, sem o
// WoL Hub visível na tela. Botão "Entendido" via `actions` (só funciona
// de verdade no macOS pela API simples do Electron — no Windows não tem
// garantia), então clicar em QUALQUER parte da notificação também conta,
// como reforço que funciona nos dois sistemas.
ipcMain.on('account:notify-went-to-city', (event) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id, view] = found;
    const acc = accounts.find(a => a.id === id);
    if (!acc || !Notification.isSupported()) return;
    const notif = new Notification({
        title: 'WoL Hub — foi pra cidade',
        body: `${acc.name} saiu da hunt e está na cidade.`,
        actions: [{ type: 'button', text: 'Entendido' }],
    });
    const acknowledge = () => {
        if (!view.webContents.isDestroyed()) view.webContents.send('wolhub:alarm-acknowledged');
    };
    notif.on('click', acknowledge);
    notif.on('action', acknowledge);
    notif.show();
});

// v0.31.31/33: a teoria original (11 testes isolados) era que o
// Cloudflare só passava numa janela de topo de verdade, nunca numa aba
// dentro do app (WebContentsView filha) — por isso existia uma JANELA
// AVULSA separada só pra resolver o desafio na mão. v0.31.44: essa teoria
// era um efeito colateral do MESMO bug de UA/Client-Hints que causava o
// bloqueio em si (removido na v0.31.33) — sem esse disfarce, a própria
// aba da conta dentro do app já passa no Cloudflare normalmente,
// confirmado na prática pelo usuário. A janela avulsa foi removida: agora
// o alarme só avisa e leva você até a aba certa, sem abrir nada extra.

// v0.31.34: BUG DE VERDADE — a detecção de Cloudflare inteira vivia
// dentro do script injetado (huntera-economy.js), rodando num
// setInterval NA PRÓPRIA PÁGINA da conta. Só que a maioria das vezes que
// isso importa é justamente quando a conta está em SEGUNDO PLANO (Modo
// Hibernar reconectando sozinho) — nesse estado a view fica DESANEXADA da
// janela (removeChildView, ver loadUrlReliably/linha ~397), e o Chromium
// throttla (ou quase congela) os timers de uma página sem nenhuma janela
// de verdade segurando ela. Resultado: o alarme podia demorar minutos ou
// nunca disparar de verdade, mesmo com o Cloudflare bloqueando o
// reconnect por trás. Agora a checagem principal roda AQUI, do lado do
// processo principal — nunca sofre esse throttling (é só um setInterval
// do Node.js chamando executeJavaScript, que sempre executa na hora,
// esteja a view anexada ou não). O script injetado continua com a sua
// própria checagem (bom pra reação rápida na aba que você está olhando),
// mas essa aqui é a que garante que NENHUMA conta passa despercebida.
const cloudflareChallengeState = new Map(); // accountId -> true enquanto o desafio está ativo (evita abrir janela/notificação duplicada)
const CLOUDFLARE_CHECK_JS = `(() => {
    try {
        // v0.31.41: BUG DE VERDADE — os seletores abaixo (principalmente
        // ".world-challenge") checavam só se o elemento EXISTE no HTML,
        // não se ele está visível de verdade na tela. O Huntera deixa essa
        // div sempre presente no DOM (só escondida via CSS) e só REVELA
        // ela quando o desafio acontece de verdade — então toda conta
        // "detectava" Cloudflare assim que a página carregava, mesmo sem
        // nenhum desafio real, disparando o alarme/janela solucionadora
        // pra todas as 28 contas de uma vez só. Agora exige que o elemento
        // esteja realmente visível (display/visibility/tamanho na tela),
        // não só existindo escondido em algum canto do HTML.
        function isVisible(el) {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }
        if (isVisible(document.querySelector('iframe[src*="challenges.cloudflare.com"]'))) return true;
        if (isVisible(document.querySelector('[class*="cf-turnstile"], #cf-turnstile, #cf-wrapper, #challenge-stage, #challenge-running'))) return true;
        // v0.31.37: o Huntera embrulha o widget do Turnstile numa div
        // própria com essa classe fixa (".world-challenge") sempre que
        // entrar no mundo precisa de verificação humana — muito mais
        // confiável que tentar prever os ids aleatórios que o próprio
        // widget do Cloudflare usa por dentro (mudam a cada sessão).
        // Pega o desafio assim que ele APARECE, não só quando já falhou.
        if (isVisible(document.querySelector('.world-challenge'))) return true;
        const title = document.title || '';
        if (/just a moment/i.test(title) || /um momento/i.test(title)) return true;
        const bodyText = document.body ? document.body.innerText : '';
        if (/Falha na verifica[cç][aã]o/i.test(bodyText)) return true;
        if (/verificando se voc[eê] [eé] humano/i.test(bodyText)) return true;
        if (/confirme que (é|voc[eê] [eé]) humano/i.test(bodyText)) return true;
        return false;
    } catch (e) { return false; }
})()`;
const CLOUDFLARE_POLL_INTERVAL_MS = 4000;

// v0.31.43: pedido do usuário — a detecção de "reconexão recusada"
// (v0.31.36) foi removida de vez. Motivo: quando o SERVIDOR DO JOGO cai
// (queda geral, não bloqueio de proxy), TODAS as contas mostram esse
// mesmo erro ao mesmo tempo — e isso disparava o pause do Modo Hibernar +
// notificação pras 28 contas de uma vez, um flood tão ruim quanto (ou
// pior) que o problema que tentava resolver. Como não dá pra distinguir
// com segurança "servidor caiu geral" de "meu proxy foi bloqueado" só
// pelo texto do erro, a decisão foi deixar só o alarme do Cloudflare (que
// é sempre um problema de verdade e específico daquela conta) e tirar
// esse daqui — o auto-reconectar volta a tratar esse erro como qualquer
// outro, tentando de novo sozinho.

function handleCloudflareDetected(id) {
    if (cloudflareChallengeState.get(id)) return; // já tratado (evita janela/notificação duplicada vinda dos dois caminhos)
    cloudflareChallengeState.set(id, true);
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    if (acc.hibernateCycleEnabled) {
        acc.hibernateCycleEnabled = false;
        saveData();
        accountLog(acc.name, `Modo Hibernar pausado automaticamente — Cloudflare pediu verificação manual, só resolve na mão`);
        clearHibernateTimers(id);
        if (curtainCoveringAccountId === id) hideCurtain();
    } else {
        accountLog(acc.name, `Cloudflare pediu verificação manual — avisando o usuário`);
    }

    const view = views.get(id);
    if (view && !view.webContents.isDestroyed() && Notification.isSupported()) {
        const notif = new Notification({
            title: 'WoL Hub — Cloudflare pedindo verificação',
            body: `${acc.name} está travada num desafio do Cloudflare. Vem resolver na mão.`,
            actions: [{ type: 'button', text: 'Entendido' }],
        });
        // v0.31.44: em vez de abrir uma janela avulsa, só leva você direto
        // pra aba da conta (troca a aba ativa + traz o app pra frente) —
        // a própria aba já resolve o Cloudflare normalmente agora.
        const acknowledge = () => {
            if (!view.webContents.isDestroyed()) view.webContents.send('wolhub:cloudflare-alarm-acknowledged');
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
            switchToAccount(id);
        };
        notif.on('click', acknowledge);
        notif.on('action', acknowledge);
        notif.show();
    }
}

function handleCloudflareCleared(id) {
    cloudflareChallengeState.delete(id);
}

function pollAllAccountsForCloudflare() {
    for (const [id, view] of views.entries()) {
        if (!view || view.webContents.isDestroyed()) continue;
        let currentUrl;
        try {
            currentUrl = view.webContents.getURL();
        } catch (e) {
            continue;
        }
        if (!isGameUrl(currentUrl)) continue; // não é página do jogo (parking, desativada, about:blank) — pula
        view.webContents.executeJavaScript(CLOUDFLARE_CHECK_JS, true)
            .then((showing) => {
                if (showing) handleCloudflareDetected(id);
                else handleCloudflareCleared(id);
            })
            .catch(() => {}); // view pode ter navegado/sido destruída no meio do caminho — ignora, tenta de novo no próximo tick
    }
}
setInterval(pollAllAccountsForCloudflare, CLOUDFLARE_POLL_INTERVAL_MS);

// O script injetado (huntera-economy.js) ainda avisa por aqui também,
// pra reação mais rápida na aba ativa — só chama a mesma função central
// acima, que já se protege contra disparo duplicado.
ipcMain.on('account:hibernate-pause-for-cloudflare', (event) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id] = found;
    handleCloudflareDetected(id);
});

ipcMain.on('account:notify-cloudflare', (event) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id] = found;
    handleCloudflareDetected(id);
});

// v15.64: caminho direto e simples pra tirar a cortina — não depende do
// estado interno de confirmação do processo principal (awaitingConfirmation),
// que em algum canto pode estar desincronizando silenciosamente. O script
// injetado avisa aqui assim que confirma de verdade que voltou ao jogo.
ipcMain.on('account:hibernate-confirmed-for-curtain', (event) => {
    const found = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!found) return;
    const [id] = found;
    // v15.77: mesma restauração de throttling do outro caminho — esse
    // aqui dispara independente do awaitingConfirmation, então cobre
    // também o caso desse ser o único sinal a chegar.
    const [, viewForThrottle] = found;
    if (!viewForThrottle.webContents.isDestroyed()) viewForThrottle.webContents.setBackgroundThrottling(true);
    if (curtainCoveringAccountId === id) hideCurtain();
});

// Chamado quando a conta VIRA a aba ativa — só cancela os timers
// pendentes (pra não descarregar embaixo do seu nariz), mas NÃO força
// reconectar sozinho — isso só acontece pela barra na página de espera.
// v0.20.4: bug corrigido — antes isso cancelava TODOS os timers da conta,
// inclusive o que ia disparar o reconnect automático agendado. Se você só
// clicasse na aba pra espiar a contagem regressiva da página de espera,
// isso cancelava o reconnect sem reagendar nada, deixando ela presa em
// 00:00:00 pra sempre. Agora só cancela o timer de "vai descarregar"
// (isso sim não devia acontecer com você olhando) — o reconnect agendado
// continua valendo normal, mesmo que você esteja espiando.
function wakeFromHibernateCycle(id) {
    const state = hibernateCycleState.get(id);
    if (state && state.graceTimer) {
        clearTimeout(state.graceTimer);
        state.graceTimer = null;
    }
}

ipcMain.on('account:set-hibernate-cycle', (event, { enabled, minutes, graceSeconds }) => {
    const view = [...views.entries()].find(([, v]) => !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (!view) return;
    const id = view[0];
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;

    const newEnabled = !!enabled;
    const newMinutes = Math.max(1, parseInt(minutes, 10) || 10);
    let grace = parseInt(graceSeconds, 10);
    if (isNaN(grace)) grace = (acc.hibernateGraceSeconds != null ? acc.hibernateGraceSeconds : 15);
    const newGraceSeconds = Math.max(0, Math.min(120, grace));

    // v15.14: bug de verdade corrigido — o script injetado manda essa
    // mensagem toda vez que a PÁGINA CARREGA (pra manter os dois lados
    // sincronizados), não só quando o usuário muda a configuração de
    // propósito. Isso incluía os recarregamentos feitos pelo próprio
    // ciclo de reconexão do Modo Hibernar — toda tentativa de reconectar,
    // ao carregar a página de novo, mandava esse aviso "tô ligado" de
    // volta, e o código tratava isso como uma mudança manual: cancelava
    // tudo que já estava em andamento (inclusive a própria reconexão que
    // causou esse carregamento) e agendava um descarregamento novo — a
    // reconexão nunca chegava a confirmar (esse era o "descarregada logo
    // depois de reconectando, sem nunca confirmar" que a gente vinha
    // caçando). Agora só mexe nos temporizadores quando algo realmente
    // MUDOU, e nunca interrompe uma reconexão que já está em andamento.
    const state = getHibernateState(id);
    const nothingChanged = acc.hibernateCycleEnabled === newEnabled
        && acc.hibernateCycleMinutes === newMinutes
        && acc.hibernateGraceSeconds === newGraceSeconds;
    const reconnectInProgress = state.awaitingConfirmation || state.reconnectInFlight;

    acc.hibernateCycleEnabled = newEnabled;
    acc.hibernateCycleMinutes = newMinutes;
    acc.hibernateGraceSeconds = newGraceSeconds;
    saveData();

    // v15.56: BUG DE VERDADE — mostrar a cortina IMEDIATAMENTE ao marcar
    // Modo Hibernar tampava a tela na hora, inclusive o painel Keys que
    // a pessoa ainda podia estar usando pra marcar "Avisar fora da hunt"
    // logo em seguida — dava pra nem conseguir configurar direito.
    // Agora só ESCONDE na hora (seguro, sempre bom revelar rápido) se
    // desligar; pra MOSTRAR, espera a próxima troca de aba de verdade
    // (switchToAccount), dando tempo de continuar configurando o painel
    // sem a cortina atrapalhar no meio.
    if (id === activeAccountId && !acc.hibernateCycleEnabled) {
        hideCurtain();
    }

    if (nothingChanged || reconnectInProgress) return; // só um "check-in" do carregamento da página, ou já tem reconexão rolando — não mexe em nada

    // mudou o delay / ligou de novo de propósito — limpa timers (a
    // inatividade humana quem decide o resto agora, ver v15.18)
    clearHibernateTimers(id);
    if (!acc.hibernateCycleEnabled) {
        wakeFromHibernateCycle(id);
    }
});

// v15.29: Ctrl+clique — por conta e por jogo inteiro (todas as contas
// daquele site de uma vez, direto do card na tela inicial).
ipcMain.handle('accounts:toggle-manual-disable', (event, id) => {
    const acc = accounts.find(a => a.id === id);
    if (acc) setAccountManualDisabled(id, !acc.manuallyDisabled);
    return { sites, accounts, activeAccountId };
});

ipcMain.handle('sites:toggle-manual-disable', (event, siteId) => {
    const siteAccounts = accounts.filter(a => a.siteId === siteId);
    // se ALGUMA já estiver ligada, o clique desliga todas; só se TODAS já
    // estiverem desligadas é que o clique liga todas de novo — assim um
    // clique só nunca deixa "misturado" sem querer.
    const someEnabled = siteAccounts.some(a => !a.manuallyDisabled);
    siteAccounts.forEach(a => setAccountManualDisabled(a.id, someEnabled));
    return { sites, accounts, activeAccountId };
});

ipcMain.handle('accounts:reload', async (event, id) => {
    clearAccountRecovery(id); // reload manual — cancela qualquer retry automático pendente pra não colidir
    const acc = accounts.find(a => a.id === id);
    const view = views.get(id);
    if (!view || view.webContents.isDestroyed()) return;

    const manualReloadProxy = acc ? getAccountProxy(acc) : '';
    if (manualReloadProxy) {
        try {
            await view.webContents.session.setProxy({ proxyRules: '' }); // solta o proxy — sai pelo IP normal
            view.webContents.reload();
            await new Promise(r => setTimeout(r, 2000)); // dá um tempo pra essa troca assentar
            await applyProxyToAccount(view, manualReloadProxy); // reaplica o mesmo proxy de sempre
            view.webContents.reload();
        } catch (e) {
            managerLog(`Falha ao reconectar proxy da conta "${acc.name}": ${e.message}`);
            view.webContents.reload(); // pelo menos tenta um reload normal se o proxy der problema
        }
    } else {
        view.webContents.reload();
    }
});


app.on('login', (event, webContents, details, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    const creds = proxyCredentials.get(webContents.id);
    if (creds) {
        event.preventDefault();
        callback(creds.username, creds.password);
    }
});

// DevTools destacado (janela própria) pra conta ativa, via F12.
app.on('web-contents-created', (event, contents) => {
    contents.on('before-input-event', (e, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            if (contents.isDevToolsOpened()) {
                contents.closeDevTools();
            } else {
                contents.openDevTools({ mode: 'undocked' });
            }
        }
    });
});

// ========== IPC ==========
ipcMain.handle('data:get', () => ({ sites, accounts, activeAccountId }));

ipcMain.handle('sites:add', (event, { name, icon, iconColor }) => {
    const id = Date.now().toString(36);
    sites.push({ id, name: name || `Jogo ${sites.length + 1}`, icon: icon || '', iconColor: iconColor || 'blue' });
    saveData();
    return sites;
});

ipcMain.handle('sites:remove', (event, id) => {
    // Remove o jogo e todas as contas dele junto.
    const accountIdsToRemove = accounts.filter(a => a.siteId === id).map(a => a.id);
    accountIdsToRemove.forEach(removeAccountView);
    accounts = accounts.filter(a => a.siteId !== id);
    sites = sites.filter(s => s.id !== id);
    saveData();
    if (accountIdsToRemove.includes(activeAccountId) && accounts.length > 0) {
        switchToAccount(accounts[0].id);
    }
    return { sites, accounts, activeAccountId };
});

ipcMain.handle('accounts:add', (event, { siteId, name, url, proxy }) => {
    const id = Date.now().toString(36);
    const account = {
        id,
        siteId,
        name: name || `Conta ${accounts.length + 1}`,
        url: url || DEFAULT_URL,
        proxy: proxy || '',
        icon: '',      // vazio = herda o ícone do jogo
        iconColor: '', // vazio = herda a cor do jogo
        hibernateCycleEnabled: false,
        hibernateCycleMinutes: 10,
        hibernateGraceSeconds: 15,
        manuallyDisabled: false, // Ctrl+clique na aba/card — desliga sem depender do Modo Hibernar
    };
    accounts.push(account);
    saveData();
    createAccountView(account);
    switchToAccount(id);
    return { sites, accounts, activeAccountId };
});

ipcMain.handle('accounts:remove', (event, id) => {
    const wasActive = activeAccountId === id;
    accounts = accounts.filter(a => a.id !== id);
    saveData();
    removeAccountView(id);
    if (wasActive && accounts.length > 0) {
        switchToAccount(accounts[0].id);
    }
    return { sites, accounts, activeAccountId };
});

ipcMain.handle('accounts:switch', (event, id) => {
    switchToAccount(id);
    return activeAccountId;
});

ipcMain.handle('accounts:rename', (event, { id, name }) => {
    const acc = accounts.find(a => a.id === id);
    if (acc && name.trim()) acc.name = name.trim();
    saveData();
    return { sites, accounts, activeAccountId };
});

// Edita nome, ícone/cor E URL de uma conta. Se a URL mudou, recarrega a
// view dela direto pra nova URL (com o script reinjetado no próximo
// dom-ready). Ícone/cor vazios = herda do jogo (ver getAccountIconInfo).
ipcMain.handle('accounts:update', async (event, { id, name, url, proxy, icon, iconColor }) => {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return { sites, accounts, activeAccountId };

    if (name && name.trim()) acc.name = name.trim();
    if (icon !== undefined) acc.icon = icon;
    if (iconColor !== undefined) acc.iconColor = iconColor;

    const view = views.get(id);
    clearAccountRecovery(id); // qualquer edição manual cancela retry automático pendente

    const proxyChanged = proxy !== undefined && proxy !== acc.proxy;
    if (proxyChanged) acc.proxy = proxy;

    if (proxyChanged) {
        const effectiveProxy = getAccountProxy(acc);
        if (view) {
            if (effectiveProxy) {
                await applyProxyToAccount(view, effectiveProxy);
            } else {
                await view.webContents.session.setProxy({ proxyRules: '' }); // remove o proxy
            }
        }
    }

    if (url && url.trim() && url.trim() !== acc.url) {
        acc.url = url.trim();
        if (view) view.webContents.loadURL(acc.url);
    } else if (proxyChanged && view) {
        view.webContents.reload(); // proxy só vale pra requisições novas — recarrega pra aplicar
    }

    saveData();
    return { sites, accounts, activeAccountId };
});

// Edita nome, cor e/ou ícone de um jogo. Jogos não têm URL própria — cada
// conta tem a sua (usada como padrão quando você adiciona uma conta nova
// nesse jogo, mas nada é lido de volta daqui).
// Edita nome e/ou ícone de um jogo. Jogos não têm URL própria — cada
// conta tem a sua (usada como padrão quando você adiciona uma conta nova
// nesse jogo, mas nada é lido de volta daqui).
ipcMain.handle('sites:update', (event, { id, name, icon, iconColor }) => {
    const site = sites.find(s => s.id === id);
    if (!site) return sites;
    if (name && name.trim()) site.name = name.trim();
    if (icon !== undefined) site.icon = icon;
    if (iconColor !== undefined) site.iconColor = iconColor;
    saveData();
    return sites;
});

ipcMain.handle('sites:rename', (event, { id, name }) => {
    const site = sites.find(s => s.id === id);
    if (site && name.trim()) site.name = name.trim();
    saveData();
    return { sites, accounts, activeAccountId };
});

// Reordena as contas de UM jogo específico — recebe a lista de ids na nova
// ordem (só os ids daquele site) e reposiciona elas dentro do array
// principal, mantendo a posição relativa das contas de outros jogos.
ipcMain.handle('accounts:reorder', (event, { siteId, orderedIds }) => {
    // v15.36: proteção extra — se a lista vier com algum id repetido (ex:
    // um clique bem no meio de um bug visual de arrastar), nunca deixa
    // isso virar uma conta duplicada de verdade na lista salva.
    const dedupedIds = [...new Set(orderedIds)];
    const others = accounts.filter(a => a.siteId !== siteId);
    const reordered = dedupedIds
        .map(id => accounts.find(a => a.id === id && a.siteId === siteId))
        .filter(Boolean);
    // Insere o grupo reordenado na posição onde a primeira conta daquele
    // site aparecia originalmente, preservando a posição dos outros grupos.
    const firstIndex = accounts.findIndex(a => a.siteId === siteId);
    const before = others.filter((_, i) => accounts.indexOf(others[i]) < firstIndex);
    const after = others.filter((_, i) => accounts.indexOf(others[i]) >= firstIndex);
    accounts = [...before, ...reordered, ...after];
    saveData();
    return { sites, accounts, activeAccountId };
});

ipcMain.handle('sites:reorder', (event, orderedSiteIds) => {
    const dedupedSiteIds = [...new Set(orderedSiteIds)]; // v15.36: mesma proteção contra id repetido
    sites = dedupedSiteIds.map(id => sites.find(s => s.id === id)).filter(Boolean);
    saveData();
    return sites;
});

ipcMain.handle('ui:toggle-fullscreen', () => {
    if (!mainWindow) return false;
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return next;
});

ipcMain.handle('ui:hide-active-view', (event, forget) => {
    if (activeAccountId && views.has(activeAccountId)) {
        mainWindow.contentView.removeChildView(views.get(activeAccountId));
    }
    // v15.57: BUG DE VERDADE — isso removia a conta de trás mas nunca a
    // cortina, que ficava flutuando sozinha por cima da tela inicial
    // (ou de qualquer outra coisa) depois de voltar/esconder. A cortina
    // precisa sumir junto sempre que a conta some.
    hideCurtain();
    // v0.15.0: ao voltar pra home de vez (não só esconder atrás de um
    // popover), esquece qual conta estava ativa — sem isso, um
    // showActiveView() posterior (ex: cancelar um popover) reexibia a
    // última conta vista por cima da tela inicial inteira, sem nenhum
    // botão do app visível (parecia "travado").
    if (forget) { activeAccountId = null; updateTaskbarIconForActiveAccount(); }
    // Corrige um bug do Electron onde o foco de teclado fica "preso" numa
    // view removida — sem isso, campos de texto do nosso HTML pareciam
    // clicáveis (cursor piscando) mas não recebiam digitação de verdade.
    mainWindow.webContents.focus();
});

ipcMain.handle('ui:show-active-view', () => {
    if (activeAccountId && views.has(activeAccountId)) {
        mainWindow.contentView.addChildView(views.get(activeAccountId));
        resizeActiveView();
        // v15.57: se essa conta tem Modo Hibernar ligado, a cortina
        // precisa voltar a cobri-la também — sem isso, cancelar um
        // popover (que passa por aqui) revelava a conta de verdade por
        // trás, sem a cortina, mesmo com o Modo Hibernar ligado.
        // v0.31.20: BUG DE VERDADE — isso só olhava hibernateCycleEnabled
        // (o checkbox marcado), igual o bug já corrigido em
        // switchToAccount (v15.60). Resultado: fechar QUALQUER popover
        // (ex: configurações da conta) enquanto Modo Hibernar está
        // marcado erguia a cortina por cima da conta mesmo ela estando
        // rodando normal, sem nunca ter descarregado de verdade — a
        // cortina "aparecia do nada" e, se clicasse em desativar ali,
        // recarregava a conta à toa só pra tirar uma cortina que nunca
        // devia ter subido. Agora usa a mesma regra das outras: só sobe
        // se realmente descarregou ou está no meio de confirmar reconexão.
        const acc = accounts.find(a => a.id === activeAccountId);
        const stateForCurtain = hibernateCycleState.get(activeAccountId);
        const stillMidReconnect = stateForCurtain && (stateForCurtain.awaitingConfirmation || stateForCurtain.reconnectInFlight);
        if (acc && acc.hibernateCycleEnabled && stateForCurtain && (stateForCurtain.unloaded || stillMidReconnect)) {
            showCurtainOverAccount(activeAccountId);
        }
    }
});

// Retorna RAM (MB) e ping (ms) de cada conta.
ipcMain.handle('accounts:stats', async () => {
    const metrics = app.getAppMetrics();
    const stats = {};
    for (const [id, view] of views.entries()) {
        if (view.webContents.isDestroyed()) continue;
        const pid = view.webContents.getOSProcessId();
        const m = metrics.find(mm => mm.pid === pid);
        stats[id] = {
            ramMB: m ? Math.round(m.memory.workingSetSize / 1024) : null,
            pingMs: pingByAccount.has(id) ? pingByAccount.get(id) : null,
        };
    }
    return stats;
});

// ========== EXPORTAR / IMPORTAR CONFIGURAÇÃO ==========
// Salva jogos + contas num arquivo .json que você escolhe onde guardar —
// útil pra levar a configuração pra outro PC ou como backup manual (não
// sobe pra nenhuma nuvem, fica só no arquivo que você escolher).
ipcMain.handle('data:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Exportar configuração',
        defaultPath: 'idle-huntera-manager-backup.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false };
    fs.writeFileSync(filePath, JSON.stringify({ sites, accounts: accounts.map(a => ({ ...a })) }, null, 2));
    return { ok: true, filePath };
});

// Importa um arquivo exportado antes. As contas importadas ganham views
// novas (sessão de login própria, começa deslogada — só os dados de
// nome/URL/agrupamento voltam, login sempre precisa ser feito de novo por
// segurança).
ipcMain.handle('data:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Importar configuração',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return { ok: false };

    let imported;
    try {
        imported = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
    } catch (e) {
        return { ok: false, error: 'Arquivo inválido' };
    }
    if (!imported.sites || !imported.accounts) return { ok: false, error: 'Arquivo inválido' };

    sites = imported.sites;
    accounts = imported.accounts;
    saveData();

    createAccountViewsStaggered(accounts);
    if (accounts.length > 0 && !activeAccountId) {
        switchToAccount(accounts[0].id);
    }

    return { ok: true, sites, accounts, activeAccountId };
});
