// TESTE ISOLADO Nº6 — última variável que faltava: usar WebContentsView
// anexada ao contentView de uma BrowserWindow "mãe" (exatamente como o
// createAccountView() do main.js real faz), em vez de usar a própria
// BrowserWindow como conteúdo (que foi o que testamos nos testes 1-5,
// e sempre passou).
//
// Replica o mais fiel possível: mesmas webPreferences, mesmo truque de
// nascer fora da tela em tamanho real, mesmo jeito de anexar via
// mainWindow.contentView.addChildView(view).
//
// Como rodar:
//   npx electron test-cloudflare-6.js
//
// O que isso prova:
//   - Se falhar agora -> confirmado: é especificamente usar
//     WebContentsView como filha de outra janela (em vez de BrowserWindow
//     de topo) que quebra o Cloudflare. Provavelmente ligado a como o
//     Chromium trata foco/visibilidade real de OS pra views filhas
//     (não são uma janela de verdade pro sistema operacional).
//   - Se passar -> aí o mistério continua, e sobra investigar coisas
//     mais finas tipo timing exato do loadURL vs anexação, ou algo
//     em outra parte do main.js que só roda com múltiplas contas.

const path = require('path');
const { app, BrowserWindow, WebContentsView } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'TESTE 6 — WebContentsView filha (arquitetura real do app)',
        webPreferences: {},
    });
    // A janela mãe só existe pra segurar a view — carrega uma página em branco.
    mainWindow.loadURL('data:text/html,<body style="background:#111"></body>');

    const view = new WebContentsView({
        backgroundColor: '#0f0f14',
        webPreferences: {
            partition: 'persist:test-cloudflare-6',
            contextIsolation: true,
            sandbox: true,
            spellcheck: false,
            preload: path.join(__dirname, 'account-preload.js'),
        },
    });

    // Nasce fora da tela em tamanho real, igual o app faz.
    view.setBounds({ x: -10000 - 1200, y: -10000, width: 1200, height: 800 });
    mainWindow.contentView.addChildView(view);

    const cleanUA = view.webContents.getUserAgent()
        .replace(/\s*idle-huntera-manager\/\S+/i, '')
        .replace(/\s*Electron\/\S+/i, '');
    view.webContents.setUserAgent(cleanUA);

    view.webContents.openDevTools({ mode: 'right' });
    view.webContents.loadURL(TEST_URL);

    view.webContents.once('did-finish-load', () => {
        console.log('>>> Carregou fora da tela. Trazendo pra posição visível agora...');
        view.setBounds({ x: 100, y: 100, width: 1200, height: 800 });
        console.log('>>> Testa criar conta / ver se o Cloudflare passa.');
    });
});

app.on('window-all-closed', () => app.quit());
