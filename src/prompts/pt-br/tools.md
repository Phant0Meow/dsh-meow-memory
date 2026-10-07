# textos das ferramentas do meow-memory (linhas chave-valor: `- key: value`; o primeiro dois-pontos ASCII + espaço é o separador, o valor é mantido literalmente; uma linha que começa com dois espaços continua o valor anterior. Os títulos `###` são apenas para leitura e são ignorados pelo parser.
# Convenção de chaves: <tool>.description / <tool>.param.<name> / <tool>.out.<path>. Uma chave ausente gera erro; chaves novas precisam ser espelhadas em src/tools.ts.)

### memory_remember

- memory_remember.description: Escreva algo que valha a pena lembrar entre sessões no armazenamento de memória deste workspace (SQLite, uma tabela por level). Obrigatórios: content / project ("global", ou um nome de projeto; separe vários por vírgula) / keywords (8 a 13 palavras-chave de recuperação) / importance. Omitir um deles gera um erro pedindo que você o preencha. Levels: soul=a própria IA (use com parcimônia); user=fatos básicos e preferências de base do usuário; project=um projeto (ex.: femwa/meow-memory/meow-eyes/dsh); rules=princípios de design / diretrizes de comportamento (uma regra global usa project "global" e, com importance>=2, é injetada por completo no primeiro turno; uma regra específica de projeto usa o nome desse projeto e é injetada com memory_project; todo o resto aparece pela busca); fact=fatos atômicos pequenos (uma frase simples, <=30 palavras); lesson=o que você aprendeu, sua própria experiência (tudo em que você foi corrigido entra aqui); topic=um assunto (dê a ele uma frase de objetivo; recuperado por palavras-chave). Regra rígida: quando o usuário explica o pensamento de design de um projeto, o framework ou o raciocínio por trás de uma decisão, o content deve preservar as palavras do próprio usuário — não parafraseie nem resuma isso. Entradas que se sobrepõem muito a uma existente são mescladas automaticamente (atualizadas, não duplicadas). A ferramenta confirma em caso de sucesso — não é preciso chamá-la de novo.
- memory_remember.param.content: O que lembrar; fact/lesson uma frase <=30 palavras; topic <=180 palavras; onde as palavras do próprio usuário estiverem envolvidas, mantenha a redação dele.
- memory_remember.param.level: Nível de memória, padrão fact.
- memory_remember.param.project: Obrigatório. Nome do projeto (deve ser um nome concreto de projeto quando level=project); use "global" para informações aplicáveis globalmente; separe vários projetos por vírgula, ex.: "dsh,femwa".
- memory_remember.param.subcategory: subcategoria de project: overview=propósito e resumo / structure=arquitetura / decisions=decisões técnicas / quotes=as palavras do próprio usuário / ops=implantação e dados / todo=em andamento.
- memory_remember.param.goal: A frase de objetivo do topic (recomendada quando level=topic, ex.: "fazer a integração do femGen funcionar").
- memory_remember.param.importance: Importância (qualquer número, sem limite superior; orientação suave 1-4: 4=linha vermelha fatal / saúde e segurança, 3=enfatizado pelo usuário / aplicável globalmente, 2=uma decisão do usuário ou uma conclusão abstrata, 1=trivialidade).
- memory_remember.param.corrected: Se isto é algo que o usuário corrigiu (para level=lesson).
- memory_remember.param.keywords: Palavras-chave que você escolhe (as rodadas de reflection/dream pedem de 8 a 13 palavras de conteúdo; omita e elas são extraídas automaticamente).
- memory_remember.out.keywords: As palavras-chave realmente armazenadas (extraídas automaticamente; após uma mesclagem, o valor mais recente).
- memory_remember.out.project: O projeto realmente registrado (se houver).

### memory_search

