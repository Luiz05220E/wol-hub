// TESTE ISOLADO Nº3 — igual ao teste 2 (já com partition, que passou),
// agora adicionando o truque de posicionar a janela FORA da tela
// (coordenada negativa) ANTES de carregar a URL, só trazendo pra
// posição visível depois que a página termina de carregar — imitando
// o que o app real faz com a WebContentsView antes do primeiro load.
//
// Como rodar (igual das vezes passadas):
//   npx electron test-cloudflare-3.js
//
// O que isso prova:
//   - Se AGORA falhar -> confirma que o truque de carregar fora da
//     tela é o problema (o Cloudflare/Turnstile provavelmente checa
//     visibilidade/posição do widget no momento do load).
//   - Se passar normal -> esse suspeito também cai, e sobra sandbox
//     ou o preload como próximas hipóteses.

const { app, BrowserWindow } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const win = new BrowserWindow({
        // Nasce FORA da tela, em tamanho real — igual o app faz.
        x: -10000 - 1200,
        y: -10000,
        width: 1200,
        height: 800,
        show: false,
        title: 'TESTE 3 — partition + nasce fora da tela',
        webPreferences: {
            partition: 'persist:test-cloudflare-3',
        },
    });

    win.webContents.openDevTools({ mode: 'right' });
    win.loadURL(TEST_URL);

    win.webContents.on('did-finish-load', () => {
        console.log('>>> Carregou fora da tela. Trazendo pra posição visível agora...');
        // Só agora trazemos pra tela, depois do load — igual o app faz.
        win.setBounds({ x: 100, y: 100, width: 1200, height: 800 });
        win.show();
        console.log('>>> Testa criar conta / ver se o Cloudflare passa.');
    });
});

app.on('window-all-closed', () => app.quit());
