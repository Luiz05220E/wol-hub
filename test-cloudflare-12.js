// TESTE ISOLADO Nº12 — o teste da "janela avulsa" falhou mesmo nascendo
// já 100% visível (igual os testes 1-5 que passaram). A diferença: esse
// aqui trocava o User-Agent e reescrevia os headers "Client Hints"
// (Sec-CH-UA) pra fingir ser Chrome comum. Isso muda os HEADERS HTTP, mas
// NÃO muda o que o JavaScript da própria página vê pela API
// navigator.userAgentData — ela continua revelando a identidade real do
// Electron por esse caminho. Essa inconsistência entre "o que os headers
// dizem" e "o que o JS vê" é um sinal clássico de bot detection.
//
// Esse teste é IDÊNTICO ao da janela avulsa, só que SEM nenhuma troca de
// User-Agent nem de Client Hints — usa o Electron exatamente do jeito que
// é (vai aparecer "Electron" no user-agent, sem disfarce nenhum).
//
// Como rodar:
//   npx electron test-cloudflare-12.js
//
// O que isso prova:
//   - Se passar -> confirmado, o problema nunca foi visibilidade nem
//     arquitetura — foi a troca de User-Agent/Client-Hints causando uma
//     inconsistência que o Cloudflare pega. A correção é parar de
//     disfarçar o Electron (ou disfarçar de um jeito completo, cobrindo
//     também o navigator.userAgentData via JS, não só os headers).
//   - Se falhar -> a troca de UA não era o problema (ou não é só isso);
//     sobra investigar mais.

const { app, BrowserWindow } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 1150,
        height: 820,
        center: true,
        show: true,
        title: 'TESTE 12 — janela avulsa SEM disfarçar User-Agent/Client Hints',
        backgroundColor: '#0f0f14',
        webPreferences: {
            partition: 'persist:test-cloudflare-12',
            contextIsolation: true,
            sandbox: true,
            spellcheck: false,
        },
    });

    // Propositalmente NENHUMA troca de User-Agent nem de headers aqui —
    // diferença chave desse teste.

    win.webContents.openDevTools({ mode: 'right' });
    win.webContents.loadURL(TEST_URL);

    win.webContents.once('did-finish-load', () => {
        console.log('>>> Carregou já 100% visível, User-Agent real do Electron (sem disfarce). Testa criar conta.');
    });
});

app.on('window-all-closed', () => app.quit());
