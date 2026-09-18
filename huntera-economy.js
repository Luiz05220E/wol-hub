// ==UserScript==
// @name         Huntera - LoWBOT
// @namespace    http://tampermonkey.net/
// @version      15.2
// @description  Modo economia + loot + detecção de cidade + som
// @author       você + Grok
// @match        *://huntera.com.br/*
// @match        *://*.huntera.com.br/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // v9.6: DEBUG desligado por padrão. Os logs de diagnóstico ficaram úteis
    // durante o desenvolvimento, mas rodando o tempo todo em produção (várias
    // abas, sessões longas) eles se acumulam no console do DevTools e pesam
    // na memória da extensão. Muda pra "true" só quando precisar debugar de novo.
    const DEBUG = false;
    function debugLog(...args) {
        if (DEBUG) console.log(...args);
    }

    let economyMode = false;
    let startTime = 0;
    let overlay = null;
    let timerInterval = null;
    let statsInterval = null; // v9.6: separado do timerInterval, roda mais devagar
    let originalRAF = null;
    let hiddenElements = [];
    let wasInCity = false;
    // v15.2: sempre começa DESLIGADO ao carregar a página, mesmo que
    // estivesse ativado antes — evita ficar tocando sem controle se o jogo
    // cair/reconectar e você não conseguir acessar o painel pra desativar
    // (o botão Keys fica dentro do Inventário, que pode não estar
    // acessível nesse momento). Ainda salva sua escolha se você ativar
    // manualmente na sessão, só não herda o "ligado" de antes.
    let cityAlertEnabled = false;
    let autoBlessEnabled = localStorage.getItem('huntera_auto_bless') !== 'false'; // padrão ligado
    let autoAcceptHuntEnabled = localStorage.getItem('huntera_auto_hunt_accept') !== 'false'; // padrão ligado
    let autoPartyEnabled = localStorage.getItem('huntera_auto_party') !== 'false'; // padrão ligado
    let autoLootEnabled = localStorage.getItem('huntera_auto_loot') !== 'false'; // padrão ligado

    // ========== AUTO-BLESS ==========
    // Clica sozinho no templo quando tem blessing disponível (funciona pra
    // qualquer blessing, não só os gratuitos), e
    // confirma "Abençoar tudo" no painel que abre. Roda sempre, independente
    // do modo economia estar ativo ou não.
    let blessingsCheckInterval = null;

    function tryAutoBless() {
        if (!autoBlessEnabled) return;
        const templeBtn = document.querySelector('button.hud-city-action.hud-temple.has-blessings');
        if (!templeBtn || templeBtn.hidden) return;

        templeBtn.click();
        setTimeout(() => {
            const buyAllBtn = document.getElementById('blessings-buy-all');
            if (buyAllBtn && !buyAllBtn.hidden) {
                buyAllBtn.click();
                debugLog('[Huntera] Blessings usados automaticamente');
            }
            // v15.3: fecha a aba de blessing sozinho depois de comprar — antes
            // ficava aberta na tela até você fechar na mão.
            setTimeout(() => {
                const closeBtn = document.getElementById('blessings-close');
                if (closeBtn) closeBtn.click();
            }, 400);
        }, 400); // v15.3: reduzido de 800ms — 400 já é suficiente pro painel renderizar o botão "Abençoar tudo"
    }

    function startAutoBless() {
        if (blessingsCheckInterval) return;
        tryAutoBless(); // roda uma vez de cara
        blessingsCheckInterval = setInterval(tryAutoBless, 10000);
    }

    // ========== AUTO-DESPACHAR LOOT ==========
    // Mesma lógica do botão "Despachar Loot" manual (do overlay do Modo
    // Economia), só que rodando sozinho.
    // v15.3: removida a "humanização" (atraso aleatório de até 1min) e a
    // detecção de transição cooldown->liberado. Aquilo tinha um bug: só
    // disparava a venda quando PEGAVA a mudança de estado ao vivo — se a
    // página carregasse/recarregasse já com o loot disponível (sem
    // cooldown ativo), a transição nunca acontecia e a conta ficava sem
    // vender nada até o próximo ciclo de cooldown completar. Era esse o
    // motivo de algumas contas (de 8) ficarem sem despachar sem erro
    // nenhum no console — não era bug, era essa lacuna na lógica. Agora é
    // simples e instantâneo: a cada checagem, se tiver loot disponível e
    // não tiver uma venda em andamento, vende na hora.
    let lootCheckInterval = null;
    let lootSelling = false;

    function isLootAvailable() {
        const btn = document.getElementById('nav-hunt-quick-sell');
        if (!btn) return false;
        return !btn.disabled && !btn.classList.contains('cooling');
    }

    function performLootSell() {
        lootSelling = true;
        const openBtn = document.getElementById('nav-hunt-quick-sell');
        if (!openBtn || openBtn.disabled || openBtn.classList.contains('cooling')) {
            lootSelling = false;
            return;
        }

        openBtn.click();
        setTimeout(() => {
            const confirmBtn = document.querySelector('button.quick-sell-confirm');
            if (confirmBtn) {
                confirmBtn.click();
                debugLog('[Huntera] Loot despachado automaticamente');
            }
            lootSelling = false;
        }, 700);
    }

    function tryAutoLoot() {
        if (!autoLootEnabled || lootSelling) return;
        if (isLootAvailable()) performLootSell();
    }

    function startAutoLoot() {
        if (lootCheckInterval) return;
        tryAutoLoot(); // roda uma vez de cara — já cobre o caso de já estar disponível ao carregar
        lootCheckInterval = setInterval(tryAutoLoot, 10000);
    }

    // ========== AUTO-ACEITAR CONVITE DE HUNT ==========
    // Observa a página por diálogos novos que apareçam (em vez de varrer a
    // página inteira toda hora) e clica sozinho no botão "Aceitar" quando
    // aparecer um. (v10.7: o jogo atualizou e trocou o texto de "Entrar"
    // pra "Aceitar".) Nota: o botão fornecido não tem classe/id próprios, só
    // o texto — então isso pode, em teoria, clicar em qualquer outro diálogo
    // novo que também use exatamente essa palavra. Se acontecer de clicar em
    // algo errado, me avisa que a gente refina o alvo.
    function watchForHuntInvite() {
        const inviteObserver = new MutationObserver((mutations) => {
            if (!autoAcceptHuntEnabled) return;
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue; // só elementos, ignora texto etc.

                    const candidates = [];
                    if (node.tagName === 'BUTTON') candidates.push(node);
                    if (node.querySelectorAll) candidates.push(...node.querySelectorAll('button'));

                    for (const btn of candidates) {
                        if (btn.textContent.trim() === 'Aceitar') {
                            btn.click();
                            debugLog('[Huntera] Convite de hunt aceito automaticamente');
                            return;
                        }
                    }
                }
            }
        });
        inviteObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ========== AUTO PT (aceitar convite de party + seguir o líder) ==========
    // Mesma técnica do auto-aceitar hunt: observa diálogos novos aparecendo
    // e clica sozinho. Aqui cobre os dois botões — "Entrar" (aceitar o
    // convite de party) e "Seguir o líder" (que aparece depois de entrar).
    // Mesmo aviso de antes: como não tem classe/id próprios, pode em teoria
    // clicar em outro diálogo que use exatamente esses textos.
    function watchForPartyInvite() {
        const partyObserver = new MutationObserver((mutations) => {
            if (!autoPartyEnabled) return;
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;

                    const candidates = [];
                    if (node.tagName === 'BUTTON') candidates.push(node);
                    if (node.querySelectorAll) candidates.push(...node.querySelectorAll('button'));

                    for (const btn of candidates) {
                        const text = btn.textContent.trim();
                        if (text === 'Entrar') {
                            btn.click();
                            debugLog('[Huntera] Convite de party aceito automaticamente');
                            return;
                        }
                        if (text === 'Seguir o líder') {
                            btn.click();
                            debugLog('[Huntera] Seguindo o líder automaticamente');
                            return;
                        }
                    }
                }
            }
        });
        partyObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ========== SOM SIMPLES ==========
    // v8.8: antes criava um AudioContext NOVO a cada som. Se o contexto
    // nascesse suspenso (autoplay policy), o resume() é assíncrono e o
    // oscilador podia terminar de "tocar" antes do contexto acordar de
    // verdade — resultado: nenhum som, sem erro nenhum no console.
    // Agora usamos um único contexto reutilizável e só agendamos o som
    // depois de confirmar que ele está "running".
    let cityAlarmInterval = null; // controla o beep repetido enquanto estiver na cidade
    let lastRawCityState = null;  // última leitura crua de isInCity(), pra debounce
    let cityStableCount = 0;      // quantas leituras seguidas bateram com lastRawCityState
    const CITY_STATE_STABILITY = 2; // precisa de 2 leituras iguais seguidas pra confiar na mudança
    const CITY_ALARM_INTERVAL_MS = 2000; // v9.1: intervalo entre beeps (pedido: 2s)

    // v9.1: som "Beep Once" enviado pelo usuário, embutido como base64 pra não
    // depender de arquivo externo/hospedagem. Tocado via elemento <audio> em
    // vez do oscilador sintetizado.
    const BEEP_SOUND_DATA_URI = 'data:audio/ogg;base64,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';
    let beepAudioEl = null;

    function getBeepAudioEl() {
        if (!beepAudioEl) {
            beepAudioEl = new Audio(BEEP_SOUND_DATA_URI);
            beepAudioEl.preload = 'auto';
        }
        return beepAudioEl;
    }

    function playNotificationSound() {
        try {
            const audio = getBeepAudioEl();
            audio.currentTime = 0; // permite tocar de novo mesmo se o anterior ainda não terminou
            audio.play().catch(err => {
                console.error('[Huntera] Falha ao tocar o beep:', err);
            });
        } catch (e) {
            console.error('[Huntera] Não foi possível tocar o som:', e);
        }
    }

    // v8.9: um beep único era fácil de perder, já que o modo economia
    // existe justamente pra você não ficar olhando a tela. Agora, ao
    // entrar na cidade, o som repete a cada 4s até você sair da cidade
    // (ou desligar o toggle "Som na cidade").
    function startCityAlarm() {
        if (cityAlarmInterval) return; // já está tocando, evita duplicar
        debugLog('[Huntera] Alarme da cidade iniciado');
        playNotificationSound(); // beep imediato
        cityAlarmInterval = setInterval(() => {
            if (!cityAlertEnabled) {
                stopCityAlarm();
                return;
            }
            debugLog('[Huntera] Beep repetido (tick do alarme)');
            playNotificationSound();
        }, CITY_ALARM_INTERVAL_MS);
    }

    function stopCityAlarm() {
        if (cityAlarmInterval) {
            debugLog('[Huntera] Alarme da cidade parado');
            clearInterval(cityAlarmInterval);
            cityAlarmInterval = null;
        }
    }

    // ========== BOTÃO DENTRO DO INVENTÁRIO (v14.0) ==========
    // Antes ficava na navbar, ao lado do "Loja" — agora mora dentro do
    // painel de Inventário, logo abaixo do "paperdoll" de equipamentos
    // (espaço que já existe vazio ali, antes da barra de Capacidade).
    // Reaproveita a classe .slot nativa do jogo pra nascer com a cara de
    // um slot de equipamento de verdade, sem precisar de CSS próprio.
    function createInventoryButton(paperdoll) {
        if (document.getElementById('he-inv-btn')) return;

        // v14.3: voltado pro visual EXATO de antes (nav-labeled nav-glow,
        // texto "Keys" + ícone, moldura dourada igual ao "Loja") — só o
        // LUGAR mudou (agora depois do paperdoll, não mais na navbar). Nada
        // no estilo foi alterado, a pedido.
        const btn = document.createElement('button');
        btn.id = 'he-inv-btn';
        btn.type = 'button';
        btn.className = 'nav-labeled nav-glow';
        btn.title = 'Huntera - LoWBOT';
        btn.setAttribute('aria-label', 'Huntera - LoWBOT');
        btn.style.width = 'auto';
        btn.style.minWidth = 'auto';
        btn.style.gap = '6px';
        btn.style.flexDirection = 'row-reverse';
        btn.style.margin = '0 auto';
        // v14.6: o container é flex e ignorava margin-top — troquei pra
        // transform, que desloca visualmente por cima do layout, sem o
        // flex conseguir "engolir" o ajuste.
        btn.style.transform = 'translate(6px, -20px)';

        btn.innerHTML = `
            <span aria-hidden="true" class="nav-chase"></span>
            <span aria-hidden="true" class="nav-glyph">
                <img src="data:image/png;base64,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" alt="" class="nav-glyph-art">
            </span>
            <span class="nav-label" style="position:static !important; opacity:1 !important; transform:none !important; background:none !important; padding:0 !important; border-radius:0 !important; margin-left:8px !important;">Keys</span>
        `;

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openSettingsModal();
        });

        // Insere logo depois do bloco de equipamentos (paperdoll), no
        // espaço vazio que já existe ali, antes da barra de Capacidade.
        paperdoll.insertAdjacentElement('afterend', btn);
    }

    // ========== MODAL DE CONFIGURAÇÕES (v9.9 — estilo inspirado no @LoWBots) ==========
    // Modal centralizado com "módulos" (título + descrição + switch + status),
    // igual ao painel do @LoWBots que você mandou. Todas as classes usam o
    // prefixo "he-" (Huntera Economia) pra nunca colidir com CSS do jogo.
    const MODAL_STYLE_ID = 'he-modal-style';

    function injectModalStyle() {
        if (document.getElementById(MODAL_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = MODAL_STYLE_ID;
        style.textContent = `
            /* v15.1: sombra de profundidade sempre presente + brilho dourado
               pulsando por cima (a nav-glow-pulse do jogo sozinha apagaria
               a sombra a cada ciclo, por isso essa versão própria). */
            @keyframes he-panel-glow-pulse {
                0%, 100% {
                    box-shadow: 0 12px 35px rgba(0, 0, 0, .733), 0 0 0 1px #e0af6814, 0 0 0 #e0af6800;
                    border-color: #8d6b3f;
                }
                50% {
                    box-shadow: 0 12px 35px rgba(0, 0, 0, .733), 0 0 0 1px #e0af6814, 0 0 10px #e0af6880;
                    border-color: #e0af68;
                }
            }

            #he-modal-overlay {
                position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
                background: transparent; z-index: 999999;
                /* v12.8: não bloqueia clique no jogo por baixo — só a janela
                   do modal (abaixo) volta a aceitar clique. Sem isso, o fundo
                   transparente ainda "capturava" clique na tela inteira e
                   fechava sozinho ao clicar em qualquer lugar do jogo. */
                pointer-events: none;
            }
            #he-modal-overlay.open { display: flex; }

            #he-modal-window {
                width: min(420px, calc(100vw - 36px));
                max-height: min(600px, calc(100vh - 36px));
                overflow: hidden; display: flex; flex-direction: column; color: #c8d0dc;
                position: relative;
                pointer-events: auto; /* reabilita clique só na janela, já que o overlay em volta não bloqueia mais */
                /* v12.2: cor de borda e sombra reais do .friends-window
                   (Computed) — a "borda grossa com relevo" que parecia
                   diferente era só o box-shadow forte, não border-image. */
                border: 1.53px solid #e0af68;
                border-radius: 6px;
                background: rgb(23, 25, 37);
                font-family: system-ui, -apple-system, sans-serif;
                /* v15.1: a animação nav-glow-pulse do jogo redefine o
                   box-shadow inteiro — se usássemos ela direto, a sombra de
                   profundidade do painel ia "piscar" a cada ciclo. Criamos
                   uma keyframe própria que mantém a sombra sempre e só
                   pulsa o brilho dourado por cima. */
                animation: he-panel-glow-pulse 3.2s ease-in-out infinite;
            }
            /* v12.3: decoração real de moldura, aplicada via ::after por cima
               da borda lisa — números exatos tirados do Computed do
               .friends-window real (border-image-slice:26, border 26px,
               var(--frame-window)). */
            #he-modal-window::after {
                content: "";
                position: absolute;
                inset: 0;
                pointer-events: none;
                border: 26px solid transparent;
                border-image: var(--frame-window, none) 26 stretch;
            }
            #he-modal-header {
                height: 50px; padding: 0 15px; display: flex; align-items: center; justify-content: space-between;
                border-bottom: 1px solid #3b4261; background: #24283b; flex-shrink: 0;
                /* v10.6: friso dourado sutil que faltava — regra real do
                   jogo aplicada em .hunt-window>header e vários outros. */
                border-top: 6px solid transparent;
                box-shadow: inset 0 -1px #e0af6838;
            }
            #he-modal-title { font-size: 14px; font-weight: 700; color: #e0af68; }
            #he-modal-subtitle { margin-top: 1px; font-size: 10px; color: #8b93a8; }
            #he-modal-close {
                width: 26px; height: 26px;
                position: relative;
                /* v13.3: valores reais — sem borda própria (border-style:none),
                   toda decoração vem do ::after. Fundo semitransparente e cor
                   de texto do jogo. */
                border: none;
                border-radius: 4px;
                background-color: rgba(36, 40, 59, .55);
                color: rgb(192, 202, 245); font-size: 16px; cursor: pointer;
            }
            #he-modal-close:hover { background-color: rgba(255,255,255,.08); color: #fff; }
            #he-modal-header-buttons { display: flex; gap: 6px; }
            /* v13.1: mesma decoração de canto do botão Fechar do rodapé,
               agora nos botões de minimizar/fechar do cabeçalho também. */
            #he-modal-close::after {
                content: "";
                position: absolute;
                inset: 0;
                pointer-events: none;
                /* v13.2: botões pequenos usam frame-icon-button.png (slice
                   11, borda ~7px), diferente do frame-button.png (slice 13,
                   borda 10px) usado no botão maior do rodapé. */
                border: 7px solid transparent;
                border-image: var(--frame-icon-button, none) 11 stretch;
            }

            #he-modal-content {
                flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px;
            }

            /* v12.1: barra de rodapé, igual ao padrão "Lista de amigos" —
               borda separando, texto à esquerda, botão à direita. */
            #he-modal-footer {
                display: flex; align-items: center; justify-content: space-between;
                padding: 10px 15px; border-top: 1px solid #e0af68; flex-shrink: 0;
                font-size: 11px; color: #8b93a8;
            }
            /* v15.0: badge dourada real, igual .store-badge do market do jogo */
            .he-badge {
                align-self: flex-start;
                padding: 2px 6px;
                border-radius: 3px;
                background: #3d3520;
                color: #e0af68;
                font-size: 10px;
                letter-spacing: .02em;
                font-weight: 600;
            }
            #he-modal-footer-btn {
                /* v12.9: valores reais tirados do Computed de um botão do
                   jogo — fundo azul-marinho, borda transparente, padding
                   generoso, transição suave. */
                position: relative;
                border: 1.53px solid transparent;
                border-radius: 4px;
                background-color: rgb(36, 40, 59);
                color: rgb(192, 202, 245);
                font-size: 13px;
                padding: 8px 13px;
                cursor: pointer;
                transition: background-color .2s ease, border-color .14s ease;
            }
            #he-modal-footer-btn:hover { background-color: #2a2d3d; }
            /* v13.0: decoração de canto — mesma regra .nav-labeled:after que
               já tínhamos descoberto pros botões da navbar (border-image
               var(--frame-button), slice 13, borda 10px). O Computed normal
               não mostra ::after, por isso parecia faltar. */
            #he-modal-footer-btn::after {
                content: "";
                position: absolute;
                inset: 0;
                pointer-events: none;
                border: 10px solid transparent;
                border-image: var(--frame-button, none) 13 stretch;
            }

            .he-module {
                padding: 10px 12px;
                border: 1px solid #4a4020;
                border-radius: 6px;
                background-color: #20222e;
            }
            .he-module-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
            .he-module-title { font-size: 13px; font-weight: 700; color: #e0af68; }
            .he-module-description { margin-top: 3px; font-size: 10.5px; line-height: 1.4; color: #8b93a8; }

            /* v12.7: checkbox nativo com accent-color, igual ao checkbox de
               loot do jogo (item "Cheese" que você mandou via Computed) —
               em vez do switch customizado com slider. */
            .he-module-checkbox {
                width: 16px; height: 16px;
                accent-color: #e0af68;
                cursor: pointer;
                flex-shrink: 0;
                margin-top: 2px;
            }
        `;
        document.head.appendChild(style);
    }

    function moduleHTML({ id, title, description, checked }) {
        return `
            <div class="he-module">
                <div class="he-module-row">
                    <div>
                        <div class="he-module-title">${title}</div>
                        <div class="he-module-description">${description}</div>
                    </div>
                    <input id="${id}" type="checkbox" class="he-module-checkbox" ${checked ? 'checked' : ''}>
                </div>
            </div>
        `;
    }

    let settingsModalCreated = false;

    function createSettingsModal() {
        if (settingsModalCreated) return;
        settingsModalCreated = true;
        injectModalStyle();

        const overlay = document.createElement('div');
        overlay.id = 'he-modal-overlay';
        overlay.innerHTML = `
            <div id="he-modal-window">
                <div id="he-modal-header">
                    <div>
                        <div id="he-modal-title">Huntera - LoWBOT</div>
                        <div id="he-modal-subtitle">Seu assistente no Huntera.</div>
                    </div>
                    <div id="he-modal-header-buttons">
                        <button id="he-modal-close" type="button" aria-label="Fechar">×</button>
                    </div>
                </div>
                <div id="he-modal-content">
                    ${moduleHTML({
                        id: 'he-mod-economy',
                        title: 'Modo Economia',
                        description: 'Congela a renderização do jogo pra economizar bateria/CPU.',
                        checked: economyMode,
                    })}
                    ${moduleHTML({
                        id: 'he-mod-sound',
                        title: 'Som quando vai pra cidade',
                        description: 'Toca um alarme repetido quando detecta que você voltou pra cidade — funciona mesmo sem o Modo Economia ativo.',
                        checked: cityAlertEnabled,
                    })}
                    ${moduleHTML({
                        id: 'he-mod-bless',
                        title: 'Auto-Bless',
                        description: 'Usa blessing sozinho quando disponível no templo.',
                        checked: autoBlessEnabled,
                    })}
                    ${moduleHTML({
                        id: 'he-mod-hunt-accept',
                        title: 'Auto-Aceitar Convite de Hunt',
                        description: 'Aceita sozinho quando o líder da party chama pra uma hunt.',
                        checked: autoAcceptHuntEnabled,
                    })}
                    ${moduleHTML({
                        id: 'he-mod-party',
                        title: 'Auto PT',
                        description: 'Aceita convite de party sozinho e já segue o líder automaticamente depois.',
                        checked: autoPartyEnabled,
                    })}
                    ${moduleHTML({
                        id: 'he-mod-loot',
                        title: 'Auto-Despachar Loot',
                        description: 'Vende o loot sozinho, com um atraso aleatório de até 1 min depois que o cooldown libera (evita vender no segundo exato).',
                        checked: autoLootEnabled,
                    })}
                </div>
                <div id="he-modal-footer">
                    <span class="he-badge">Huntera - LoWBOT</span>
                    <button id="he-modal-footer-btn" type="button">Fechar</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#he-modal-close').addEventListener('click', closeSettingsModal);
        overlay.querySelector('#he-modal-footer-btn').addEventListener('click', closeSettingsModal);
        // v15.0: removido o botão de minimizar, a pedido.
        // v12.8: removido o listener de "clicar fora fecha" — o overlay não
        // bloqueia mais clique fora do painel (pointer-events:none), então
        // esse clique nunca mais chegava até aqui mesmo. Fecha só pelo ×,
        // Fechar ou Esc agora.
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettingsModal(); });

        document.getElementById('he-mod-economy').addEventListener('change', (e) => {
            if (e.target.checked) {
                enterEconomyMode();
                closeSettingsModal(); // o overlay grande de economia já cobre a tela toda
            } else {
                location.reload(); // consistente com o jeito atual de sair do modo economia
            }
        });

        document.getElementById('he-mod-sound').addEventListener('change', (e) => {
            cityAlertEnabled = e.target.checked;
            localStorage.setItem('huntera_city_alert', cityAlertEnabled);
            if (!cityAlertEnabled) stopCityAlarm();
            refreshStandaloneWatch();
            syncOverlaySoundToggleUI(); // mantém o toggle do overlay grande sincronizado, se existir
        });

        document.getElementById('he-mod-bless').addEventListener('change', (e) => {
            autoBlessEnabled = e.target.checked;
            localStorage.setItem('huntera_auto_bless', autoBlessEnabled);
        });

        document.getElementById('he-mod-hunt-accept').addEventListener('change', (e) => {
            autoAcceptHuntEnabled = e.target.checked;
            localStorage.setItem('huntera_auto_hunt_accept', autoAcceptHuntEnabled);
        });

        document.getElementById('he-mod-party').addEventListener('change', (e) => {
            autoPartyEnabled = e.target.checked;
            localStorage.setItem('huntera_auto_party', autoPartyEnabled);
        });

        document.getElementById('he-mod-loot').addEventListener('change', (e) => {
            autoLootEnabled = e.target.checked;
            localStorage.setItem('huntera_auto_loot', autoLootEnabled);
        });
    }

    function openSettingsModal() {
        createSettingsModal();
        // Sincroniza com o estado real antes de mostrar — cobre o caso do
        // modo economia ter sido ativado via tecla B enquanto o modal
        // estava fechado.
        document.getElementById('he-mod-economy').checked = economyMode;
        document.getElementById('he-modal-overlay').classList.add('open');
    }

    function closeSettingsModal() {
        document.getElementById('he-modal-overlay')?.classList.remove('open');
    }

    // Mantém o toggle de som do overlay grande de economia sincronizado com
    // o módulo do modal, caso os dois existam ao mesmo tempo.
    function syncOverlaySoundToggleUI() {
        const overlayToggle = document.getElementById('he-city-alert-toggle');
        const sliderBg = document.getElementById('he-toggle-slider');
        const knob = document.getElementById('he-toggle-knob');
        if (overlayToggle) {
            overlayToggle.checked = cityAlertEnabled;
            if (sliderBg) sliderBg.style.background = cityAlertEnabled ? '#3d8b40' : '#555';
            if (knob) knob.style.left = cityAlertEnabled ? '19px' : '2px';
        }
    }

    // ========== OVERLAY ==========
    function createOverlay() {
        if (overlay) return;

        overlay = document.createElement('div');
        overlay.id = 'huntera-eco-overlay';
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            z-index: 999998;
            background: radial-gradient(ellipse at center, #1a1a22 0%, #0f0f14 60%, #08080c 100%);
            color: #d0d0d8;
            font-family: system-ui, -apple-system, sans-serif;
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            user-select: none;
        `;

        overlay.innerHTML = `
            <!-- Party -->
            <div style="position:absolute;top:16px;left:16px;background:linear-gradient(180deg,#252530 0%,#1a1a24 100%);border:1px solid #3a3a4a;border-radius:6px;padding:10px 14px;min-width:220px;max-width:260px;box-shadow:0 4px 12px rgba(0,0,0,0.6);">
                <div style="color:#8a8a9a;font-size:11px;font-weight:600;letter-spacing:0.8px;margin-bottom:8px;text-transform:uppercase;">Party</div>
                <div id="he-party-list" style="font-size:12.5px;"></div>
            </div>

            <!-- Toggle Aviso Cidade -->
            <div style="position:absolute;top:16px;right:16px;background:linear-gradient(180deg,#252530 0%,#1a1a24 100%);border:1px solid #3a3a4a;border-radius:6px;padding:8px 12px;font-size:12px;display:flex;align-items:center;gap:8px;">
                <span style="color:#aaa;">Som na cidade</span>
                <label style="position:relative;display:inline-block;width:36px;height:18px;cursor:pointer;">
                    <input type="checkbox" id="he-city-alert-toggle" style="opacity:0;width:0;height:0;" ${cityAlertEnabled ? 'checked' : ''}>
                    <span id="he-toggle-slider" style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${cityAlertEnabled ? '#3d8b40' : '#555'};border-radius:18px;transition:0.2s;"></span>
                    <span id="he-toggle-knob" style="position:absolute;content:'';height:14px;width:14px;left:${cityAlertEnabled ? '19px' : '2px'};bottom:2px;background:white;border-radius:50%;transition:0.2s;"></span>
                </label>
            </div>

            <!-- Centro -->
            <div style="text-align:center;max-width:420px;">
                <div style="font-size:28px;font-weight:700;letter-spacing:3px;color:#e8e8f0;margin-bottom:6px;">HUNTERA</div>
                <div style="font-size:14px;color:#9a9aaa;margin-bottom:16px;">Modo de economia de bateria</div>

                <!-- Status Localização -->
                <div id="he-location-status" style="
                    background: linear-gradient(180deg, #252530 0%, #1a1a24 100%);
                    border: 1px solid #3a3a4a;
                    border-radius: 6px;
                    padding: 8px 16px;
                    margin-bottom: 12px;
                    font-size: 13px;
                    display: inline-block;
                ">
                    Verificando...
                </div>

                <!-- Status do Despacho -->
                <div id="he-loot-status" style="
                    background: linear-gradient(180deg, #252530 0%, #1a1a24 100%);
                    border: 1px solid #3a3a4a;
                    border-radius: 6px;
                    padding: 8px 16px;
                    margin-bottom: 16px;
                    font-size: 13px;
                    color: #c0c0c8;
                    display: inline-block;
                ">
                    Verificando...
                </div>

                <br>

                <!-- Botão Despachar Loot -->
                <button id="he-sell-loot" style="
                    background: linear-gradient(180deg, #3a3a4a 0%, #2a2a35 100%);
                    border: 1px solid #5a5a6a;
                    color: #e0e0e8;
                    padding: 10px 22px;
                    border-radius: 6px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                    margin-bottom: 28px;
                    transition: all 0.15s;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
                ">
                    Despachar Loot
                </button>

                <div style="font-size:12.5px;color:#6a6a7a;margin-bottom:18px;line-height:1.5;">
                    Deslize a barra abaixo para sair do modo<br>economia de bateria
                </div>

                <div style="width:280px;margin:0 auto 24px;position:relative;">
                    <div style="height:6px;background:#2a2a35;border-radius:3px;border:1px solid #3a3a4a;overflow:hidden;">
                        <div id="he-slider-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#c9a227,#e8c547);border-radius:3px;"></div>
                    </div>
                    <input type="range" id="he-slider" min="0" max="100" value="0" style="position:absolute;top:-8px;left:0;width:100%;height:22px;opacity:0;cursor:pointer;margin:0;">
                    <div id="he-slider-thumb" style="position:absolute;top:-7px;left:0%;width:20px;height:20px;background:linear-gradient(180deg,#f0d060,#c9a227);border-radius:50%;box-shadow:0 0 10px rgba(201,162,39,0.5);pointer-events:none;transform:translateX(-10px);"></div>
                </div>
            </div>

            <!-- Stats -->
            <div style="position:absolute;bottom:28px;left:50%;transform:translateX(-50%);display:flex;gap:48px;background:linear-gradient(180deg,#252530 0%,#1a1a24 100%);border:1px solid #3a3a4a;border-radius:8px;padding:12px 28px;box-shadow:0 4px 16px rgba(0,0,0,0.6);">
                <div style="text-align:center;min-width:90px;">
                    <div style="color:#7a7a8a;font-size:10px;letter-spacing:0.6px;margin-bottom:4px;">TEMPO EM ECONOMIA</div>
                    <div id="he-timer" style="font-size:16px;font-weight:600;color:#e0e0e8;">00:00:00</div>
                </div>
                <div style="text-align:center;min-width:80px;">
                    <div style="color:#7a7a8a;font-size:10px;letter-spacing:0.6px;margin-bottom:4px;">XP/H</div>
                    <div id="he-xph" style="font-size:16px;font-weight:600;color:#e0e0e8;">—</div>
                </div>
                <div style="text-align:center;min-width:80px;">
                    <div style="color:#7a7a8a;font-size:10px;letter-spacing:0.6px;margin-bottom:4px;">LOOT/H</div>
                    <div id="he-looth" style="font-size:16px;font-weight:600;color:#e0e0e8;">—</div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Toggle do som
        const toggle = document.getElementById('he-city-alert-toggle');
        const sliderBg = document.getElementById('he-toggle-slider');
        const knob = document.getElementById('he-toggle-knob');

        toggle.addEventListener('change', () => {
            cityAlertEnabled = toggle.checked;
            localStorage.setItem('huntera_city_alert', cityAlertEnabled);
            sliderBg.style.background = cityAlertEnabled ? '#3d8b40' : '#555';
            knob.style.left = cityAlertEnabled ? '19px' : '2px';
            if (!cityAlertEnabled) {
                stopCityAlarm(); // desligou o som enquanto tocava, para na hora
            }
            refreshStandaloneWatch();
            const modalToggle = document.getElementById('he-mod-sound');
            if (modalToggle) {
                modalToggle.checked = cityAlertEnabled;
            }
        });

        // Slider sair
        const slider = document.getElementById('he-slider');
        const fill = document.getElementById('he-slider-fill');
        const thumb = document.getElementById('he-slider-thumb');

        slider.addEventListener('input', e => {
            const val = parseInt(e.target.value);
            fill.style.width = val + '%';
            thumb.style.left = val + '%';
            if (val >= 85) location.reload();
        });

        // Botão Despachar Loot
        document.getElementById('he-sell-loot').addEventListener('click', async () => {
            const btn = document.getElementById('he-sell-loot');
            btn.textContent = 'Despachando...';
            btn.disabled = true;

            try {
                const openBtn = document.getElementById('nav-hunt-quick-sell');
                if (!openBtn) throw new Error('Botão não encontrado');

                if (openBtn.disabled || openBtn.classList.contains('cooling')) {
                    btn.textContent = 'Em cooldown';
                    btn.style.borderColor = '#e53935';
                } else {
                    openBtn.click();
                    await new Promise(r => setTimeout(r, 700));

                    let confirmBtn = document.querySelector('button.quick-sell-confirm');
                    if (!confirmBtn) {
                        await new Promise(r => setTimeout(r, 500));
                        confirmBtn = document.querySelector('button.quick-sell-confirm');
                    }

                    if (confirmBtn) {
                        confirmBtn.click();
                        btn.textContent = 'Despachado!';
                        btn.style.borderColor = '#4caf50';
                    } else {
                        btn.textContent = 'Confirmação não encontrada';
                        btn.style.borderColor = '#e53935';
                    }
                }
            } catch (err) {
                console.error(err);
                btn.textContent = 'Erro ao despachar';
                btn.style.borderColor = '#e53935';
            }

            setTimeout(() => {
                btn.textContent = 'Despachar Loot';
                btn.style.borderColor = '#5a5a6a';
                btn.disabled = false;
            }, 2200);
        });
    }

    // ========== FREEZE ==========
    // v9.3: antes o canvas era REMOVIDO do DOM inteiro. Isso deixava o WebGL
    // vulnerável a perda de contexto em sessões longas em segundo plano (o
    // navegador libera a memória de GPU de elementos fora do DOM). Como o
    // requestAnimationFrame já está travado logo abaixo, o jogo não processa
    // frame nenhum de qualquer forma — não era necessário remover o canvas
    // fisicamente, só escondê-lo. Agora ele fica no lugar, só com display:none.
    function freezeGame() {
        if (!originalRAF) {
            originalRAF = window.requestAnimationFrame;
            window.requestAnimationFrame = () => 0;
        }

        hiddenElements = [];
        const selectors = ['#root', '#app', '#game', '[class*="Game"]', '[class*="pixi"]', 'canvas'];
        selectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
                if (el.closest('#huntera-eco-overlay') || el.id === 'he-inv-btn') return;
                if (hiddenElements.some(h => h.el === el)) return; // evita duplicar se um seletor pegar o mesmo elemento duas vezes
                hiddenElements.push({ el, display: el.style.display });
                el.style.display = 'none';
            });
        });
    }

    // ========== DETECÇÃO DE CIDADE ==========
    // v8.6: o botão "Depot" existe e é idêntico tanto na cidade quanto na hunt,
    // então nunca serviu como sinal confiável.
    // Trocado para o botão "Sair da caçada" (#nav-leave-hunt), que só existe
    // (e fica visível) durante a caçada — na cidade ele continua no DOM, mas
    // com hidden="" / aria-hidden="true" (confirmado via devtools).
    // v8.7: offsetParent falhou porque esse HUD usa position:fixed — e
    // elementos position:fixed SEMPRE retornam offsetParent === null,
    // estejam visíveis ou não. Por isso sempre "detectava cidade".
    // Corrigido lendo o atributo hidden/aria-hidden diretamente.
    function isInCity() {
        const leaveBtn = document.getElementById('nav-leave-hunt');
        if (!leaveBtn) return true; // não existe no DOM = cidade
        if (leaveBtn.hidden) return true; // atributo hidden presente = cidade
        if (leaveBtn.getAttribute('aria-hidden') === 'true') return true;
        return false; // visível = está na hunt
    }

    function updateLocationStatus() {
        const rawInCity = isInCity();

        // Debounce: só aceita a mudança de estado depois de N leituras seguidas
        // concordando entre si. Evita que uma oscilação isolada do DOM do jogo
        // (ex: o atributo hidden piscando por um instante) derrube o alarme
        // antes dele completar o primeiro ciclo.
        if (rawInCity === lastRawCityState) {
            cityStableCount++;
        } else {
            cityStableCount = 1;
            lastRawCityState = rawInCity;
        }
        const inCity = cityStableCount >= CITY_STATE_STABILITY ? rawInCity : wasInCity;

        // v9.7: o alarme roda independente do overlay grande existir — assim
        // dá pra usar só o "Som quando vai pra cidade" sem precisar ativar o
        // Modo Economia inteiro.
        if (inCity) {
            if (cityAlertEnabled) startCityAlarm();
        } else {
            stopCityAlarm();
        }
        wasInCity = inCity;

        // Atualiza o texto visual só se o overlay grande estiver montado
        const el = document.getElementById('he-location-status');
        if (el) {
            if (inCity) {
                el.textContent = '📍 Na cidade';
                el.style.color = '#4caf50';
                el.style.borderColor = '#4caf50';
            } else {
                el.textContent = '⚔️ Em caçada';
                el.style.color = '#ffb300';
                el.style.borderColor = '#3a3a4a';
            }
        }
    }

    // v9.7: mantém o alarme de cidade funcionando mesmo com o Modo Economia
    // desligado, sempre que "Som quando vai pra cidade" estiver ativado no
    // painel pequeno. Quando o Modo Economia completo está ativo, o próprio
    // timerInterval dele já cobre isso, então evitamos rodar os dois juntos.
    let standaloneWatchInterval = null;

    function refreshStandaloneWatch() {
        const shouldWatch = cityAlertEnabled && !economyMode;
        if (shouldWatch && !standaloneWatchInterval) {
            standaloneWatchInterval = setInterval(updateLocationStatus, 1000);
        } else if (!shouldWatch && standaloneWatchInterval) {
            clearInterval(standaloneWatchInterval);
            standaloneWatchInterval = null;
        }
    }

    // ========== ATUALIZAÇÕES ==========
    function updateParty() {
        const list = document.getElementById('he-party-list');
        if (!list) return;

        const members = document.querySelectorAll('.party-member');
        let html = '';

        members.forEach(member => {
            const nameEl = member.querySelector('.party-name');
            const levelEl = member.querySelector('.party-level');
            const healthBar = member.querySelector('.party-health i');
            if (!nameEl) return;

            const name = nameEl.textContent.trim();
            const level = levelEl ? levelEl.textContent.trim() : '';
            const hpPercent = healthBar ? healthBar.style.width : '100%';

            let color = '#4caf50';
            const hp = parseInt(hpPercent) || 100;
            if (hp < 40) color = '#e53935';
            else if (hp < 70) color = '#ffb300';

            html += `
                <div style="margin-bottom:7px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
                        <span style="color:#d0d0d8;"><span style="color:${color};margin-right:5px;">●</span>${name}</span>
                        <span style="color:#8a8a9a;font-size:11px;">${level}</span>
                    </div>
                    <div style="height:4px;background:#2a2a35;border-radius:2px;overflow:hidden;">
                        <div style="height:100%;width:${hpPercent};background:${color};border-radius:2px;"></div>
                    </div>
                </div>
            `;
        });

        list.innerHTML = html || '<div style="color:#666;font-size:12px;">Nenhum membro encontrado</div>';
    }

    function updateStats() {
        const xpEl = document.querySelector('b[data-mini="experience-hour"]');
        const xph = document.getElementById('he-xph');
        if (xph) xph.textContent = xpEl ? xpEl.textContent.trim() : '—';

        let goldText = '—';
        const goldEl = document.querySelector('b[data-mini="gold-hour"], b[data-mini="loot-hour"], b[data-mini="profit-hour"]');
        if (goldEl) {
            goldText = goldEl.textContent.trim();
        } else {
            document.querySelectorAll('b').forEach(b => {
                const parent = b.parentElement?.textContent || '';
                if (/LUCRO|GOLD|LOOT|ouro/i.test(parent)) goldText = b.textContent.trim();
            });
        }
        const looth = document.getElementById('he-looth');
        if (looth) looth.textContent = goldText;
    }

    function updateLootStatus() {
        const statusEl = document.getElementById('he-loot-status');
        const sellBtn = document.getElementById('he-sell-loot');
        if (!statusEl) return;

        const gameBtn = document.getElementById('nav-hunt-quick-sell');
        const label = gameBtn?.querySelector('.hud-hunt-quick-sell-label');

        if (!gameBtn || !label) {
            statusEl.textContent = 'Status indisponível';
            statusEl.style.color = '#888';
            return;
        }

        const text = label.textContent.trim();

        if (gameBtn.disabled || gameBtn.classList.contains('cooling')) {
            statusEl.textContent = text;
            statusEl.style.color = '#ffb300';
            if (sellBtn) {
                sellBtn.disabled = true;
                sellBtn.style.opacity = '0.6';
            }
        } else {
            statusEl.textContent = 'Loot pronto para despachar';
            statusEl.style.color = '#4caf50';
            if (sellBtn) {
                sellBtn.disabled = false;
                sellBtn.style.opacity = '1';
            }
        }
    }

    function updateTimer() {
        if (!economyMode) return;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
        const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
        const s = String(elapsed % 60).padStart(2, '0');
        const el = document.getElementById('he-timer');
        if (el) el.textContent = `${h}:${m}:${s}`;
    }

    // ========== CONTROLE ==========
    function enterEconomyMode() {
        if (economyMode) return;
        economyMode = true;
        refreshStandaloneWatch(); // já entrou no modo completo, desliga o watcher solo (redundante agora)
        startTime = Date.now();
        wasInCity = isInCity(); // evita tocar som logo ao entrar

        createOverlay();
        overlay.style.display = 'flex';

        const slider = document.getElementById('he-slider');
        const fill = document.getElementById('he-slider-fill');
        const thumb = document.getElementById('he-slider-thumb');
        if (slider) {
            slider.value = 0;
            fill.style.width = '0%';
            thumb.style.left = '0%';
        }

        freezeGame();
        updateParty();
        updateStats();
        updateLootStatus();
        updateLocationStatus();
        updateTimer();

        timerInterval = setInterval(() => {
            updateTimer();
            updateLocationStatus(); // barato: só olha 1 atributo de 1 elemento — mantém rápido pro alarme reagir logo
        }, 1000);

        // v9.6: updateParty/updateStats/updateLootStatus reconstroem HTML e
        // varrem vários elementos da página — mais pesado, e não precisa de
        // precisão de 1s já que ninguém tá olhando a tela no modo economia.
        // Rodando a cada 5s em vez de 1s, gera bem menos garbage collection.
        statsInterval = setInterval(() => {
            updateParty();
            updateStats();
            updateLootStatus();
        }, 5000);
    }

    function toggleEconomyMode() {
        if (economyMode) {
            location.reload();
        } else {
            enterEconomyMode();
        }
    }

    // Atalho B
    document.addEventListener('keydown', e => {
        if (e.key.toLowerCase() === 'b' && !e.ctrlKey && !e.altKey && !e.metaKey) {
            const tag = document.activeElement?.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
                toggleEconomyMode();
            }
        }
    });

    // v14.0: o botão saiu do #top-nav e agora mora dentro do painel de
    // Inventário (embaixo do "paperdoll" de equipamentos), a pedido. Como o
    // Inventário abre/fecha dinamicamente (o HTML pode ser recriado toda
    // vez), observamos o body inteiro e recriamos o botão sempre que o
    // paperdoll aparecer sem o nosso botão do lado.
    const observer = new MutationObserver(() => {
        const paperdoll = document.querySelector('.inventory-paperdoll');
        if (paperdoll && !document.getElementById('he-inv-btn')) {
            createInventoryButton(paperdoll);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    startAutoBless();
    startAutoLoot();
    watchForHuntInvite();
    watchForPartyInvite();

    // v15.0: corrige bug onde, depois de recarregar a página, o toggle
    // "Som quando vai pra cidade" aparecia ligado mas não funcionava de
    // verdade até você desativar/reativar manualmente. A causa: essa
    // função só era chamada dentro dos cliques dos toggles, nunca na
    // inicialização — então se cityAlertEnabled já vinha true do
    // localStorage, o intervalo de verificação nunca chegava a começar
    // sozinho. Chamando aqui, ele já nasce funcionando se estiver marcado.
    refreshStandaloneWatch();

    console.log('%c[Huntera] LoWBOT v15.2 carregado', 'color: #c9a227');
})();
