// TESTE ISOLADO — reproduz EXATAMENTE a janela avulsa nova que o app usa
// pra resolver o Cloudflare (a mesma lógica de openCloudflareSolverWindow
// no main.js da v0.31.32): BrowserWindow de topo, show:true desde a
// criação, User-Agent limpo (sem "Electron"/"idle-huntera-manager"),
// Client Hints reescritos pra bater com o UA.
//
// Serve pra tirar a dúvida: se ISSO passar no Cloudflare mas o app
// instalado continuar falhando, o problema é o app instalado estar
// rodando código velho (build não pegou, ou instalador não atualizou de
// verdade) — não a lógica em si. Se ISSO também falhar, o problema é
// mais fundo (proxy, ou alguma diferença que ainda não achamos).
//
// Como rodar:
//   npx electron test-cloudflare-solver.js

const { app, BrowserWindow } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 1150,
        height: 820,
        center: true,
        show: true, // nasce já mostrada — igual a janela avulsa do app
        title: 'TESTE — janela avulsa (igual a v0.31.32 usa pra Cloudflare)',
        backgroundColor: '#0f0f14',
        webPreferences: {
            partition: 'persist:test-cloudflare-solver',
            contextIsolation: true,
            sandbox: true,
            spellcheck: false,
        },
    });

    const cleanUA = win.webContents.getUserAgent()
        .replace(/\s*idle-huntera-manager\/\S+/i, '')
        .replace(/\s*Electron\/\S+/i, '');
    win.webContents.setUserAgent(cleanUA);

    const chromeVersionMatch = cleanUA.match(/Chrome\/(\d+)/);
    const chromeMajor = chromeVersionMatch ? chromeVersionMatch[1] : '130';
    const platformLabel = process.platform === 'darwin' ? '"macOS"' : (process.platform === 'linux' ? '"Linux"' : '"Windows"');
    win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['sec-ch-ua'] = `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not.A/Brand";v="24"`;
        details.requestHeaders['sec-ch-ua-mobile'] = '?0';
        details.requestHeaders['sec-ch-ua-platform'] = platformLabel;
        callback({ requestHeaders: details.requestHeaders });
    });

    win.webContents.openDevTools({ mode: 'right' });
    win.webContents.loadURL(TEST_URL);

    win.webContents.once('did-finish-load', () => {
        console.log('>>> Carregou já 100% visível, sem nenhum truque de esconder antes. Testa criar conta / esqueci senha / o que costuma dar Cloudflare.');
    });
});

app.on('window-all-closed', () => app.quit());
