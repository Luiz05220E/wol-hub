// TESTE ISOLADO — não faz parte do app, é só pra diagnosticar o Cloudflare.
//
// Como rodar:
//   1. Copia esse arquivo pra dentro da pasta idle-huntera-manager/
//      (precisa ficar ao lado do node_modules pra achar o electron)
//   2. No terminal, dentro da pasta: npx electron test-cloudflare.js
//   3. Uma janela BEM simples vai abrir na URL do jogo.
//   4. Tenta passar no desafio do Cloudflare (clicando, se aparecer).
//
// O que isso prova:
//   - Se aqui o desafio PASSA normal -> o problema não é o Electron/rede
//     em si, é algo na configuração da WebContentsView do app de verdade
//     (sandbox, partition, preload, etc). Ótima notícia, mais fácil de
//     resolver.
//   - Se aqui TAMBÉM não passa, do mesmo jeito que no app -> confirma
//     que é fingerprint de rede do Electron (TLS/JA3/QUIC), e aí sim
//     vale a pena investir em flags de linha de comando ou aceitar que
//     vai precisar resolver o desafio manualmente uma vez por conta.

const { app, BrowserWindow } = require('electron');

// >>> Troca aqui pela URL real que você usa (ou deixa o padrão) <<<
const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'TESTE Cloudflare — janela crua, sem nada customizado',
        webPreferences: {
            // De propósito: SEM partition, SEM sandbox custom, SEM
            // preload, SEM contextIsolation forçado — a config mais
            // "padrão" possível do Electron, pra isolar a variável.
        },
    });

    win.webContents.openDevTools({ mode: 'right' });
    win.loadURL(TEST_URL);

    win.webContents.on('did-finish-load', () => {
        console.log('>>> Página carregou. Se tiver desafio Cloudflare, tenta resolver manualmente na janela.');
    });
});

app.on('window-all-closed', () => app.quit());
