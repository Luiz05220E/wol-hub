// TESTE ISOLADO Nº11 — pergunta que ainda falta: a "mancha" de ter
// carregado escondida é PRA SEMPRE (a mesma aba nunca mais passa, mesmo
// depois de aparecer) ou é só NO MOMENTO daquele carregamento específico
// (se você der um novo loadURL DEPOIS de já estar visível, ganha uma
// chance nova e limpa)?
//
// Esse teste: BrowserWindow nasce ESCONDIDA (show:false) e carrega uma
// página EM BRANCO (não o Huntera) enquanto escondida — só isso, pra
// simular a "existência" da conta sem gastar nada. Depois de 5s, MOSTRA a
// janela (show + moveTop). Espera mais 2s pra garantir que ela já está
// visível e assentada. SÓ ENTÃO dá loadURL de verdade pro Huntera, já com
// a janela 100% visível.
//
// Como rodar:
//   npx electron test-cloudflare-11.js
//
// O que isso prova:
//   - Se passar -> ótima notícia: a solução é manter uma BrowserWindow de
//     topo por conta, escondida com página em branco enquanto em segundo
//     plano (gastando quase nada), e só carregar o jogo de verdade na
//     hora que voce troca pra aba dela (já visível). Bem mais barato que
//     manter tudo sempre carregado e visível.
//   - Se falhar -> a mancha é permanente por instância de janela; nesse
//     caso a solução vira "toda vez que reaproveitar uma janela que já
//     esteve escondida, teria que destruir e criar uma BrowserWindow NOVA
//     do zero, já visível, antes do loadURL real" — mais caro mas ainda
//     viável.

const path = require('path');
const { app, BrowserWindow } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'TESTE 11 — nasce escondida com página em branco, só carrega o jogo depois de aparecer',
        show: false,
        backgroundColor: '#0f0f14',
        webPreferences: {
            partition: 'persist:test-cloudflare-11',
            contextIsolation: true,
            sandbox: true,
            spellcheck: false,
            preload: path.join(__dirname, 'account-preload.js'),
        },
    });

    const cleanUA = win.webContents.getUserAgent()
        .replace(/\s*idle-huntera-manager\/\S+/i, '')
        .replace(/\s*Electron\/\S+/i, '');
    win.webContents.setUserAgent(cleanUA);

    // Carrega uma página em branco enquanto escondida — igual uma conta
    // "existindo" em segundo plano, sem carregar o jogo ainda.
    win.loadURL('data:text/html,<body style="background:#111"></body>');

    console.log('>>> Janela escondida com página em branco. Esperando 5s (simulando tempo em segundo plano)...');
    setTimeout(() => {
        console.log('>>> Mostrando a janela agora (ainda em branco)...');
        win.show();
        win.moveTop();
        win.focus();

        setTimeout(() => {
            console.log('>>> Já visível e assentada. Carregando o Huntera AGORA, com a janela já 100% visível...');
            win.webContents.loadURL(TEST_URL);
            win.webContents.openDevTools({ mode: 'right' });
            console.log('>>> Testa criar conta / ver se o Cloudflare passa.');
        }, 2000);
    }, 5000);
});

app.on('window-all-closed', () => app.quit());
