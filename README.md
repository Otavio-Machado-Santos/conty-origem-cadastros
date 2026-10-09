# Origem do cadastro no app

API e biblioteca para atribuir um cadastro a campanha, indicação ou comunidade sem usar `Referer`. O primeiro app open fixa a janela; a decisão do cadastro fica persistida e todos os toques continuam auditáveis.

## Executar

Requer **Node.js 22** (`.nvmrc`). Sem dependências externas.

```sh
npm ci
npm test
npm start
```

A API e a demonstração abrem em `http://127.0.0.1:3006`. Na página, **Executar fluxo real da API** faz requisições reais: campanha → indicação → cadastro → toque tardio → auditoria. Cada execução usa IDs novos. `npm run demo` executa uma sequência HTTP com relógio controlado e verifica o resultado; a saída está em [`docs/evidence/http.txt`](docs/evidence/http.txt).

`PORT` altera a porta; `ATTRIBUTION_WINDOW_MS` altera a janela **somente para novas instalações**; `ATTRIBUTION_STORE` altera o arquivo de persistência. Defaults: `3006`, `604800000` (7 × 24 horas) e `data/attribution.json`. O servidor escuta apenas no loopback.

## Contrato do link e primeira abertura

O link carrega um identificador de origem registrado no servidor. O tipo e o criador/campanha são imutáveis; a query não pode trocar esses dados.

- Campanha: `conty://open?link_id=campanha-verao`
- Indicação: `conty://open?link_id=indicacao-criador42`

O aplicativo extrai `link_id` do deep link ou de um payload de deferred deep link. Antes de enviar, mantém no armazenamento do app um `installationId` estável e um `clickId` único por abertura intencional de link. Uma retentativa de transporte reutiliza o **mesmo** `clickId`; outro clique intencional recebe outro ID. Nenhuma etapa depende de referrer do webview.

A primeira chamada `POST /installations/:id/open` grava, atomicamente, `firstOpenedAt`, `windowEndsAt` e o toque opcional. Uma abertura orgânica também grava a âncora. Reaberturas nunca reiniciam a janela. O endpoint `/touches` exige que essa abertura já exista. Na API, horário é o da primeira abertura **aceita pelo servidor**; timestamps enviados pelo cliente são rejeitados. Reconstrução de aberturas offline e integração real de deep links não fazem parte desta demonstração.

## Regra de atribuição

1. A janela é `[firstOpenedAt, firstOpenedAt + 7 dias]`, inclusiva, em instantes UTC. Não é uma regra de dia civil: não há ambiguidade de fuso ou horário de verão.
2. O cadastro e o toque precisam ocorrer dentro dessa janela. Um cadastro depois do limite é orgânico com `attribution_window_expired`, mesmo que um toque anterior tenha sido válido.
3. Vence o **último toque elegível**. Empates no milissegundo usam o menor `clickId` em ordem ASCII; a ordem de chegada e o tipo da origem não dão prioridade. O teste registra o mesmo empate nas duas ordens.
4. O cadastro é consumido uma vez. Repetir seu `signupId` devolve a decisão armazenada; trocar o ID ou reutilizá-lo em outra instalação causa `409`.
5. Toques após o cadastro são guardados, mas nunca alteram a origem. Isso vale até quando o relógio retorna exatamente o mesmo milissegundo: o registro guarda `recordedAfterSignup`.
6. `clickId` é globalmente único. Repetição com instalação e link iguais devolve `duplicate: true`, sem novo toque ou timestamp. Mesmo ID com payload diferente causa `409`.

Cadastros sem toque recebem `{ "type": "organic", "reason": "no_touch" }`. O motivo é gravado junto do cadastro, inclusive para organicidade por expiração; não é inferido a cada leitura.

## API

Todas as escritas usam `Content-Type: application/json`. IDs aceitam 1–120 caracteres ASCII (`A–Z`, `a–z`, números, `_`, `-`). Campos desconhecidos são rejeitados; portanto `firstOpenedAt`, `touchedAt`, `registeredAt`, `occurredAt` e `referrer` não podem falsificar a janela.

| Método e rota | Corpo | Resultado |
| --- | --- | --- |
| `POST /links` | `{ "id", "type", "sourceId" }` | Link imutável e URL; `type` é `campaign`, `referral` ou `community` |
| `POST /installations/:id/open` | `{}` ou `{ "clickId", "linkId" }` | Primeira abertura ou reabertura; toque opcional; `duplicate` |
| `POST /installations/:id/touches` | `{ "clickId", "linkId" }` | Toque e `duplicate`; exige primeira abertura |
| `POST /installations/:id/signup` | `{ "signupId" }` | Origem armazenada e auditoria completa |
| `GET /installations/:id` | — | Âncora, toques e cadastro persistidos |
| `GET /signups/:signupId` | — | Decisão e todos os toques, incluindo os posteriores |

Exemplo executável, sem referrer:

