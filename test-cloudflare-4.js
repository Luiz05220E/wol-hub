// TESTE ISOLADO Nº4 — acumula tudo que já foi testado e passou
// (partition + nascer fora da tela) e agora soma sandbox:true +
// contextIsolation:true, que é como as WebContentsView reais rodam.
// Ainda SEM preload nessa etapa.
//
// Como rodar:
//   npx electron test-cloudflare-4.js
//
// O que isso prova:
//   - Se falhar agora -> sandbox/contextIsolation é o problema.
//   - Se passar -> esses dois também caem, e sobra só o preload
//     (account-preload.js) como suspeito final.

const { app, BrowserWindow } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const win = new BrowserWindow({
        x: -10000 - 1200,
        y: -10000,
        width: 1200,
        height: 800,
        show: false,
        title: 'TESTE 4 — partition + fora da tela + sandbox/contextIsolation',
        webPreferences: {
            partition: 'persist:test-cloudflare-4',
            sandbox: true,
            contextIsolation: true,
        },
    });

    win.webContents.openDevTools({ mode: 'right' });
    win.loadURL(TEST_URL);

    win.webContents.on('did-finish-load', () => {
        console.log('>>> Carregou fora da tela. Trazendo pra posição visível agora...');
        win.setBounds({ x: 100, y: 100, width: 1200, height: 800 });
        win.show();
        console.log('>>> Testa criar conta / ver se o Cloudflare passa.');
    });
});

app.on('window-all-closed', () => app.quit());
