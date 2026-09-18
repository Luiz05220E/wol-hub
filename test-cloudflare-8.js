// TESTE ISOLADO Nº8 — testa a hipótese "o que quebra não é estar fora da
// tela, é nunca ter existido como janela de verdade (show:false)".
//
// Diferença pro teste 7: aqui a janela nasce com show:true DESDE O INÍCIO
// (existe de verdade pro Windows desde o primeiro instante), só que
// POSICIONADA FORA DA TELA (x bem negativo) — nunca escondida via
// show/hide. Depois de um tempo (simulando a conta ficando em segundo
// plano "existindo" mas fora de vista), ela é só MOVIDA pra posição
// visível com setPosition — nunca chama show() de novo, porque ela nunca
// foi escondida.
//
// Isso é o mais parecido que dá pra chegar do jeito que o Chrome trata
// abas em segundo plano: a janela do navegador nunca some de verdade, só
// o conteúdo fica "não-visível" um tempo.
//
// Como rodar:
//   npx electron test-cloudflare-8.js
//
// O que isso prova:
//   - Se passar -> confirmado, a solução pro app real é: cada conta vira
//     uma BrowserWindow de topo própria, criada com show:true e
//     posicionada fora da tela quando em segundo plano, movida (nunca
//     escondida/mostrada) quando você troca de aba.
//   - Se falhar -> nem isso basta; o problema é mais fundo (talvez
//     precise da janela realmente na área visível do monitor o tempo
//     todo, não só "existindo" fora da tela) — aí a reescrita precisa
//     manter TODAS as contas sempre sobrepostas na área visível, só uma
//     por cima da outra (z-order), o que é bem mais complexo.

const path = require('path');
const { app, BrowserWindow } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        x: -10000, // fora da tela desde a criação
        y: 100,
        title: 'TESTE 8 — janela de topo, nasce MOSTRADA (fora da tela)',
        show: true, // <- a diferença chave desse teste (era false no teste 7)
        backgroundColor: '#0f0f14',
        webPreferences: {
            partition: 'persist:test-cloudflare-8',
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

    win.webContents.loadURL(TEST_URL);

    win.webContents.once('did-finish-load', () => {
        console.log('>>> Carregou FORA DA TELA (mas já existindo/mostrada). Esperando 5s antes de mover...');
        setTimeout(() => {
            console.log('>>> Movendo pra posição visível agora (sem show/hide). Testa criar conta / ver se o Cloudflare passa.');
            win.setPosition(100, 100);
            win.moveTop();
            win.focus();
            win.webContents.openDevTools({ mode: 'right' });
        }, 5000);
    });
});

app.on('window-all-closed', () => app.quit());