```sh
curl -sS http://127.0.0.1:3006/links -H 'Content-Type: application/json' \
  -d '{"id":"campanha-verao","type":"campaign","sourceId":"verao2026"}'
curl -sS http://127.0.0.1:3006/links -H 'Content-Type: application/json' \
  -d '{"id":"indicacao-criador42","type":"referral","sourceId":"criador42"}'
curl -sS http://127.0.0.1:3006/installations/app-1/open -H 'Content-Type: application/json' \
  -d '{"clickId":"click-campanha","linkId":"campanha-verao"}'
curl -sS http://127.0.0.1:3006/installations/app-1/touches -H 'Content-Type: application/json' \
  -d '{"clickId":"click-indicacao","linkId":"indicacao-criador42"}'
curl -sS http://127.0.0.1:3006/installations/app-1/signup -H 'Content-Type: application/json' \
  -d '{"signupId":"creator-1"}'
curl -sS http://127.0.0.1:3006/signups/creator-1
```

Trecho da resposta real de `npm run demo` (os campos completos estão no log):

```json
{
  "signupId": "creator-1",
  "installationId": "app-1",
  "registeredAt": "2026-06-03T12:00:00.000Z",
  "firstOpenedAt": "2026-06-01T12:00:00.000Z",
  "windowEndsAt": "2026-06-08T12:00:00.000Z",
  "origin": {
    "type": "referral",
    "sourceId": "criador42",
    "linkId": "indicacao-criador42",
    "clickId": "click-indicacao",
    "touchedAt": "2026-06-02T12:00:00.000Z",
    "reason": "last_eligible_touch"
  }
}
```

Cada objeto de `touches` informa `clickId`, `linkId`, `touchedAt`, `recordedAfterSignup`, `type`, `sourceId`, `won` e `reason`. Motivos possíveis:

| Motivo | Explicação |
| --- | --- |
| `winner` | Toque consumido no cadastro |
| `superseded_by_more_recent_touch` | Outro toque elegível é mais recente |
| `tie_lost_to_click_id` | Mesmo horário, outro ID venceu o desempate |
| `outside_attribution_window` | Toque recebido depois do fim da janela |
| `signup_outside_attribution_window` | Toque dentro da janela, mas cadastro depois dela |
| `after_signup` | Toque recebido depois da decisão; inclusive empate de milissegundo |

Erro tem a forma `{ "error": { "code": "click_conflict", "message": "..." } }`. Entradas inválidas: `400`; recurso inexistente: `404`; conflito: `409`; corpo acima de 16 KiB: `413`; mídia diferente de JSON: `415`. Relógio inválido ou regressão gera `503` sem mudança de estado.

## Biblioteca, persistência e limites

[`src/attribution.js`](src/attribution.js) contém a regra sem HTTP; `clock`, `store` e `windowMs` são injetáveis. A biblioteca usa `MemoryStore` por padrão. A API usa [`FileStore`](src/storage.js): escreve um snapshot temporário e renomeia atomicamente, com arquivo `0600`. O estado em memória só avança depois de salvar. Reiniciar conserva a primeira abertura, a deduplicação e o vencedor; arquivo corrompido falha explicitamente em vez de apagar a atribuição. Não há tokens ou dados pessoais necessários; os exemplos usam IDs fictícios.

O snapshot atende a uma API em **um processo**. Não coordena múltiplos escritores, não oferece transações distribuídas nem garante `fsync` contra perda de energia; produção pede banco com unicidade de `clickId`/`signupId`, transações, autenticação e associação do installationId à identidade. A API local é uma demonstração de domínio, sem autenticação. IDs devem ser gerados e preservados pelo app confiável; um cliente malicioso capaz de inventar cliques precisa controles adicionais de antiabuso. O clock autoritativo evita backdating, mas não reconstrói cronologia offline.

## Validação e uso de IA

`npm test` cobre regra last-touch, empate em ambas as ordens, primeiro open orgânico, deduplicação e conflitos, limites exatos da janela, reabertura, cadastro expirado, cadastro imutável, toque tardio no mesmo milissegundo, fontes campaign/referral/community, entrada inválida, clock regressivo, reinício, falha de gravação e HTTP real (incluindo corpos chunked acima do limite). O log do Node 22 está em [`docs/evidence/test.txt`](docs/evidence/test.txt).

Codex produziu código, testes e documentação. Dois agentes Codex independentes do implementador revisaram o commit `3566be13b595e0b9480840d6aab6045db7cef39c` e liberaram a entrega após testes e sondagens próprias. Os pareceres completos estão em `docs/reviews/`. O coordenador conferiu a instalação e os testes em checkout isolado e registrou o fluxo HTTP real. Não foi realizada revisão humana do código. A validação usa dados sintéticos e ambiente local; limites e interpretações do contrato estão documentados.

[Verificação final, revisões independentes e captura do fluxo real](docs/verificacao-final.md).
