// TESTE ISOLADO Nº7 — a pergunta que ainda falta responder antes de
// decidir a solução: uma BrowserWindow de topo de verdade (não
// WebContentsView filha), só que NASCE ESCONDIDA (show: false) e só
// aparece depois (show() + moveTop()) — exatamente como o app real
// precisa se comportar pra manter várias contas em segundo plano ao
// mesmo tempo, com só uma visível por vez.
//
// O teste 6 provou: WebContentsView filha (mesmo que "visível" na tela)
// falha. Os testes 1-5 provaram: BrowserWindow de topo, JÁ VISÍVEL desde
// o início, passa. Mas nenhum testou uma janela de topo que fica
// ESCONDIDA por um tempo antes de aparecer — que é o caso real do app
// (contas em segundo plano).
//
// Como rodar:
//   npx electron test-cloudflare-7.js
//
// O que isso prova:
//   - Se passar -> a solução é trocar WebContentsView por uma
//     BrowserWindow própria por conta (frameless, posicionada em cima da
//     área de conteúdo, escondida quando não é a ativa). Dá pra
//     reescrever o app assim.
//   - Se falhar -> o problema não é "view filha vs janela de topo", é
//     "não estava com foco/visível desde o início" — aí a solução é
//     bem diferente (precisa investigar mais, provavelmente ligado ao
//     timing de quando o desafio é gerado vs quando a janela ganha
//     foco de verdade do SO).

const path = require('path');
const { app, BrowserWindow } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'TESTE 7 — janela de topo, nasce ESCONDIDA',
        show: false, // <- a diferença chave desse teste
        backgroundColor: '#0f0f14',
        webPreferences: {
            partition: 'persist:test-cloudflare-7',
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

    // Fica "escondida" por 5s de propósito (dando tempo da página
    // carregar toda escondida, igual uma conta em segundo plano faria),
    // só depois aparece — reproduzindo o momento de "trocar de aba".
    win.webContents.once('did-finish-load', () => {
        console.log('>>> Carregou ESCONDIDA. Esperando 5s antes de mostrar...');
        setTimeout(() => {
            console.log('>>> Mostrando agora. Testa criar conta / ver se o Cloudflare passa.');
            win.show();
            win.moveTop();
            win.webContents.openDevTools({ mode: 'right' });
        }, 5000);
    });
});

app.on('window-all-closed', () => app.quit());
