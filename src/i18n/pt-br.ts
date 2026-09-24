/**
 * meow-memory — pacote de texto de interface em português do Brasil.
 *
 * Mesmo conjunto de chaves do en.ts (fonte da verdade em keys.ts); o serviço de
 * locale do DSH cai para o inglês em qualquer chave ausente, então este pacote
 * pode ser completado aos poucos sem quebrar a UI. `{name}` é preenchido por t().
 *
 * Escopo: este dicionário é o texto de interface (UI/UX) do plugin. O texto
 * injetado no modelo (guia de injeção, prompts de reflection/dream, descrições
 * de ferramentas) é outra camada — ver src/prompts/<lang>/ e promptLang.
 */
import type { UiKey } from './keys.js'

export const ptBr: Record<UiKey, string> = {
  // ── barras das rodadas de reflection / dream ──────────────────────────────
  'fold.title.reflect': 'Reflexão de memória',
  'fold.title.dream': 'Consolidação ociosa de memória (dream)',
  'fold.status.running': '{title} em andamento…',
  'fold.hint.running': ' (mensagem entra nesta rodada)',
  'fold.status.interrupted': '{title} interrompida',
  'fold.status.remembered': '{title} · {n} memórias adicionadas',
  'fold.status.updated': '{title} · {n} atualizadas',
  'fold.status.nothing': '{title} · nada a guardar',

  // ── barras de injeção de memória ──────────────────────────────────────────
  'inject.bar': 'Memória injetada',
  'inject.kind.first': ' (longo prazo)',
  'inject.kind.hit': ' (acertos por palavra-chave)',
  'inject.expand': 'Clique para expandir',
  'inject.collapse': 'Clique para recolher',
  'inject.copy': 'Copiar',
  'inject.copied': 'Copiado',
  'inject.result': '[Resultado]',

  // ── bolhas de marcação do delegate ────────────────────────────────────────
  'notice.reflect.running': '▸ Tarefa de reflexão de memória em andamento…',
  'notice.reflect.done': '▸ Tarefa de reflexão de memória concluída.',
  'notice.dream.running': '▸ Tarefa de consolidação ociosa de memória em andamento…',
  'notice.dream.done': '▸ Tarefa de consolidação ociosa de memória concluída.',
  'notice.dream.interrupted': '▸ Tarefa de consolidação ociosa de memória interrompida; nova tentativa automática em breve.',

  // ── menu da sessão ────────────────────────────────────────────────────────
  'menu.skipDream': 'Pular a consolidação de memória (dream)',
  'menu.unskipDream': 'Voltar a fazer a consolidação de memória (dream)',

  // ── aba de configurações ──────────────────────────────────────────────────
  'settings.title': 'Meow memory',
  'settings.summary':
    'Todas as configurações do plugin de memória entre sessões. As mudanças ficam nas configurações do DSH (campo a campo; "Restaurar padrão" volta ao padrão de fábrica do plugin e ignora a base do patch); para valer, é preciso recarregar a quente ou reiniciar o plugin meow-memory.',
  'settings.loading': 'Carregando a configuração do meow-memory…',
  'settings.unavailable': 'Esta conexão não permite gravar configurações (só conexões locais de loopback podem editar).',
  'settings.readonly': 'Esta conexão é somente leitura (gravar configurações é limitado a conexões locais de loopback).',
  'settings.saved': 'Salvo ✓ passa a valer após recarregar a quente ou reiniciar o plugin meow-memory',
  'settings.badge.override': 'Alterado',
  'settings.badge.default': 'Padrão',
  'settings.reset': 'Restaurar padrão',
  'settings.saveFailed': 'Falha ao salvar: {error}',
  'settings.saveNotApplied': 'A gravação não teve efeito: o servidor recusou a escrita (talvez não tenha passado na validação). Exibindo de novo o valor atual do servidor.',
  'settings.resetFailed': 'Falha ao restaurar o padrão: {error}',
  'settings.resetNotApplied': 'Restaurar o padrão não teve efeito; tente de novo.',
  'settings.suppress.format': 'O intervalo deve ter o formato "HH:MM-HH:MM"; recebido "{value}"',
  'settings.suppress.atLeastOne': 'É necessário pelo menos um intervalo',
  'settings.group.base': 'Básico',
  'settings.group.inject': 'Injeção e acertos',
  'settings.group.reflect': 'Reflexão',
  'settings.group.delegate': 'Modelo das tarefas de consolidação',
  'settings.group.dream': 'Consolidação ociosa (dream)',
  'settings.group.language': 'Idioma',
  'settings.group.storage': 'Diretórios e migração',
  'settings.field.enabled.label': 'Chave geral',
  'settings.field.enabled.hint': 'Desligado, a injeção, a reflexão e as ferramentas de memória ficam todas inativas',
  'settings.field.projectDir.label': 'Diretório de memória',
  'settings.field.projectDir.hint': 'Diretório de dados, relativo ao workspace',
  'settings.field.homeDir.label': 'Diretório global de dados',
  'settings.field.homeDir.hint': 'Onde residem os dados de nível de instância (logs, índice de janelas). Ao alterar, o conteúdo do diretório antigo é migrado automaticamente (movimentação no mesmo disco / cópia entre discos); na cópia entre discos o diretório antigo é mantido — exclua-o manualmente após verificar. Se várias instâncias do dsh compartilham o mesmo diretório, atualize-as juntas.',
  'settings.field.homeDir.preset.default': 'Pasta pessoal do usuário (padrão)',
  'settings.field.homeDir.preset.dshStorage': 'Armazenamento da raiz do DSH',
  'settings.field.homeDir.preset.pluginRoot': 'Pasta do plugin',
  'settings.field.homeDir.preset.custom': 'Caminho personalizado',
  'settings.mirrorReadonly': 'Conexão não local: o dsh serve esta página como espelho somente leitura e nenhuma alteração será salva. Abra o dsh via 127.0.0.1 na máquina host para editar as configurações.',
  'settings.field.autoMigrate.label': 'Migrar banco antigo automaticamente',
  'settings.field.autoMigrate.hint': 'Migra o PROJECT.md automaticamente na primeira vez que um banco v1 é aberto',
  'settings.field.hitTopK.label': 'Máximo de acertos por mensagem',
  'settings.field.hitTopK.hint': 'Limite de entradas por acerto de palavra-chave injetadas a cada mensagem (fact/lesson/rules/topic)',
  'settings.field.titleMax.label': 'Comprimento de corte do título',
  'settings.field.titleMax.hint': 'Comprimento (em caracteres) do corte da lista de projetos no guia de memória',
  'settings.field.reflect.label': 'Reflexão automática',
  'settings.field.reflect.hint': 'Revisa a memória automaticamente quando a tarefa termina',
  'settings.field.reflectTurns.label': 'Rodadas para disparar a reflexão',
  'settings.field.reflectTurns.hint': 'Passos de ferramenta seguidos dentro de uma tarefa para disparar no fim',
  'settings.field.delegateModel.label': 'Trocar o modelo de reflexão/consolidação ociosa',
  'settings.field.delegateModel.hint':
    "Vazio = modelo principal do começo ao fim. Preenchido, as rodadas de reflexão e de consolidação ociosa passam a usar esse modelo e voltam ao principal no fim da rodada (o resto da conversa não muda); 'provider/model' escolhe a rota, 'model' troca só o nome do modelo",
  'settings.field.delegateModel.placeholder': 'ex.: zai-coding-cn/glm-5.3-flash',
  'settings.field.dreamEnabled.label': 'Ligar a consolidação ociosa',
  'settings.field.dream.idleMinutes.label': 'Minutos de ociosidade',
  'settings.field.dream.idleMinutes.hint': 'Uma janela ociosa por esses minutos já permite um dream',
  'settings.field.dream.suppressWindows.label': 'Janelas de supressão em horário de pico',
  'settings.field.dream.suppressWindows.hint': '"HH:MM-HH:MM" separados por vírgula; dentro dessas janelas nenhum dream é disparado',
  'settings.field.dream.suppressLeadMinutes.label': 'Supressão extra antes do pico (minutos)',
  'settings.field.dream.checkMinutes.label': 'Intervalo de verificação (minutos)',
  'settings.field.dream.timeZone.label': 'Fuso das janelas de supressão',
  'settings.field.dream.timeZone.hint': 'As janelas de pico são calculadas neste fuso fixo (independente do relógio do sistema)',
  'settings.field.dream.rulesReviewDays.label': 'Dias anti-churn das regras',
  'settings.field.dream.rulesReviewDays.hint': 'Regras estáveis com updated_at mais antigo que esses dias ficam fora da 1ª rodada do dream; 0 = sem filtro',
  'settings.field.promptLang.label': 'Idioma dos prompts e da busca',
  'settings.field.promptLang.hint':
    "Vazio = zh por padrão (sessões que nunca configuraram recebem um guia de primeira vez); 'en' = pacote inglês embutido. O idioma da interface não tem relação — ele segue a configuração de idioma do DSH. O idioma precisa ser o mesmo em que você fala, senão a taxa de acerto das palavras-chave cai",
  'settings.field.promptLang.placeholder': 'zh / en',

  // ── data e hora ───────────────────────────────────────────────────────────
  'datetime.ymd': '{d}/{m}',
  'datetime.ymdFull': '{d}/{m}/{y}',
}
