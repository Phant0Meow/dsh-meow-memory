# meow-memory 🐱📝

| [中文](README.md) | [English](README.en.md) | [Português (BR)](README.pt-br.md) | [MIT License](LICENSE) |
| :---: | :---: | :---: | :---: |

Memória entre sessões para o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Versão **0.31.0** ｜ Histórico: [CHANGELOG.md](CHANGELOG.md) ｜ Suporta **dsh 0.1.5**

## ✨ Recursos

- **Memória em sete níveis**: `soul` (a própria IA) / `user` (fatos e preferências do usuário) / `project` (informação de projeto, com `subcategory`) / `fact` (fato atômico) / `lesson` (o que se aprendeu e correções) / `topic` (assunto em andamento com frase-objetivo) / `rules` (princípios de design e diretrizes de comportamento). Uma tabela SQLite por nível, UUID com prefixo de tempo, a ordem dos ids é a ordem de criação.
- **Injeção da primeira rodada (bloco de memória de longo prazo)**: antes da primeira mensagem do usuário, injeta soul / user / princípios de design / guia de memória. A memória entra como uma mensagem plugin snapshot independente antes da mensagem real do usuário e **nunca reescreve o prompt dele**; **a primeira rodada não roda acertos por palavra-chave** (eles começam na segunda).
- **Acerto por palavra-chave a cada mensagem**: a partir da segunda mensagem do usuário, cada mensagem real busca fact/lesson/rules/topic (global + ancorado no projeto atual) e injeta os top-2 acertos. O acerto usa as **palavras-chave da entrada**, não o texto inteiro.
- **Ancoragem no projeto atual**: passar o parâmetro `project` ancora o projeto atual daquela sessão; sem ancoragem os acertos buscam só o global (conversa fiada do usuário não atrapalha).
- **Projetado para cache**: a section estática `meow-memory:guide` é registrada uma vez no system prompt — texto constante, então não quebra o cache KV do provider.
- **Reinjeção após compactação**: depois que a sessão é compactada, a rodada seguinte reinjeta automaticamente o snapshot de longo prazo + o panorama dos projetos consultados nesta sessão com `memory_project` + o texto das memórias que esta sessão escreveu/atualizou — a IA não perde a lembrança de repente.
- **Três coisas além dos níveis**: a escrita deduplica e faz merge automaticamente; o timestamp exibido é sempre o `updated_at`; informação global usa a marca global (distinto de deixar o campo vazio).
- **Dream por janela**: com a janela ociosa por ≥3 horas ela fica elegível, e o próprio agente principal dela consolida em rodadas (memórias atômicas / topic / resumo de projeto); a **supressão em horário de pico** (09:00–12:00 e 14:00–18:00 no `timeZone` configurado, padrão Asia/Shanghai — os picos de tarifa da API) impede o disparo. Digitar `/dream` consolida na hora, sob demanda.
- **Reflexão**: depois de ≥7 passos de ferramenta seguidos dentro de uma mesma tarefa, o plugin pergunta ao modelo se há algo que valha memorizar desde a última consolidação. Se a última ferramenta for `memory_*`, considera que já houve memorização ativa e não reflete de novo.
- **Portão de confiança de memória externa**: um `.dsh-meow` trazido pelo workspace que não foi criado nesta máquina (ex.: repositório externo clonado) fica pausado por padrão — um aviso na primeira rodada, e `/meow-trust` reativa na hora; bibliotecas criadas localmente e workspaces abertos antes do upgrade são confiados automaticamente, sem nenhum atrito no uso normal.
- **UI do cliente**: o texto injetado é recolhido em uma barra, as rodadas de reflexão/dream em um card expansível, e a lista de sessões mostra ícones de estado do dream (🌙 consolidado / lua em respiração em andamento / lua cinza com barra pulado).
- **Sem dependências de runtime instaladas separadamente**: `node:sqlite` + artefato esbuild (`lib/index.js`); o host DSH resolve os peers `schemastery` e `dsh-llm`. **Nenhum módulo nativo.**

## 📦 Instalação

### Instalação em um comando (recomendada)

```sh
dsh plugin --profile web add github:Phant0Meow/dsh-meow-memory
```

Um comando instala e já vale: a instalação compila automaticamente (o pacote traz o script `prepare`), monta sozinho, e depois de reiniciar o `dsh web` novas sessões carregam o plugin automaticamente.

> O pnpm ≥10 bloqueia por padrão scripts de build na instalação: o primeiro `add` pode falhar pedindo `allowBuilds`; siga a instrução, adicione as chaves mostradas no `pnpm-workspace.yaml` do profile e rode de novo.