- memory_search.description: Pesquisa no armazenamento de memória deste workspace (BM25 x peso de recência). query é obrigatória e não pode ficar vazia — passe as palavras-chave ou a frase que você procura, ex.: memory_search({query: "implantação do plugin de memória"}); para navegar um projeto inteiro use memory_project (não precisa de query), não chame esta ferramenta com query vazia. O que volta (decisão do usuário): top 10 padrão = as 5 primeiras direto do ranking de relevância (nada excluído, incluindo entradas já injetadas/pesquisadas/criadas nesta sessão) + 5 mais tiradas de mais abaixo no ranking, pulando entradas já injetadas/já pesquisadas (assim você recebe material novo). Escopo padrão = fact+lesson+topic+rules; level aceita uma lista separada por vírgulas (ex.: fact,lesson); passe level=project para a visão do projeto inteiro. Os resultados são pegos por top-k de relevância e depois reordenados pelo timestamp da memória (antigo -> novo), para você ver como as coisas evoluíram e qual de duas entradas conflitantes é mais nova.
- memory_search.param.query: Palavras-chave ou frase de busca (obrigatória, não pode ficar vazia; ex.: "implantação do plugin de memória").
- memory_search.param.level: Restringe a levels, separados por vírgula: fact/lesson/topic/rules/project/soul/user (padrão fact,lesson,topic,rules).
- memory_search.param.project: Filtra por nome de projeto (separados por vírgula, semântica OR, ex.: "dsh,femwa"; entradas "global" e sem rótulo são sempre incluídas).
- memory_search.param.status: Filtra por status (separados por vírgula: active/archived/stale/all; padrão active, em que um todo stale conta como concluído e ainda participa; incluir all = sem filtro).
- memory_search.param.days: Apenas entradas criadas nos últimos N dias (por tempo de criação).
- memory_search.param.k: Número máximo de resultados.
- memory_search.param.content_max: Trunca o content de cada entrada neste comprimento, 0=texto completo.
- memory_search.out.note: Nota de conflito.
- memory_search.out.hits.id: id completo da memória (passe-o para memory_read/memory_update/memory_find_similar).
- memory_search.out.hits.keywords: As palavras-chave da entrada (extraídas por um LLM ou automaticamente).
- memory_search.out.hits.project: Projeto ao qual a entrada pertence; ""=sem rótulo; entradas aplicáveis globalmente mostram "global".
- memory_search.out.hits.updated_at: Timestamp da memória (última atualização, em milissegundos).

### memory_find_similar

- memory_find_similar.description: Encontra entradas semelhantes a um dado id de memória (cosseno sobre vetores de frequência de termos) — para detectar duplicatas, encontrar conflitos e verificar se já existe algo próximo desta entrada. Como a busca, ela olha apenas memórias criadas em outras sessões; tudo que já foi visto nesta sessão (injetado ou pesquisado) é excluído automaticamente.
- memory_find_similar.param.id: O id de memória de referência (o id completo dos resultados de memory_read/search, ou seus 12 primeiros caracteres).
- memory_find_similar.param.k: Número de resultados.
- memory_find_similar.param.content_max: Trunca o content de cada entrada neste comprimento, 0=texto completo.
- memory_find_similar.out.hits.similarity: Similaridade de cosseno 0-1; quanto maior, mais próxima.

### memory_read

- memory_read.description: Lê uma memória por completo (incluindo os metadados title/keywords/importance/status).
- memory_read.param.id: id da memória (do bloco de injeção ou de um resultado de memory_search).

### memory_update

