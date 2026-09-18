// TESTE ISOLADO Nº5 — acumula tudo que já foi testado e passou
// (partition + nascer fora da tela + sandbox/contextIsolation) e
// agora soma o ÚLTIMO suspeito que falta: o preload real do app,
// account-preload.js (que expõe window.wolhubBridge).
//
// Esse arquivo usa o account-preload.js que já está na mesma pasta
// do projeto — não precisa copiar nada, só rodar dali.
//
// Como rodar:
//   npx electron test-cloudflare-5.js
//
// O que isso prova:
//   - Se falhar agora -> confirma que é o preload/account-preload.js
//     (provavelmente algo que ele expõe ou o jeito que expõe via
//     contextBridge) que quebra o Cloudflare.
//   - Se passar -> nenhum dos suspeitos isolados é o problema, e o
//     bug só aparece na COMBINAÇÃO completa com o resto do
//     main.js real (algo tipo timing, o jeito que a view é anexada
//     ao contentView da BrowserWindow em vez de ser a window em si,
//     ou o "loadUrlReliably"). Nesse caso o próximo passo é recriar
//     o teste usando WebContentsView de verdade (igual o app faz),
//     não uma BrowserWindow simples.

const path = require('path');
const { app, BrowserWindow } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const win = new BrowserWindow({
        x: -10000 - 1200,
        y: -10000,
        width: 1200,
        height: 800,
        show: false,
        title: 'TESTE 5 — tudo junto + preload real',
        webPreferences: {
            partition: 'persist:test-cloudflare-5',
            sandbox: true,
            contextIsolation: true,
            preload: path.join(__dirname, 'account-preload.js'), // <-- preload real do app
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