#### Fork em PT-BR

```sh
dsh plugin --profile web add github:coutogilson/dsh-meow-memory
```

### Desinstalação

```sh
dsh plugin --profile web remove meow-memory
```

### Instalação manual (desenvolvedores, qualquer instalação do DSH, sem npm)

1. Copie (ou crie um link simbólico de) este pacote para o `node_modules` do profile:

   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/meow-memory ~/.dsh/profiles/web/node_modules/meow-memory
   ```

   (Windows: `New-Item -ItemType Junction ...` — junction NTFS, sem precisar de administrador.)

2. Adicione `meow-memory` ao `dsh.profile.bundles` do `package.json` do profile (como acima).

3. Reinicie o `dsh web`. Novas sessões carregam o plugin automaticamente.

## 🔌 Compatibilidade

Suporta **dsh 0.1.5** (incluindo o `0.1.5-rc.1` mais recente) e também versões antigas — atualizar o dsh não exige mudar este plugin nem nenhuma configuração.

O plugin não fixa número de versão: ele detecta as capacidades do host em runtime, então cada versão segue o ramo correto. Duas gerações já foram testadas de verdade: no `0.1.5-rc.1` a primeira injeção, as chamadas das ferramentas de memória e a renderização no cliente funcionam; no `0.1.1-rc.2` o comportamento é idêntico ao das versões anteriores.

## ⚙️ Configuração

Todos os campos são opcionais (patch do profile ou `cordis.patch.yml`). **Também dá para não editar arquivo nenhum**: a página de configurações do DSH tem a aba "Meow memory" deste plugin (no mesmo nível de "Geral" e "Modelos"), onde todos os itens abaixo são editáveis na interface, com gravação por campo e restauração individual do padrão (restaurar padrão = voltar ao padrão de fábrica do plugin, sem sofrer a base do patch); depois de salvar, vale após recarregar a quente/reiniciar o plugin meow-memory.

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true          # chave geral
    projectDir: '.dsh-meow' # diretório de memória (relativo ao workspace)
    promptLang: 'pt-br'    # ⚠️ configure explicitamente no primeiro uso (ver abaixo)
    hitTopK: 2             # máximo de entradas por acerto de palavra-chave a cada mensagem
    dream:
      enabled: true
      idleMinutes: 180      # janela ociosa por ≥180 minutos (3 horas) permite o dream
```

**Todos os campos, tipos e padrões estão em [docs/configuration-reference.md](docs/configuration-reference.md)**, incluindo `titleMax` / `autoMigrate` / `homeDir` / `disabledWorkspaces` / `backup` / `delegate`.

> ⚠️ **Configure o `promptLang` explicitamente no primeiro uso.** Ele decide o idioma do texto de injeção/reflexão/dream e das descrições das ferramentas, e também influencia o idioma em que o modelo escreve as entradas de memória — as palavras-chave são extraídas no idioma da entrada. O valor **é** o nome do subdiretório em `src/prompts/` e é casado **literalmente**: um nome que não existe (por exemplo `pt`) não gera erro nenhum — ele cai no pacote chinês, em silêncio. Veja [docs/configuration-reference.md](docs/configuration-reference.md).

### Idioma da interface

O texto da interface do plugin segue o "Configurações → Geral → Idioma" do DSH (embutidos: 中文 / English / Português (Brasil)) e é uma camada separada do `promptLang`; as duas não interferem. Veja [docs/configuration-reference.md](docs/configuration-reference.md).

## 🧠 Como funciona

```
Primeira mensagem ............ injeta o bloco de memória de longo prazo
(prefixo = snapshot       .... Sobre você (soul) / Sobre o usuário (user) /
 plugin, prompt do              Princípios de design (rules) / Guia de memória
 usuário intocado)              (a 1ª rodada NÃO faz acertos por palavra-chave)

Da 2ª mensagem em diante ..... "Memórias possivelmente relevantes, apenas para
                                referência:" + top-2 acertos por palavra-chave
                                (global + ancorado no projeto atual)
                                ids já vistos registrados por sessão
                                (sessions/<id>.json); sinal de compactação
                                libera os vistos

Janela ociosa ≥3h ............ dream por janela: 3 rodadas (a 3ª é o resumo de
e fora do pico                  projeto) sobre as memórias criadas + extraídas
                                nesta janela, congelando por updated_at no
                                timestamp da última conversa
```