- memory_update.description: Atualiza uma memória (content / importance / status / project / frase de objetivo do topic / keywords, ...). Valores de status: active / stale (finalizado: um todo concluído, um topic que atingiu seu objetivo -> stale significa done) / archived (excluído: entradas desatualizadas, inválidas, duplicadas ou substituídas).
- memory_update.param.id: id da memória.
- memory_update.param.content: Novo content (ao reescrever um topic: causa, percurso, desenvolvimento, resultado, <=180 palavras).
- memory_update.param.status: Novo status.
- memory_update.param.importance: Nova importância (qualquer número, sem limite superior; orientação suave 1-4: 4=linha vermelha fatal / saúde e segurança, 3=enfatizado pelo usuário / aplicável globalmente, 2=uma decisão do usuário ou uma conclusão abstrata, 1=trivialidade).
- memory_update.param.goal: Nova frase de objetivo (topic).
- memory_update.param.project: Novo nome de projeto (project/fact/lesson/rules/topic); use "global" para informações aplicáveis globalmente; separe vários projetos por vírgula; uma string vazia limpa o campo (sem rótulo).
- memory_update.param.keywords: Palavras-chave que você escolhe (corrija-as ou amplie-as sempre que notar que estão erradas; omitir o parâmetro ou passar um array vazio deixa as palavras-chave intactas).

### memory_project

- memory_project.description: Recupera do armazenamento de memória o bloco de injeção completo de um projeto (texto puro, agrupado por subcategoria, todas as entradas que não estão desatualizadas de uma vez). project é obrigatório: qual projeto você quer ver? Chamar sem ele gera um erro, então defina o nome do projeto primeiro. Chame-a quando o usuário mencionar um projeto (femwa/meow-memory/meow-eyes/dsh, ...) e perguntar sobre seu histórico de design, decisões técnicas, suas próprias palavras passadas ou onde ele está; também sempre que você precisar do panorama do projeto antes de responder. Regras: dentro de um grupo, as entradas vão de antigas -> novas pelo timestamp da memória; a subcategoria todo imprime "Concluído:" (as 5 concluídas mais recentemente) seguido de "Lista de tarefas:"; cada entrada traz seu id completo, seu timestamp de última atualização e seu texto.
- memory_project.param.project: Nome do projeto (o guia de memória no início da sessão lista todos os projetos que o usuário tem — escolha a partir dele).
- memory_project.out.text: O bloco de memória do projeto, agrupado por subcategoria (texto puro).

### memory_dream

- memory_dream.description: Agenda agora mesmo uma consolidação de memória (dream) para esta janela: tudo que esta janela criou ou trouxe à tona é enviado ao agente principal rodada a rodada para ser arrumado e guardado (rodada 1 = memórias atômicas, project/fact/lesson/rules/soul/user; rodada 2 = memórias de topic; rodada 3 = resumo de projeto, acrescentado apenas quando esta janela realmente mexeu com um projeto). Ela dispara automaticamente após 3+ horas de ociosidade da janela (suprimida nos horários de pico, 09:00-12:00 e 14:00-18:00 no horário de Pequim, mais os 15 minutos antes de cada um); esta ferramenta é o gatilho manual.

### memory_home

- memory_home.description: Visualiza ou troca o diretório global de dados do meow-memory (onde ficam dados em nível de instância, como logs e o ledger da janela de dream; o armazenamento de memória em si fica dentro de cada projeto e não é afetado). Chame sem parâmetros para obter o diretório atual e os locais reais dos três presets; a troca move automaticamente o conteúdo do diretório antigo (mover no mesmo disco / copiar entre discos). Após uma cópia entre discos, o diretório antigo é mantido, não excluído — lembre o usuário de apagá-lo manualmente depois de verificar; se várias instâncias do dsh compartilharem um mesmo diretório, lembre o usuário de atualizá-las em conjunto. Chame isto quando o usuário quiser mover os dados de memória ou os logs para fora do disco do sistema ou para outro local.
- memory_home.param.target: Local de destino. Ou um marcador de preset: default = home do usuário do sistema (o padrão), dsh-storage = pasta meow-memory dentro das storages da home do DSH, plugin-root = pasta de storage ao lado do próprio plugin; ou um caminho absoluto. Omita para visualizar o estado atual sem alterar nada.
- memory_home.out.note: Resultado da visualização/troca: o diretório atual ou o novo, quantos arquivos foram movidos e o que fazer com o diretório antigo.
