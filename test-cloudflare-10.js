// TESTE ISOLADO Nº10 — os testes 6, 7, 8 e 9 mostraram um padrão: SEMPRE
// que a página carrega enquanto está escondida/fora da tela/tapada — não
// importa como —, ela fica "manchada" e falha pra sempre, mesmo depois de
// aparecer certinho. Só passa quando nasce e carrega já 100% visível, sem
// interrupção nenhuma (testes 1-5).
//
// Isso aponta pra causa raiz de verdade: não é "conta em segundo plano" —
// é o PRÓPRIO TRUQUE que o app usa pra criar TODAS as views (inclusive a
// que está sendo vista no momento!) — elas sempre nascem fora da tela
// primeiro (coordenadas negativas) e só depois são movidas pra posição
// visível, pra evitar um "pulo" feio na troca de aba. Ou seja: pode ser
// que NENHUMA conta jamais tenha tido chance de passar no Cloudflare, nem
// a que está sendo vista ativamente.
//
// Esse teste tira esse truque: a WebContentsView nasce JÁ na posição
// visível certa (sem nascer fora da tela antes), e só então dá loadURL.
//
// Como rodar:
//   npx electron test-cloudflare-10.js
//
// O que isso prova:
//   - Se passar -> confirmado! O problema nunca foi "conta em segundo
//     plano" — foi o truque de nascer fora da tela. A correção é simples:
//     tirar esse truque (aceitar um pequeno "pulo" visual na troca de aba,
//     ou resolver de outro jeito que não mexa em posição antes do load) e
//     manter a arquitetura de WebContentsView como está.
//   - Se falhar -> mesmo carregando 100% visível desde o início como
//     child view (não como BrowserWindow de topo), ainda falha — aí o
//     problema é mesmo ser WebContentsView (não ser uma janela de
//     verdade do SO), e sobra a reescrita pra BrowserWindow por conta.

const path = require('path');
const { app, BrowserWindow, WebContentsView } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'TESTE 10 — WebContentsView, SEM nascer fora da tela',
        webPreferences: {},
    });
    mainWindow.loadURL('data:text/html,<body style="background:#111"></body>');

    const view = new WebContentsView({
        backgroundColor: '#0f0f14',
        webPreferences: {
            partition: 'persist:test-cloudflare-10',
            contextIsolation: true,
            sandbox: true,
            spellcheck: false,
            preload: path.join(__dirname, 'account-preload.js'),
        },
    });

    // Diferença chave: já nasce na posição visível certa, nunca fora da
    // tela antes disso.
    mainWindow.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });

    const cleanUA = view.webContents.getUserAgent()
        .replace(/\s*idle-huntera-manager\/\S+/i, '')
        .replace(/\s*Electron\/\S+/i, '');
    view.webContents.setUserAgent(cleanUA);

    view.webContents.openDevTools({ mode: 'right' });
    view.webContents.loadURL(TEST_URL);

    view.webContents.once('did-finish-load', () => {
        console.log('>>> Carregou já 100% visível, sem truque nenhum de fora da tela. Testa criar conta / ver se o Cloudflare passa.');
    });
});

app.on('window-all-closed', () => app.quit());