Os rótulos acima são os do pacote de prompts em português; com `promptLang: 'zh'` eles aparecem em chinês e com `'en'` em inglês (por exemplo `===== LONG-TERM MEMORY =====`, `Possibly relevant memories, for reference only:`).

### Ferramentas

| Ferramenta | Para que serve |
|---|---|
| `memory_remember` | Escreve uma memória (content/project/keywords/importance obrigatórios; deduplica e faz merge) |
| `memory_search` | Busca por palavra-chave (BM25 × peso de recência; filtros level/project/status/days) |
| `memory_project` | Devolve o parágrafo de panorama de um projeto (**parâmetro `project` obrigatório**) |
| `memory_find_similar` | Checagem de duplicatas e conflitos |
| `memory_read` | Lê os metadados completos de uma entrada pelo id |
| `memory_update` | Corrige status / importance / goal / keywords |
| `memory_dream` | Dispara manualmente a consolidação desta janela |
| `memory_home` | Consulta / troca o diretório global de dados |

Há também o comando `/dream`: digite `/dream` no input para consolidar esta janela na hora, sem sofrer a supressão de pico.

**Parâmetros, retornos e efeitos colaterais estão em [docs/tool-reference.md](docs/tool-reference.md)** (incluindo o efeito de ancoragem do `memory_project` e os três marcadores de diretório do `memory_home`).

## 🛠 Desenvolvimento

```sh
npm install
npm run build          # empacota com esbuild → lib/index.js (peers do host externos)
npm run test           # 228 testes de lógica: db / bm25 / migrate / inject / reflect / dream / tools / apply
```

Os pacotes `@deepseek-ai/*` ficam no pnpm workspace do dsh-meow, não no `node_modules` deste pacote.
No Windows, `npm run link-workspace` (ou `scripts/link-workspace.ps1`) cria os junctions espelhando os
pacotes do workspace para o esbuild resolvê-los; o `build.mjs` os referencia via `nodePaths`.
O build não precisa do peer opcional `dsh-llm`. Para executar os testes diretamente
com Node, vincule `@deepseek-ai/dsh-llm` de um workspace DSH compatível; o loader do
profile DSH resolve esse peer durante o uso normal. Não o adicione novamente a
`devDependencies`: instalações `file:` / `link:` podem introduzir outra cópia de
um pacote central do host no profile (#84).

`node tests/build-host-peers.mjs` verifica o build limpo sem peers do host (#87).
`node tests/host-peers.mjs /path/to/node_modules/@deepseek-ai/dsh` usa uma instalação
oficial independente do DSH para verificar o carregamento real pelo host e os
contratos de mensagem em um profile isolado, sem chamadas a modelos.

## 📚 Documentação

| Para saber sobre | Leia |
| --- | --- |
| As sete ferramentas: parâmetros, retornos e efeitos colaterais | [docs/tool-reference.md](docs/tool-reference.md) |
| Todos os campos de configuração, tipos e padrões | [docs/configuration-reference.md](docs/configuration-reference.md) |
| Por que foi projetado assim (cache, acertos, dream, armadilhas) | [docs/design-notes.md](docs/design-notes.md) |
| Falha ao instalar, busca imprecisa, como ler os erros | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Histórico de versões | [CHANGELOG.md](CHANGELOG.md) |
| Adicionar um idioma de interface | [src/i18n/README.md](src/i18n/README.md) |
| Adicionar um pacote de prompts | [src/prompts/README.md](src/prompts/README.md) |

## 🙏 Agradecimentos

Obrigado a cada contribuidor que faz o meow-memory melhorar:

- **[daveycodez](https://github.com/daveycodez)** — pacote de prompts em inglês e tokenização do inglês ([PR #6](https://github.com/Phant0Meow/dsh-meow-memory/pull/6), lançado na v0.22.0)
- **[chenmzh](https://github.com/chenmzh)** — injeção de memória como mensagem plugin snapshot independente, resolvendo a poluição do título da sessão ([PR #10](https://github.com/Phant0Meow/dsh-meow-memory/pull/10))
- **[cuddly-guacamole](https://github.com/cuddly-guacamole)** — compatibilidade de Session events entre as duas versões do dsh 0.1.2-alpha.4 ([PR #11](https://github.com/Phant0Meow/dsh-meow-memory/pull/11))
- **[coutogilson](https://github.com/coutogilson)** — pacote de prompts em português do Brasil (`src/prompts/pt-br/`) e a camada de texto de UI que segue o locale do DSH

## 📄 License

MIT —— ver [LICENSE](LICENSE).
